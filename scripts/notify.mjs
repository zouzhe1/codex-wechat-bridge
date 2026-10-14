#!/usr/bin/env node
/**
 * Codex `notify` hook entry — config.toml: notify = ["node", "<abs path>/notify.mjs"]
 * Codex appends the agent-turn-complete JSON as the LAST argv token, stdio is null,
 * and the process is fire-and-forget. Therefore: never throw, always exit 0.
 *
 * Policy:
 *   - WECHAT_BRIDGE_CHILD=1 → skip (the worker already sends its own task results;
 *     this prevents the double-send).
 *   - notify_mode=on-demand (default) → skip TUI turns; only worker tasks and explicit
 *     MCP tool calls reach WeChat.
 *   - notify_mode=always → enqueue every completed turn.
 *   - Queue drains via the resident worker; if the worker is down we re-spawn it.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from './store.mjs';
import { receiverRunning } from './session.mjs';
import { enqueue } from './outbox.mjs';
import { startWorker } from './worker.mjs';

async function main() {
  const raw = process.argv[process.argv.length - 1];
  if (!raw || raw === process.argv[1]) return; // no JSON appended

  const store = new Store();

  // `notify` is a single-slot config field — other plugins (e.g. computer-use) may
  // already own it. settings.notify_forward preserves their command: we re-spawn it
  // with the identical payload before doing anything of our own. Best-effort: a dead
  // forward target must NEVER crash this process (spawn errors are async!).
  try {
    const st = await store.read();
    const forward = st.settings?.notify_forward;
    if (Array.isArray(forward) && forward.length > 0) {
      const child = spawn(forward[0], [...forward.slice(1), raw], {
        stdio: 'ignore', windowsHide: true, detached: true,
      });
      child.on('error', () => { /* stale path or missing binary — ignore */ });
      child.unref?.();
    }
  } catch { /* forwarding is best-effort */ }

  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  if (payload?.type !== 'agent-turn-complete') return;
  if (process.env.WECHAT_BRIDGE_CHILD === '1') return;

  const state = await store.read().catch(() => null);
  if (!state) return;
  if ((state.settings?.notify_mode || 'on-demand') !== 'always') return;

  const message = payload['last-assistant-message'];
  if (typeof message !== 'string' || !message.trim()) return;

  const cwdName = payload.cwd ? path.basename(payload.cwd) : '';
  await enqueue(store, {
    notification_id: `turn:${payload['thread-id'] || 'none'}:${payload['turn-id'] || 'none'}`,
    title: `Codex · ${cwdName || '对话'}`,
    message,
    format: 'markdown',
  }).catch(() => {});

  // Self-heal: make sure something is draining the queue.
  try {
    const cur = await store.read();
    if (!receiverRunning(cur) && cur.account?.token && !cur.account.authExpired) {
      await startWorker(store);
    }
  } catch { /* best effort — the next notify retry or CLI start will catch up */ }
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
