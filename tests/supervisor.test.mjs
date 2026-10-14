import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../scripts/store.mjs';
import { supervisor } from '../scripts/supervisor.mjs';
import { tempDir, cleanup } from './helpers.mjs';

async function writeScript(dir, name, source) {
  const p = path.join(dir, name);
  await fs.writeFile(p, source);
  return p;
}

test('supervisor refuses to run twice', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const release = await store.lock('supervisor', 0);
  try {
    const r = await supervisor({ store, workerScript: 'unused.mjs' });
    assert.deepEqual(r, { status: 'already_running' });
  } finally { await release(); }
});

test('supervisor exits with login_required when nothing is bound', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const r = await supervisor({ store, workerScript: 'unused.mjs' });
  assert.equal(r.status, 'login_required');
  // cleanup ran: supervisor entry released
  assert.equal((await store.read()).supervisor?.pid ?? null, null);
});

test('supervisor exits with login_required when the token is expired', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await store.update(s => { s.account = { token: 't', authExpired: true }; });
  const r = await supervisor({ store, workerScript: 'unused.mjs' });
  assert.equal(r.status, 'login_required');
});

test('supervisor treats worker exit code 3 as login_required', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await store.update(s => { s.account = { token: 't', userId: 'u' }; });
  const fake = await writeScript(dir, 'exit3.mjs', 'process.exit(3);');
  const r = await supervisor({ store, workerScript: fake });
  assert.equal(r.status, 'login_required');
});

test('supervisor respawns a crashing worker, then honours the stop flag', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await store.update(s => { s.account = { token: 't', userId: 'u' }; });
  const fake = await writeScript(dir, 'crash.mjs', 'process.exit(7);');

  const run = supervisor({ store, workerScript: fake });
  // wait until the supervisor registered itself
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !(await store.read()).supervisor?.pid) {
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok((await store.read()).supervisor?.pid, 'supervisor registers itself');

  // let it crash-loop at least once, then request stop
  await new Promise(r => setTimeout(r, 500));
  await store.update(s => { if (s.supervisor) s.supervisor.stop = true; });
  const result = await run;
  assert.equal(result.status, 'stopped');
  assert.equal((await store.read()).supervisor?.pid ?? null, null, 'entry cleared on exit');
});

test('supervisor kills a worker whose heartbeat stops moving', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await store.update(s => { s.account = { token: 't', userId: 'u' } });
  const marker = path.join(dir, 'marker.txt');
  // fake worker: claims takeover (writes receiver heartbeat once) then wedges forever;
  // 'start' is appended on launch, 'clean' only on a graceful exit — a SIGKILL leaves 'start' alone.
  const fake = await writeScript(dir, 'hang.mjs', `
    import fs from 'node:fs';
    const { Store } = await import(${JSON.stringify(new URL('../scripts/store.mjs', import.meta.url).href)});
    const store = new Store(process.env.WECHAT_BRIDGE_STATE_DIR);
    fs.appendFileSync(${JSON.stringify(marker)}, 'start\\n');
    await store.update(s => { s.receiver = { enabled: true, pid: process.pid, nonce: 'x', heartbeat: Date.now() }; });
    await new Promise(() => {}); // hang forever
    fs.appendFileSync(${JSON.stringify(marker)}, 'clean\\n');
  `);

  const run = supervisor({ store, workerScript: fake, checkMs: 100, hangMs: 600, startupMs: 5000 });
  // wait for registration, then request stop after the first kill lands
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !(await store.read()).supervisor?.pid) {
    await new Promise(r => setTimeout(r, 50));
  }
  await new Promise(r => setTimeout(r, 1500)); // kill expected ≈0.7s
  await store.update(s => { if (s.supervisor) s.supervisor.stop = true; });
  const result = await run;
  assert.equal(result.status, 'stopped');

  const lines = (await fs.readFile(marker, 'utf8')).trim().split('\n');
  assert.equal(lines[0], 'start', 'worker did launch');
  assert.ok(!lines.includes('clean'), 'wedged worker was SIGKILLed, never exited cleanly');
  assert.equal(lines.length, 1, 'no second spawn after the stop request');
});
