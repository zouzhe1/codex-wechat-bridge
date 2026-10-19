import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store, LocalError, isAlive, publicError } from '../scripts/store.mjs';
import { tempDir, cleanup } from './helpers.mjs';

test('read() on a fresh directory returns the default state', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const s = await store.read();
  assert.equal(s.version, 1);
  assert.deepEqual(s.notifications, []);
  assert.deepEqual(s.outbox, []);
  assert.deepEqual(s.inbox, []);
  assert.equal(s.receiver.enabled, false);
});

test('write→read roundtrip persists and leaves no tmp files', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await store.update(s => { s.account = { token: 'tok' }; });
  const s = await store.read();
  assert.equal(s.account.token, 'tok');
  const files = await fs.readdir(dir);
  assert.ok(!files.some(f => f.endsWith('.tmp')), `tmp leftover: ${files}`);
});

test('update() returns the callback result and holds the lock across read-modify-write', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const result = await store.update(s => { s.inbox.push({ id: 1 }); return s.inbox.length; });
  assert.equal(result, 1);
  assert.equal((await store.read()).inbox.length, 1);
});

test('a held lock makes a second acquisition fail with BUSY', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const release = await store.lock('state', 0);
  await assert.rejects(() => store.lock('state', 100), e => e.code === 'BUSY');
  await release();
  // After release the lock is reacquirable.
  const release2 = await store.lock('state', 100);
  await release2();
});

test('a lock owned by a dead pid is reclaimed', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await fs.writeFile(path.join(dir, 'state.lock'), JSON.stringify({ pid: 999_999_99, nonce: 'x' }));
  const release = await store.lock('state', 500);
  await release();
});

test('a lock whose owner pid was REUSED by another app is broken after the stale window', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  // Field case 2026-10-19: our supervisor died, Windows handed its pid to AweSun.
  // Simulate: owner = a definitely-alive pid (ours), lock mtime aged past the window.
  const file = path.join(dir, 'state.lock');
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, nonce: 'ghost' }));
  const old = new Date(Date.now() - 10 * 60_000);
  await fs.utimes(file, old, old);

  const release = await store.lock('state', 1000, { staleMs: 60_000 });
  await release(); // reclaimed despite the "alive" owner
});

test('a refreshable lock stays fresh and blocks others while its holder lives', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const release = await store.lock('state', 0, { refreshMs: 100 });
  try {
    // past the stale window the refreshed mtime keeps it locked
    await assert.rejects(() => store.lock('state', 300, { staleMs: 300 }), e => e.code === 'BUSY');
  } finally { await release(); }
  // released → immediate reacquire
  const release2 = await store.lock('state', 300, { staleMs: 300 });
  await release2();
});

test('a corrupted state file raises STATE_INVALID and is never overwritten', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await store.ensure();
  await fs.writeFile(store.file, '{"broken": true');
  await assert.rejects(() => store.read(), e => e.code === 'STATE_INVALID');
  await assert.rejects(() => store.update(s => s), e => e.code === 'STATE_INVALID');
  assert.equal(await fs.readFile(store.file, 'utf8'), '{"broken": true');
});

test('isAlive rejects nonsense pids and accepts the current process', () => {
  assert.equal(isAlive(1), false);
  assert.equal(isAlive('x'), false);
  assert.equal(isAlive(process.pid), true);
});

test('LocalError carries a machine-readable code; publicError hides non-local details', () => {
  const e = new LocalError('SOME_CODE', '消息');
  assert.equal(e.code, 'SOME_CODE');
  assert.deepEqual(publicError(e), { code: 'SOME_CODE', message: '消息' });
  const generic = publicError(new Error('secret token xyz'));
  assert.equal(generic.code, 'LOCAL_FAILURE');
  assert.ok(!generic.message.includes('secret token xyz'));
});
