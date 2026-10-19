import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Store, LocalError, isAlive, publicError } from './store.mjs';
import { Channel, classify } from './channel.mjs';
import { ingest, readiness, markBlocked, clearAuthFlag, receiverRunning, FRESH_MS } from './session.mjs';
import { parseCommand, HELP, statusText, PENDING_TASK_REPLY } from './commands.mjs';
import { enqueue, flushOutbox } from './outbox.mjs';
import { findCodex, runCodex } from './codex.mjs';
import { hydrateMedia, mediaPrompt } from './media.mjs';
import { toast } from './toast.mjs';

const HEARTBEAT_MS = 10_000;
const EXIT_GRACE_MS = 8_000;
const TOAST_COOLDOWN_MS = 10 * 60_000;
const HISTORY_KEEP = 20;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...args) => console.error(new Date().toISOString(), ...args);

// Codes where the server answered "not now" — the item was NOT delivered, queue it.
const QUEUE_CODES = new Set(['SESSION_REQUIRED', 'SESSION_EXPIRED', 'RATE_LIMITED', 'HTTP_ERROR', 'AUTH_EXPIRED']);

/**
 * One direct send with the message's own context_token; certain rejections fall back
 * to the outbox (never dropped), uncertain outcomes are reported but not retried
 * blindly — a duplicate reply is worse than a missing one.
 */
async function sendOrQueue(store, channel, { to, id, text, item, format = 'text' }) {
  try {
    await channel.sendText(to, text, item?.context_token ?? null, { runId: item?.run_id });
    return { sent: true };
  } catch (e) {
    const err = classify(e);
    if (QUEUE_CODES.has(err.code)) {
      await enqueue(store, { notification_id: id, message: text, format }).catch(() => {});
      return { queued: true, error: err.code };
    }
    if (err.uncertain === true) return { unknown: true, error: err.code };
    throw err;
  }
}

export function makeLocalRunner(store) {
  return async (channel, state, item, cmd) => {
    const to = state.account.userId;
    const reply = (id, text) => sendOrQueue(store, channel, { to, id, text, item });
    switch (cmd.type) {
      case 'ping': return reply(`reply:${item.id}`, `PONG\n\n${new Date().toLocaleString('zh-CN')}`);
      case 'help': return reply(`reply:${item.id}`, HELP);
      case 'status': return reply(`reply:${item.id}`, statusText(state));
      default: return reply(`reply:${item.id}`, PENDING_TASK_REPLY);
    }
  };
}

/** Toast (throttled) telling the user exactly how to unlock a stuck queue. */
async function queueToastNotice(store, pending) {
  const s = await store.read();
  const lastToast = Math.max(s.account?.queueToastAt || 0, s.receiver?.queueToastAt || 0);
  if (Date.now() - lastToast < TOAST_COOLDOWN_MS) return;
  const reason = s.receiver?.queueReason || '微信窗口未开启或发送受限';
  toast('微信 · 消息待发', `${pending} 条消息排队中。${reason}。`);
  await store.update(st => {
    if (st.account) st.account.queueToastAt = Date.now();
    if (st.receiver) st.receiver.queueToastAt = Date.now();
  }).catch(() => {});
}

