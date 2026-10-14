import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../scripts/store.mjs';
import { tempDir, cleanup } from './helpers.mjs';

const NOTIFY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'notify.mjs');

function runNotify(stateDir, { argv = [], env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [NOTIFY, ...argv], {
      env: { ...process.env, WECHAT_BRIDGE_STATE_DIR: stateDir, ...env },
      stdio: 'ignore',
    });
    child.once('close', code => resolve(code));
  });
}

const PAYLOAD = JSON.stringify({
  type: 'agent-turn-complete',
  'thread-id': 'b5f6c1c2-1111-2222-3333-444455556666',
  'turn-id': '12345',
  cwd: '/home/u/project',
  'input-messages': ['do it'],
  'last-assistant-message': '# 完成\n\n结果正文',
});

test('notify exits 0 and does nothing without a parseable payload', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  assert.equal(await runNotify(dir, { argv: [] }), 0);
  assert.equal(await runNotify(dir, { argv: ['not-json'] }), 0);
  assert.equal(await runNotify(dir, { argv: [JSON.stringify({ type: 'other' })] }), 0);
  const store = new Store(dir);
  const s = await store.read();
  assert.equal(s.outbox.length, 0);
});

test('notify with default on-demand mode skips TUI turns', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  assert.equal(await runNotify(dir, { argv: [PAYLOAD] }), 0);
  const store = new Store(dir);
  assert.equal((await store.read()).outbox.length, 0, 'on-demand must not notify plain turns');
});

test('notify enqueues in always mode with turn-based idempotency key and markdown format', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await store.update(s => { s.settings = { notify_mode: 'always' }; });

  assert.equal(await runNotify(dir, { argv: [PAYLOAD] }), 0);
  const s = await store.read();
  assert.equal(s.outbox.length, 1);
  assert.equal(s.outbox[0].notification_id, 'turn:b5f6c1c2-1111-2222-3333-444455556666:12345');
  assert.equal(s.outbox[0].format, 'markdown');
  assert.ok(s.outbox[0].title.includes('project'), 'title carries the working directory name');
  assert.ok(s.outbox[0].message.includes('结果正文'));

  // replaying the same turn must not double-queue
  assert.equal(await runNotify(dir, { argv: [PAYLOAD] }), 0);
  assert.equal((await store.read()).outbox.length, 1, 'same turn id is idempotent');
});

test('notify skips everything under WECHAT_BRIDGE_CHILD (no double-send with worker results)', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await store.update(s => { s.settings = { notify_mode: 'always' }; });
  assert.equal(await runNotify(dir, { argv: [PAYLOAD], env: { WECHAT_BRIDGE_CHILD: '1' } }), 0);
  assert.equal((await store.read()).outbox.length, 0);
});

test('notify forwards the payload to a pre-registered notify command (single-slot preservation)', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const marker = path.join(dir, 'forwarded.txt');
  // spawn target: node -e <code> <payload> → appends the payload to marker
  await store.update(s => {
    s.settings = { notify_forward: [process.execPath, '-e',
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv[1] + '\\n')`] };
  });
  assert.equal(await runNotify(dir, { argv: [PAYLOAD] }), 0);
  // detached spawn — poll for the marker
  const deadline = Date.now() + 4000;
  let seen = '';
  while (Date.now() < deadline) {
    try { seen = await fs.readFile(marker, 'utf8'); if (seen) break; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(seen.includes('agent-turn-complete'), 'forwarded payload must arrive intact');
  assert.equal((await store.read()).outbox.length, 0, 'on-demand still gates our own enqueue');
});

test('notify skips when the assistant produced no message', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await store.update(s => { s.settings = { notify_mode: 'always' }; });
  const empty = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 't', 'turn-id': '1', 'last-assistant-message': null });
  assert.equal(await runNotify(dir, { argv: [empty] }), 0);
  assert.equal((await store.read()).outbox.length, 0);
});
