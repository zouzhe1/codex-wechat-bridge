import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../scripts/store.mjs';
import { Channel } from '../scripts/channel.mjs';
import { loginStart, loginPoll } from '../scripts/login.mjs';
import { mockFetch, tempDir, cleanup, PNG_MAGIC } from './helpers.mjs';

const BASE = 'https://ilinkai.weixin.qq.com';

function seedPending(store, overrides = {}) {
  return store.update(s => {
    s.pending = { qrcode: 'QR1', base: BASE, createdAt: Date.now(), qrFilename: 'login-qr.png', refreshes: 1, ...overrides };
  });
}

async function pngOf(store, file) {
  const buf = await fs.readFile(path.join(store.directory, file));
  return buf.subarray(0, 8).equals(PNG_MAGIC);
}

test('loginStart mints a QR, saves a local PNG, and persists pending state', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const fetchImpl = mockFetch(call => {
    assert.match(call.url, /get_bot_qrcode\?bot_type=3$/);
    return { qrcode: 'QR1', qrcode_img_content: 'https://login.example/session/1' };
  });
  const channel = new Channel({ fetchImpl });
  const result = await loginStart(store, channel);
  assert.equal(result.status, 'scan_required');
  assert.ok(result.qr_path.endsWith('.png'));
  assert.ok(await pngOf(store, path.basename(result.qr_path)), 'QR must be a PNG');
  const s = await store.read();
  assert.equal(s.pending.qrcode, 'QR1');
  assert.equal(s.pending.base, BASE);
});

test('loginStart reuses a fresh pending QR instead of minting another', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await seedPending(store);
  const fetchImpl = mockFetch(() => { throw new Error('should not fetch a new QR'); });
  const channel = new Channel({ fetchImpl });
  const result = await loginStart(store, channel);
  assert.equal(result.status, 'scan_required');
  assert.ok(result.qr_path.includes('login-qr.png'));
  assert.equal(fetchImpl.calls.length, 0);
});

test('loginPoll walks wait → scaned → confirmed and persists the account', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await seedPending(store);
  const statuses = [{ status: 'wait' }, { status: 'scaned' }, {
    status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'bot1', ilink_user_id: 'user1', baseurl: BASE,
  }];
  let i = 0;
  const fetchImpl = mockFetch(call => {
    assert.match(call.url, /get_qrcode_status\?qrcode=QR1$/);
    return statuses[Math.min(i++, statuses.length - 1)];
  });
  const channel = new Channel({ fetchImpl });

  assert.deepEqual(await loginPoll(store, channel, { waitSeconds: 1 }), { status: 'wait' });
  assert.equal((await loginPoll(store, channel, { waitSeconds: 1 })).status, 'scaned');
  assert.equal((await loginPoll(store, channel, { waitSeconds: 1 })).status, 'connected');

  const s = await store.read();
  assert.equal(s.account.token, 'tok');
  assert.equal(s.account.botId, 'bot1');
  assert.equal(s.account.userId, 'user1');
  assert.equal(s.account.base, BASE);
  assert.equal(s.account.cursor, '');
  assert.equal(s.pending, undefined);
});

test('loginPoll forwards the verify_code as a query parameter', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await seedPending(store);
  const fetchImpl = mockFetch(call => {
    assert.match(call.url, /qrcode=QR1/);
    assert.match(call.url, /verify_code=123456/);
    return { status: 'need_verifycode' };
  });
  const channel = new Channel({ fetchImpl });
  const r = await loginPoll(store, channel, { verifyCode: '123456', waitSeconds: 1 });
  assert.equal(r.status, 'need_verifycode');
});

test('loginPoll rejects a malformed verify_code locally', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const channel = new Channel({ fetchImpl: mockFetch(() => ({})) });
  await assert.rejects(() => loginPoll(store, channel, { verifyCode: 'abc' }),
    e => e.code === 'INVALID_CODE');
});

