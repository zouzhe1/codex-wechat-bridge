#!/usr/bin/env node
/**
 * Worker watchdog. Spawned detached by startWorker() and by the logon scheduled
 * task (install.ps1). Keeps one worker alive across crashes and hard hangs
 * (heartbeat staleness), with 2s→60s respawn backoff.
 *
 * Exit conditions (all intentional):
 *   - no bound account (exit 3) — nothing to supervise
 *   - stop requested via state (stopWorker) — bridge was turned off
 *   - another supervisor already holds the lock (exit 0)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Store, isAlive, publicError } from './store.mjs';

const WORKER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
const HANG_MS = 120_000;          // worker alive but heartbeat older than this → kill + respawn
const STARTUP_MS = 60_000;         // worker must take over state within this window
const CHECK_MS = 30_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString(), '[supervisor]', ...a);

async function stopRequested(store) {
  try { const s = await store.read(); return !!s.supervisor?.stop; } catch { return false; }
}

export async function supervisor({
  store = new Store(),
  workerScript = WORKER_SCRIPT,
  checkMs = CHECK_MS,
  hangMs = HANG_MS,
  startupMs = STARTUP_MS,
} = {}) {
  let release;
  try {
    release = await store.lock('supervisor', 0);
  } catch (e) {
    if (e.code === 'BUSY') return { status: 'already_running' };
    throw e;
  }

  const pid = process.pid;
  // Fresh intent: clear any stale stop flag from a previous stop command.
  await store.update(s => { s.supervisor = { pid, stop: false, startedAt: Date.now() }; }).catch(() => {});

  try {
    const initial = await store.read().catch(() => null);
    if (!initial?.account?.token || initial.account.authExpired) {
      log('no bound account — nothing to supervise');
      return { status: 'login_required' };
    }

    let backoff = 2_000;
    for (;;) {
      if (await stopRequested(store)) return { status: 'stopped' };

      let logFd = null;
      await store.ensure().catch(() => {});
      try { logFd = await fs.open(path.join(store.directory, 'worker.log'), 'a', 0o600); } catch { /* ignore */ }
      const errFd = logFd ? logFd.fd : 'ignore';
      const child = spawn(process.execPath, [workerScript, '--worker'], {
        stdio: ['ignore', 'ignore', errFd], windowsHide: true,
        env: { ...process.env, WECHAT_BRIDGE_STATE_DIR: store.directory },
      });
      void logFd?.close().catch(() => {});
      log(`worker spawned pid=${child.pid}`);
      const spawnedAt = Date.now();

      const exit = await new Promise(resolve => {
        let settled = false;
        const done = code => { if (!settled) { settled = true; resolve(code); } };
        child.once('error', () => done(-1));
        child.once('exit', code => done(code));

        const watch = setInterval(() => {
          if (settled) return;
          store.read().then(s => {
            const r = s.receiver || {};
            const ours = r.pid === child.pid;
            const hb = ours ? Number(r.heartbeat) || 0 : 0;
            const age = hb > 0 ? Date.now() - hb : Date.now() - spawnedAt;
            const limit = hb > 0 ? hangMs : startupMs;
            if (age > limit) {
              log(`worker pid=${child.pid} hung (heartbeat age ${Math.round(age / 1000)}s) — killing`);
              try { child.kill('SIGKILL'); } catch { /* already gone */ }
            }
          }).catch(() => {});
        }, checkMs);
        watch.unref();
        child.once('exit', () => clearInterval(watch));
      });

      if (await stopRequested(store)) return { status: 'stopped' };
      if (exit === 3) { log('worker reports login required — scan the QR first'); return { status: 'login_required' }; }
      log(`worker exited with ${exit}; respawning in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  } finally {
    await store.update(s => {
      if (s.supervisor?.pid === pid) s.supervisor = { pid: null, stop: false };
    }).catch(() => {});
    release();
  }
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === selfPath) {
  supervisor().then(result => {
    if (result.status === 'login_required') process.exitCode = 3;
  }).catch(e => {
    console.error('[supervisor] fatal:', publicError(e));
    process.exitCode = 1;
  });
}