/** Human-readable task label from the prompt: first line, trimmed to 24 chars. */
export function taskName(prompt) {
  const line = String(prompt || '').split('\n').map(l => l.trim()).find(Boolean) || '';
  const cleaned = line.replace(/^(?:新任务|\/new)\s*/i, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '未命名任务';
  return cleaned.length > 24 ? cleaned.slice(0, 24) + '…' : cleaned;
}

function resultMessage(result, no, name) {
  const heads = {
    completed: '✅ Codex 任务完成',
    failed: '❌ Codex 任务失败',
    timed_out: '⏰ Codex 任务超时',
    stopped: '🛑 Codex 任务已停止',
    interrupted: '⚠️ Codex 任务中断',
  };
  const label = no ? ` · #${no} ${name}` : '';
  const title = (heads[result.status] || 'Codex 任务结束') + label;
  const body = (result.finalMessage || '').trim() || `(没有文本输出,状态: ${result.status})`;
  const footer = no ? `\n\n—— 任务 #${no} ${name}` : '';
  return { title, message: body + footer };
}

export async function worker({
  store = new Store(),
  channel = new Channel(),
  runner = null,
  codexRunner = runCodex,   // injection point for tests
  stopSignal = null,        // promise-based stop, for tests
} = {}) {
  const run = runner || makeLocalRunner(store);
  let release;
  try {
    // refreshMs keeps the lock file mtime fresh — the stale-lock rule in store
    // (alive pid + old mtime = Windows pid reuse) must never fire on a live worker.
    release = await store.lock('worker', 0, { refreshMs: 15_000 });
  } catch (e) {
    if (e.code === 'BUSY') return { status: 'already_running' };
    throw e;
  }

  let exiting = false;
  let exitResolve;
  const exitSignal = new Promise(resolve => { exitResolve = resolve; });
  const idle = ms => Promise.race([sleep(ms), exitSignal]); // shutdown-aware sleep
  const nonce = randomUUID();
  const onSignal = () => { exiting = true; exitResolve(); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  if (stopSignal) Promise.resolve(stopSignal).then(() => onSignal()).catch(() => {});
  // Crash-proofing: an unhandled rejection must not silently kill the bridge;
  // a hard crash exits non-zero so the supervisor respawns us.
  process.on('unhandledRejection', reason => {
    log('unhandledRejection:', reason?.code || reason?.message || String(reason));
  });
  process.on('uncaughtException', e => {
    log('uncaughtException:', publicError(e).code, e?.message);
    process.exit(1);
  });

  let active = null;       // { child, stop, done } of the running codex exec
  let taskPromise = null;

  try {
    const initial = await store.read();
    if (!initial.account?.token || initial.account.authExpired) {
      return { status: 'login_required' };
    }

    // Take over receiver state; preserve thread/job continuity across restarts.
    await store.update(s => {
      const prev = s.receiver || {};
      s.receiver = {
        enabled: true, pid: process.pid, nonce, heartbeat: Date.now(), startedAt: Date.now(),
        threadId: prev.threadId, job: prev.job,
      };
      if (s.receiver.job?.status === 'running') {
        s.receiver.job.status = 'interrupted';
        const t = (s.tasks || []).find(t => t.id === s.receiver.job.id);
        if (t) t.status = 'interrupted';
      }
    });
    channel.setSession({ token: initial.account.token, baseUrl: initial.account.base });
    channel.restoreContextToken(initial.account.userId, initial.account.contextToken);

    try { await channel.presence(true); }
    catch (e) { log('presence(true) failed:', publicError(e).code); }

    const beat = setInterval(() => {
      store.update(s => {
        if (s.receiver?.nonce !== nonce) return;
        s.receiver.heartbeat = Date.now();
      }).then(() => store.read()).then(s => {
        if (s.receiver?.nonce !== nonce || s.receiver?.enabled === false) { exiting = true; exitResolve(); }
      }).catch(() => {});
    }, HEARTBEAT_MS);
    beat.unref();

    const runLoop = async (name, fn) => {
      let backoff = 2_000;
      while (!exiting) {
        try {
          await fn();
          backoff = 2_000;
        } catch (e) {
          log(`${name} error:`, publicError(e).code, e?.message);
          await store.update(s => { s.receiver ||= {}; s.receiver.lastError = publicError(e).code; }).catch(() => {});
        }
        if (!exiting) await idle(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    };

    // ① Poll loop — the handler only ingests; it never executes tasks.
    const monitorFn = async () => {
      const account = (await store.read()).account;
      await channel.client.monitor(
        async message => { await store.update(s => ingest(s, { msgs: [message] })); },
        {
          initial_buf: account.cursor || '',
          on_buf_update: buf => { store.update(s => { if (s.account) s.account.cursor = buf; }).catch(() => {}); },
          on_response: () => {
            // a successful poll proves the token is valid → heal a false "re-login required"
            store.read().then(s => {
              if (s.account?.authExpired) store.update(clearAuthFlag).catch(() => {});
            }).catch(() => {});
          },
          on_error: err => { log('monitor:', err?.message); },
          on_session_expired: () => { log('session expired (-14): cooling down 60 min'); store.update(s => markBlocked(s)).catch(() => {}); },
          should_continue: () => !exiting,
        },
      );
    };

    // ② Consume loop — records a short history ring, then runs the command.
    const consumeFn = async () => {
      while (!exiting) {
        const item = await store.update(s => (s.inbox || []).shift());
        if (!item) { await idle(300); continue; }
        if (Date.now() - item.at > FRESH_MS) continue;
        // Download media here (consume loop), never in the poll handler.
        if (item.media?.length) { try { await hydrateMedia(channel, store, item); } catch { /* keep going */ } }
        // Keep a 20-entry history ring so wechat_read_messages can see inbound traffic.
        await store.update(s => {
          s.messages ||= [];
          s.messages.push({ at: item.at, ...(item.text ? { text: item.text } : {}),
            ...(item.media?.length ? { media: item.media.map(m => ({ kind: m.kind, ...(m.path ? { path: m.path } : {}), ...(m.error ? { error: m.error } : {}) })) } : {}) });
          s.messages = s.messages.slice(-HISTORY_KEEP);
        }).catch(() => {});
        const state = await store.read();
        if (!state.account?.token) continue;
        try {
          await execute(state, item, parseCommand(item.text || ''));
        } catch (e) {
          log('execute failed:', publicError(e).code, e?.message);
          await store.update(s => { s.receiver ||= {}; s.receiver.lastError = publicError(e).code; }).catch(() => {});
        }
      }
    };

    // Command dispatch: local replies are immediate; prompts become codex exec jobs.
    async function execute(state, item, cmd) {
      const to = state.account.userId;
      const reply = (id, text) => sendOrQueue(store, channel, { to, id, text, item });

      if (cmd.type === 'stop') {
        if (active) {
          active.stop();
          return reply(`reply:${item.id}`, '🛑 已发送停止信号。');
        }
        return reply(`reply:${item.id}`, '当前没有运行中的任务。');
      }
      if (cmd.type === 'help' || cmd.type === 'status' || cmd.type === 'ping') return run(channel, state, item, cmd);
      if (cmd.type !== 'prompt' && cmd.type !== 'new') return run(channel, state, item, cmd);

      // prompt / new task → codex exec (async: polling continues while it runs)
      if (active || taskPromise) {
        const cur = state.receiver?.job;
        const label = cur?.no ? `#${cur.no} ${cur.name}` : '';
        return reply(`busy:${item.id}`, `⏳ 任务 ${label || '上一个'} 还在运行,请等待完成,或先发送"停止"。`);
      }
      let prompt = String(cmd.prompt || '').trim();
      if (!prompt && item.media?.length) prompt = mediaPrompt(item);
      if (!prompt) return reply(`reply:${item.id}`, '任务内容为空,请重新描述。');
      if (cmd.type === 'new') await store.update(s => { delete s.receiver.threadId; }).catch(() => {});

      const settings = state.settings || {};
      const workspace = settings.workspace || os.homedir();
      const sandbox = settings.sandbox || 'workspace-write';
      const resultsDir = path.join(store.directory, 'results');
      await fs.mkdir(resultsDir, { recursive: true, mode: 0o700 });
      const jobId = randomUUID();
      const resultPath = path.join(resultsDir, `${jobId}.md`);
      const savedThread = cmd.type === 'new' ? undefined : state.receiver?.threadId;

      // Allocate the human identity: sequential number + short name from the prompt.
      let taskNo = 0; let taskTitle = '';
      await store.update(s => {
        s.receiver ||= {};
        s.receiver.taskSeq = (s.receiver.taskSeq || 0) + 1;
        taskNo = s.receiver.taskSeq;
        taskTitle = taskName(prompt);
        s.receiver.job = { no: taskNo, name: taskTitle, id: jobId, status: 'running', startedAt: Date.now(), prompt: prompt.slice(0, 200) };
        s.tasks ||= [];
        s.tasks.push({ no: taskNo, name: taskTitle, id: jobId, status: 'running', startedAt: Date.now() });
        s.tasks = s.tasks.slice(-20);
      }).catch(() => {});
      await reply(`start:${jobId}`, `🚀 任务 #${taskNo} 已开始:${taskTitle}\n\n${prompt.slice(0, 180)}`);

      const executable = await findCodex();
      active = codexRunner({
        executable, workspace, sandbox, threadId: savedThread, resultPath, prompt,
        onEvent: ev => {
          if (ev.type === 'thread.started' && ev.threadId) {
            store.update(s => { s.receiver ||= {}; s.receiver.threadId = ev.threadId; }).catch(() => {});
          }
        },
      });
      const mine = active;
      taskPromise = mine.done
        .then(async result => {
          await store.update(s => {
            s.receiver ||= {};
            s.receiver.job = { no: taskNo, name: taskTitle, id: jobId, status: result.status, finishedAt: Date.now(), threadId: result.threadId };
            if (result.threadId) s.receiver.threadId = result.threadId;
            const t = (s.tasks || []).find(t => t.id === jobId);
            if (t) { t.status = result.status; t.finishedAt = Date.now(); if (result.threadId) t.threadId = result.threadId; }
          }).catch(() => {});
          const { title, message } = resultMessage(result, taskNo, taskTitle);
          await enqueue(store, { notification_id: `result:${jobId}`, title, message, format: 'markdown' }).catch(() => {});
        })
        .catch(async e => {
          const err = publicError(e);
          await store.update(s => {
            s.receiver ||= {};
            s.receiver.job = { no: taskNo, name: taskTitle, id: jobId, status: 'failed', finishedAt: Date.now() };
            const t = (s.tasks || []).find(t => t.id === jobId);
            if (t) { t.status = 'failed'; t.finishedAt = Date.now(); }
          }).catch(() => {});
          await enqueue(store, { notification_id: `result:${jobId}`, title: `❌ Codex 任务失败 · #${taskNo} ${taskTitle}`, message: err.message, format: 'text' }).catch(() => {});
        })
        .finally(() => { if (active === mine) { active = null; taskPromise = null; } });
    }

    // ③ Outbox flush — drains whenever the window is open; toasts on ANY blocker so
    // the user never stares at silence (field lesson 2026-10-16).
    const flushFn = async () => {
      while (!exiting) {
        let waitMs = 5_000;
        try {
          const r = await flushOutbox(store, channel);
          const pending = r.remaining ?? 0;
          if (pending > 0) {
            if (r.connection === 'ready') {
              waitMs = r.budget_exhausted ? 60_000 : 1_000;
            } else {
              // window closed / rate-limited / blocked / login required → back off
              // hard and tell the user exactly how to unlock
              waitMs = 60_000;
              await queueToastNotice(store, pending);
            }
          }
        } catch (e) {
          log('flush error:', publicError(e).code, e?.message);
        }
        await idle(waitMs);
      }
    };

    const loops = Promise.all([
      runLoop('monitor', monitorFn),
      runLoop('consume', consumeFn),
      runLoop('flush', flushFn),
    ]);

    await exitSignal;
    exiting = true;
    if (active) active.stop();
    await Promise.race([loops, sleep(EXIT_GRACE_MS)]);
    clearInterval(beat);

    try { await channel.presence(false); } catch { /* best effort */ }
    await store.update(s => {
      if (s.receiver?.nonce === nonce) s.receiver = { enabled: false, threadId: s.receiver.threadId, job: s.receiver.job };
    }).catch(() => {});
    return { status: 'stopped' };
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    release();
  }
}

/** A supervisor counts as alive only when its pid lives AND its heartbeat is fresh —
 * Windows reuses pids, so a bare isAlive() once mistook AweSun for our supervisor. */
export function supervisorAlive(state) {
  const sup = state.supervisor;
  if (!isAlive(sup?.pid)) return false;
  const hb = Number(sup.heartbeat) || 0;
  return hb > 0 && Date.now() - hb < 90_000;
}

/**
 * Start the bridge through the supervisor (watchdog: crash/hang respawn, backoff).
 * Waits until the worker heartbeat appears.
 */
export async function startWorker(store = new Store()) {
  const existing = await store.read();
  if (receiverRunning(existing)) return { status: 'already_running' };
  if (!existing.account?.token || existing.account.authExpired) {
    throw new LocalError('LOGIN_REQUIRED', '请先扫码绑定微信。');
  }
  const supervisorScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'supervisor.mjs');
  if (!supervisorAlive(existing)) {
    const child = spawn(process.execPath, [supervisorScript], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, WECHAT_BRIDGE_STATE_DIR: store.directory },
    });
    child.unref();
  }
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const s = await store.read();
    if (receiverRunning(s)) return { status: 'started' };
    // a supervisor that exists in state but never heartbeats is bogus (pid reuse) —
    // the fresh spawn takes over via the stale-lock rule; keep waiting for the worker
    if (!supervisorAlive(s) && !isAlive(s.supervisor?.pid) && i > 5) break;
  }
  throw new LocalError('START_FAILED', '微信接收服务未能启动。');
}

/** Stop worker + supervisor via the stop flag, and kill the worker immediately. */
export async function stopWorker(store = new Store()) {
  const s = await store.read();
  await store.update(state => {
    if (state.receiver) state.receiver.enabled = false;
    if (state.supervisor) state.supervisor.stop = true;
  });
  if (receiverRunning(s)) {
    try { process.kill(s.receiver.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  if (isAlive(s.supervisor?.pid)) {
    try { process.kill(s.supervisor.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  return { status: receiverRunning(s) ? 'stopping' : 'stopped' };
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === selfPath && process.argv.includes('--worker')) {
  worker().then(result => {
    if (result.status === 'login_required') {
      log('login required: scan the QR first (node scripts/cli.mjs login)');
      process.exitCode = 3;
    }
  }).catch(e => {
    log('worker fatal:', publicError(e).code, e?.message);
    process.exitCode = 1;
  });
}
