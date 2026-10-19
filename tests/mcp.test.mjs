import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../scripts/store.mjs';
import { validateArgs, callTool as callToolDirect, ensureBridgeAlive } from '../scripts/mcp-server.mjs';
import { tempDir, cleanup } from './helpers.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'mcp-server.mjs');

function connect(stateDir, env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, WECHAT_BRIDGE_STATE_DIR: stateDir, WECHAT_BRIDGE_AUTOHEAL: '0', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const resolve = pending.get(msg.id);
        if (resolve) { pending.delete(msg.id); resolve(msg); }
      } catch { /* ignore */ }
    }
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, 5000);
  });
  const close = () => child.kill();
  return { request, close, child };
}

async function callTool(conn, name, args) {
  const res = await conn.request('tools/call', { name, arguments: args });
  const payload = JSON.parse(res.result.content[0].text);
  return { payload, isError: res.result.isError === true };
}

test('MCP handshake: initialize, ping, tools/list', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const conn = connect(dir);
  t.after(() => conn.close());

  const init = await conn.request('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.serverInfo.name, 'codex-wechat-bridge');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.instructions.includes('行为契约'));

  const pong = await conn.request('ping');
  assert.deepEqual(pong.result, {});

  const list = await conn.request('tools/list');
  const names = list.result.tools.map(t => t.name).sort();
  assert.deepEqual(names, ['wechat_login', 'wechat_login_poll', 'wechat_read_messages', 'wechat_send_file',
    'wechat_send_image', 'wechat_send_markdown', 'wechat_send_message', 'wechat_start', 'wechat_status',
    'wechat_stop', 'wechat_typing'].sort());
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must be a whitelist schema`);
  }
});

test('MCP unknown methods report JSON-RPC -32601; notifications get no reply', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const conn = connect(dir);
  t.after(() => conn.close());
  const res = await conn.request('no/such/method');
  assert.equal(res.error.code, -32601);
  conn.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  // if the server wrongly replied, our next request would still resolve — mainly a liveness check
  const pong = await conn.request('ping');
  assert.deepEqual(pong.result, {});
});

test('wechat_status returns connection info without secrets', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const conn = connect(dir);
  t.after(() => conn.close());
  const { payload, isError } = await callTool(conn, 'wechat_status');
  assert.equal(isError, false);
  assert.equal(payload.connection, 'not_connected');
  assert.equal(payload.bound, false);
  assert.ok(!JSON.stringify(payload).includes('token'));
});

test('tool argument validation: unknown/missing/pattern violations are isError', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const conn = connect(dir);
  t.after(() => conn.close());

  const unknown = await callTool(conn, 'wechat_send_message', { text: 'x', recipient: 'someone' });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.payload.code, 'INVALID_ARGS');

  const missing = await callTool(conn, 'wechat_send_message', {});
  assert.equal(missing.isError, true);
  assert.equal(missing.payload.code, 'INVALID_ARGS');

  const badCode = await callTool(conn, 'wechat_login_poll', { code: 'abc' });
  assert.equal(badCode.isError, true);
  assert.equal(badCode.payload.code, 'INVALID_ARGS');

  const badTool = await callTool(conn, 'wechat_nope', {});
  assert.equal(badTool.isError, true);
  assert.equal(badTool.payload.code, 'UNKNOWN_TOOL');
});

test('wechat_send_message enqueues into the shared state', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const conn = connect(dir);
  t.after(() => conn.close());
  const { payload, isError } = await callTool(conn, 'wechat_send_message', { text: '来自模型的消息' });
  assert.equal(isError, false);
  assert.equal(payload.status, 'queued');
  const store = new Store(dir);
  const s = await store.read();
  assert.equal(s.outbox.length, 1);
  assert.equal(s.outbox[0].message, '来自模型的消息');
});

test('child processes may read status and push media, but not control the bridge or send text', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const conn = connect(dir, { WECHAT_BRIDGE_CHILD: '1' });
  t.after(() => conn.close());
  const status = await callTool(conn, 'wechat_status');
  assert.equal(status.isError, false);
  const start = await callTool(conn, 'wechat_start', {});
  assert.equal(start.isError, true);
  assert.equal(start.payload.code, 'CHILD_CONTROL_DISABLED');
  const send = await callTool(conn, 'wechat_send_message', { text: 'x' });
  assert.equal(send.isError, true);
  assert.equal(send.payload.code, 'CHILD_CONTROL_DISABLED');
  const stop = await callTool(conn, 'wechat_stop', {});
  assert.equal(stop.isError, true);
  assert.equal(stop.payload.code, 'CHILD_CONTROL_DISABLED');
  // media send is permitted for children — it fails on credentials here, not on the guard
  const image = await callTool(conn, 'wechat_send_image', { path: '/tmp/x.png' });
  assert.equal(image.isError, true);
  assert.equal(image.payload.code, 'LOGIN_REQUIRED');
});

test('wechat_send_image validates file access and window state', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const conn = connect(dir);
  t.after(() => conn.close());
  // no account → LOGIN_REQUIRED
  const noLogin = await callTool(conn, 'wechat_send_image', { path: path.join(dir, 'x.png') });
  assert.equal(noLogin.isError, true);
  assert.equal(noLogin.payload.code, 'LOGIN_REQUIRED');

  // account without context_token → soft session_required (not an error)
  const store = new Store(dir);
  await store.update(s => {
    s.account = { token: 'tok', base: 'https://ilinkai.weixin.qq.com', userId: 'u1', botId: 'b1' };
  });
  const conn2 = connect(dir);
  t.after(() => conn2.close());
  const noWindow = await callTool(conn2, 'wechat_send_image', { path: path.join(dir, 'x.png') });
  assert.equal(noWindow.isError, false);
  assert.equal(noWindow.payload.status, 'message_required');

  // with a window open, a missing file is reported as FILE_UNREADABLE
  await store.update(s => { s.account.contextToken = 'ctx'; });
  const missing = await callTool(conn2, 'wechat_send_image', { path: path.join(dir, 'nope.png') });
  assert.equal(missing.isError, true);
  assert.equal(missing.payload.code, 'FILE_UNREADABLE');
});

test('wechat_typing (in-process) uses the account session and reports soft failures', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const { Channel } = await import('../scripts/channel.mjs');
  const { mockFetch: mf } = await import('./helpers.mjs');
  const fetchImpl = mf(call => (call.url.includes('getconfig')
    ? { ret: 0, typing_ticket: 'tk' }
    : { ret: 0 }));
  const channel = new Channel({ fetchImpl });
  channel.presence = async () => {};

  // not bound yet
  await assert.rejects(() => callToolDirect('wechat_typing', {}, { store, channel }),
    e => e.code === 'LOGIN_REQUIRED');

  await store.update(s => {
    s.account = { token: 'tok', base: 'https://ilinkai.weixin.qq.com', userId: 'u1', botId: 'b1' };
  });
  await assert.rejects(() => callToolDirect('wechat_typing', {}, { store, channel }),
    e => e.code === 'SESSION_REQUIRED');

  await store.update(s => { s.account.contextToken = 'ctx-live'; });
  const ok = await callToolDirect('wechat_typing', {}, { store, channel });
  assert.equal(ok.sent, true);
  assert.equal(fetchImpl.calls.length, 2, 'getconfig + sendtyping(typed)');
});

test('ensureBridgeAlive revives a dead bridge exactly once per throttle window', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await store.update(s => {
    s.account = { token: 'tok', base: 'https://ilinkai.weixin.qq.com', userId: 'u1', botId: 'b1' };
    s.receiver = { enabled: false };
  });
  let starts = 0;
  const start = async () => { starts += 1; };

  const r1 = await ensureBridgeAlive(store, { start });
  assert.equal(r1.healed, true);
  assert.equal(starts, 1, 'dead bridge with no supervisor → start');

  const r2 = await ensureBridgeAlive(store, { start });
  assert.equal(r2.healed, false);
  assert.equal(r2.why, 'throttled', 'second call within 30s is throttled');
  assert.equal(starts, 1);

  // a live supervisor (fresh heartbeat) means it is NOT our job to spawn
  const dir2 = await tempDir(); t.after(() => cleanup(dir2));
  const store2 = new Store(dir2);
  await store2.update(s => {
    s.account = { token: 'tok' };
    s.supervisor = { pid: process.pid, stop: false, heartbeat: Date.now() };
  });
  const r3 = await ensureBridgeAlive(store2, { start });
  assert.equal(r3.why, 'supervisor_alive');
  assert.equal(starts, 1);

  // a supervisor pid WITHOUT a fresh heartbeat is a stranger (pid reuse) → we spawn
  const dir4 = await tempDir(); t.after(() => cleanup(dir4));
  const store4 = new Store(dir4);
  await store4.update(s => {
    s.account = { token: 'tok' };
    s.supervisor = { pid: process.pid, stop: false, heartbeat: Date.now() - 10 * 60_000 };
  });
  const r6 = await ensureBridgeAlive(store4, { start });
  assert.equal(r6.healed, true, 'stale-heartbeat supervisor must not block the heal');
  assert.equal(starts, 2);

  // no account → never spawn
  const dir3 = await tempDir(); t.after(() => cleanup(dir3));
  const r4 = await ensureBridgeAlive(new Store(dir3), { start });
  assert.equal(r4.why, 'no_account');
  assert.equal(starts, 2);

  // env kill-switch
  process.env.WECHAT_BRIDGE_AUTOHEAL = '0';
  try {
    const r5 = await ensureBridgeAlive(store, { start });
    assert.equal(r5.why, 'disabled');
  } finally { delete process.env.WECHAT_BRIDGE_AUTOHEAL; }
});

test('validateArgs applies defaults and enforces ranges', () => {
  const schema = { type: 'object', properties: { wait_seconds: { type: 'integer', minimum: 1, maximum: 30, default: 25 } }, required: [], additionalProperties: false };
  assert.deepEqual(validateArgs(schema, {}), { wait_seconds: 25 });
  assert.throws(() => validateArgs(schema, { wait_seconds: 0 }), e => e.code === 'INVALID_ARGS');
  assert.throws(() => validateArgs(schema, { wait_seconds: 31 }), e => e.code === 'INVALID_ARGS');
  assert.throws(() => validateArgs(schema, { wait_seconds: 1.5 }), e => e.code === 'INVALID_ARGS');
});