test('scaned_but_redirect with an off-domain host is refused (UNTRUSTED_HOST)', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await seedPending(store);
  const fetchImpl = mockFetch(() => ({ status: 'scaned_but_redirect', redirect_host: 'evil.example.com' }));
  const channel = new Channel({ fetchImpl });
  await assert.rejects(() => loginPoll(store, channel, { waitSeconds: 1 }),
    e => e.code === 'UNTRUSTED_HOST');
  assert.equal((await store.read()).pending.base, BASE, 'pending base must stay on-domain');
});

test('scaned_but_redirect to an approved host moves the pending base', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await seedPending(store);
  const fetchImpl = mockFetch(() => ({ status: 'scaned_but_redirect', redirect_host: 'alt.weixin.qq.com' }));
  const channel = new Channel({ fetchImpl });
  await loginPoll(store, channel, { waitSeconds: 1 });
  assert.equal((await store.read()).pending.base, 'https://alt.weixin.qq.com');
});

test('expired QR auto-refreshes instead of dead-ending', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await seedPending(store);
  let qrCalls = 0;
  const fetchImpl = mockFetch(call => {
    if (call.url.includes('get_bot_qrcode')) {
      qrCalls += 1;
      return { qrcode: `QR-NEW-${qrCalls}`, qrcode_img_content: 'https://login.example/refresh' };
    }
    return { status: 'expired' };
  });
  const channel = new Channel({ fetchImpl });
  const r = await loginPoll(store, channel, { waitSeconds: 1 });
  assert.equal(r.status, 'scan_required');
  assert.equal(qrCalls, 1);
  const s = await store.read();
  assert.equal(s.pending.qrcode, 'QR-NEW-1');
  assert.equal(s.pending.refreshes, 2);
});

test('persistent expiry gives up after MAX_QR_REFRESH refreshes', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await seedPending(store, { refreshes: 3 }); // already at the cap
  const fetchImpl = mockFetch(() => ({ status: 'expired' }));
  const channel = new Channel({ fetchImpl });
  const r = await loginPoll(store, channel, { waitSeconds: 1 });
  assert.equal(r.status, 'expired');
  const s = await store.read();
  assert.equal(s.pending, undefined);
});

test('binded_redirect with a live local credential stays connected', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await seedPending(store);
  await store.update(s => { s.account = { token: 'old-tok', userId: 'u', botId: 'b', base: BASE }; });
  const fetchImpl = mockFetch(() => ({ status: 'binded_redirect' }));
  const channel = new Channel({ fetchImpl });
  const r = await loginPoll(store, channel, { waitSeconds: 1 });
  assert.equal(r.status, 'connected');
  assert.equal((await store.read()).pending, undefined);
});

test('binded_redirect without local credentials raises BOUND_ELSEWHERE', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await seedPending(store);
  const fetchImpl = mockFetch(() => ({ status: 'binded_redirect' }));
  const channel = new Channel({ fetchImpl });
  await assert.rejects(() => loginPoll(store, channel, { waitSeconds: 1 }),
    e => e.code === 'BOUND_ELSEWHERE');
});

test('confirmed login clears the previous inbox but keeps queued outbox', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await seedPending(store);
  await store.update(s => {
    s.inbox = [{ id: 'stale', text: 'old' }];
    s.outbox = [{ notification_id: 'n1', message: 'keep me', createdAt: Date.now() }];
  });
  const fetchImpl = mockFetch(() => ({
    status: 'confirmed', bot_token: 'tok2', ilink_bot_id: 'bot2', ilink_user_id: 'user2', baseurl: BASE,
  }));
  const channel = new Channel({ fetchImpl });
  await loginPoll(store, channel, { waitSeconds: 1 });
  const s = await store.read();
  assert.equal(s.account.token, 'tok2');
  assert.deepEqual(s.inbox, []);
  assert.equal(s.outbox.length, 1, 'queued notifications survive rebind');
});
