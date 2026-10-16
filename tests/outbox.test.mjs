import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../scripts/store.mjs';
import { enqueue, flushOutbox, OUTBOX_TTL_MS } from '../scripts/outbox.mjs';
import { ChannelError } from '../scripts/channel.mjs';
import { tempDir, cleanup } from './helpers.mjs';

function readyAccount(overrides = {}) {
  return { token: 'tok', base: 'https://ilinkai.weixin.qq.com', userId: 'u1', botId: 'b1',
    contextToken: 'ctx', lastInboundAt: Date.now() - 1000, connectedAt: Date.now() - 10_000, ...overrides };
}

function mockChannel(behavior = {}) {
  const sent = [];
  const channel = {
    sent,
    sendText: async (to, text, ctx, opts) => {
      if (behavior.fail) {
        const e = behavior.fail();
        if (e) throw e;
      }
      sent.push({ to, text, ctx, opts });
    },
  };
  return channel;
}

async function seededStore(t, { account = readyAccount(), outbox = [], notifications = [] } = {}) {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await store.update(s => {
    if (account) s.account = account;
    s.outbox = outbox;
    s.notifications = notifications;
    s.receiver = { enabled: false };
  });
  return store;
}

test('enqueue: basic queueing records history status queued', async t => {
  const store = await seededStore(t);
  const r = await enqueue(store, { notification_id: 'n1', title: '标题', message: '内容' });
  assert.deepEqual(r, { status: 'queued' });
  const s = await store.read();
  assert.equal(s.outbox.length, 1);
  assert.equal(s.outbox[0].format, 'text');
  assert.equal(s.notifications.length, 1);
  assert.equal(s.notifications[0].status, 'queued');
});

test('enqueue: duplicate id + same body → duplicate; different body → ID_CONFLICT', async t => {
  const store = await seededStore(t);
  await enqueue(store, { notification_id: 'n1', message: '同样内容' });
  const dup = await enqueue(store, { notification_id: 'n1', message: '同样内容' });
  assert.equal(dup.duplicate, true);
  assert.equal((await store.read()).outbox.length, 1, 'duplicate must not double-queue');
  await assert.rejects(() => enqueue(store, { notification_id: 'n1', message: '换了内容' }),
    e => e.code === 'ID_CONFLICT');
});

test('enqueue: validation rejects bad input without touching state', async t => {
  const store = await seededStore(t);
  await assert.rejects(() => enqueue(store, { notification_id: '', message: 'x' }), e => e.code === 'INVALID_ID');
  await assert.rejects(() => enqueue(store, { notification_id: 'a'.repeat(201), message: 'x' }), e => e.code === 'INVALID_ID');
  await assert.rejects(() => enqueue(store, { notification_id: 'n', message: '   ' }), e => e.code === 'EMPTY_MESSAGE');
  await assert.rejects(() => enqueue(store, { notification_id: 'n', message: 'x'.repeat(50_001) }), e => e.code === 'MESSAGE_TOO_LONG');
  await assert.rejects(() => enqueue(store, { notification_id: 'n', message: 'x', format: 'html' }), e => e.code === 'INVALID_FORMAT');
  assert.equal((await store.read()).outbox.length, 0);
});

test('enqueue: dry run previews without writing', async t => {
  const store = await seededStore(t);
  const r = await enqueue(store, { notification_id: 'n1', title: 'T', message: 'body', dryRun: true });
  assert.equal(r.status, 'preview');
  assert.ok(r.preview.includes('T'));
  const s = await store.read();
  assert.equal(s.outbox.length, 0);
  assert.equal(s.notifications.length, 0);
});

test('enqueue: the outbox caps at 50 and prunes entries older than 7 days', async t => {
  const store = await seededStore(t);
  for (let i = 0; i < 50; i++) await enqueue(store, { notification_id: `n${i}`, message: `m${i}` });
  await assert.rejects(() => enqueue(store, { notification_id: 'n51', message: 'x' }), e => e.code === 'OUTBOX_FULL');

  const dir2 = await seededStore(t, {
    outbox: [{ notification_id: 'old', message: 'stale', format: 'text', createdAt: Date.now() - OUTBOX_TTL_MS - 1000 }],
    notifications: [],
  });
  const r = await enqueue(dir2, { notification_id: 'fresh', message: 'new' });
  assert.equal(r.status, 'queued');
  const s = await dir2.read();
  assert.deepEqual(s.outbox.map(o => o.notification_id), ['fresh'], 'stale entry pruned on enqueue');
});

test('flush: reports the connection and sends nothing while the window is closed', async t => {
  const store = await seededStore(t, { account: readyAccount({ lastInboundAt: Date.now() - OUTBOX_TTL_MS }) });
  await enqueue(store, { notification_id: 'n1', message: 'queued text' });
  const channel = mockChannel();
  const r = await flushOutbox(store, channel);
  assert.equal(r.flushed, 0);
  assert.equal(r.connection, 'token_expired');
  assert.equal(channel.sent.length, 0);
  assert.equal((await store.read()).outbox.length, 1, 'must survive expiry, not be dropped');
});

test('flush: ready window drains items and marks history accepted', async t => {
  const store = await seededStore(t);
  await enqueue(store, { notification_id: 'n1', title: 'T1', message: '内容一' });
  await enqueue(store, { notification_id: 'n2', message: '内容二' });
  const channel = mockChannel();
  const r = await flushOutbox(store, channel, { pacingMs: 0 });
  assert.equal(r.flushed, 2);
  assert.equal(channel.sent.length, 2);
  assert.equal(channel.sent[0].to, 'u1');
  assert.equal(channel.sent[0].ctx, 'ctx');
  assert.match(channel.sent[0].text, /T1\n\n内容一/);
  const s = await store.read();
  assert.equal(s.outbox.length, 0);
  assert.ok(s.notifications.every(n => n.status === 'accepted'));
});

test('flush: markdown bodies are converted then split into protocol-sized chunks', async t => {
  const store = await seededStore(t);
  const longMd = Array.from({ length: 40 }, (_, i) => `## 小节 ${i}\n\n${'内容句子。'.repeat(60)}`).join('\n\n');
  await enqueue(store, { notification_id: 'n1', message: longMd, format: 'markdown' });
  const channel = mockChannel();
  const r = await flushOutbox(store, channel, { pacingMs: 0 });
  assert.ok(r.flushed === 1);
  assert.ok(channel.sent.length > 1, 'long content must split into multiple messages');
  for (const s of channel.sent) {
    assert.ok(s.text.length <= 1800, `chunk exceeds limit: ${s.text.length}`);
    assert.ok(!/##/.test(s.text), 'markdown heading markers must be converted');
  }
});

test('flush: session rejection keeps the item queued and reports the error', async t => {
  const store = await seededStore(t);
  await enqueue(store, { notification_id: 'n1', message: 'later' });
  let fail = true;
  const channel = mockChannel({ fail: () => fail ? new ChannelError('SESSION_REQUIRED', 'x', { retryable: true, uncertain: false }) : null });
  const r = await flushOutbox(store, channel);
  assert.equal(r.flushed, 0);
  assert.equal(r.error, 'SESSION_REQUIRED');
  assert.equal((await store.read()).outbox.length, 1);

  fail = false; // window reopened → drains on next flush
  const r2 = await flushOutbox(store, channel);
  assert.equal(r2.flushed, 1);
});

test('flush: uncertain failures retry up to 3 attempts then mark unknown and drop', async t => {
  const store = await seededStore(t);
  await enqueue(store, { notification_id: 'n1', message: 'flaky' });
  const channel = mockChannel({ fail: () => new ChannelError('TIMEOUT', 'x', { uncertain: true, retryable: true }) });

  await flushOutbox(store, channel);
  assert.equal((await store.read()).outbox.length, 1, 'attempt 1 keeps the item');
  await flushOutbox(store, channel);
  assert.equal((await store.read()).outbox.length, 1, 'attempt 2 keeps the item');
  const r3 = await flushOutbox(store, channel);
  assert.equal(r3.error, 'TIMEOUT');
  const s = await store.read();
  assert.equal(s.outbox.length, 0, 'attempt 3 gives up');
  assert.equal(s.notifications[0].status, 'unknown', 'never retried under the same id again');
});

test('flush: server quota rejection (API_REJECTED/-2) KEEPS the item and reports how to unlock', async t => {
  const store = await seededStore(t);
  await enqueue(store, { notification_id: 'n1', message: 'will be refused by quota' });
  const channel = mockChannel({ fail: () => new ChannelError('API_REJECTED', 'x', { remoteCode: -2, uncertain: false }) });
  const r = await flushOutbox(store, channel, { pacingMs: 0 });
  assert.equal(r.flushed, 0);
  assert.equal(r.connection, 'rate_limited', 'quota refusal must read as rate_limited, not drop');
  const s = await store.read();
  assert.equal(s.outbox.length, 1, 'the item must survive — quota re-opens on the next user message');
  assert.equal(s.outbox[0].attempts, 1);
  assert.match(s.receiver.queueReason, /额度/);
  assert.equal(s.notifications[0].status, 'queued', 'must NOT be marked rejected');
});

test('flush: stale notifications expire instead of bursting on the user', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  await store.update(s => { s.account = readyAccount(); s.receiver = { enabled: false }; });
  const h = 60 * 60_000;
  await enqueue(store, { notification_id: 'old-1', message: 'yesterday news', now: Date.now() - 3 * h });
  await enqueue(store, { notification_id: 'old-2', message: 'older news', now: Date.now() - 10 * h });
  await enqueue(store, { notification_id: 'fresh', message: 'just finished', now: Date.now() - 60_000 });

  const channel = mockChannel();
  const r = await flushOutbox(store, channel, { pacingMs: 0 });
  assert.equal(r.flushed, 1, 'only the fresh item is delivered');
  assert.equal(channel.sent[0].text.includes('just finished'), true);
  const s = await store.read();
  assert.equal(s.outbox.length, 0);
  const expired = s.notifications.filter(n => n.status === 'expired');
  assert.equal(expired.length, 2, 'stale items are marked expired, never delivered');
});

test('flush: per-cycle budget spreads bursts across cycles', async t => {
  const store = await seededStore(t);
  for (let i = 0; i < 3; i++) await enqueue(store, { notification_id: `n${i}`, message: `m${i}` });
  const channel = mockChannel();
  const r1 = await flushOutbox(store, channel, { pacingMs: 0, maxPerCycle: 2 });
  assert.equal(r1.flushed, 2);
  assert.equal(r1.budget_exhausted, true);
  assert.equal(r1.remaining, 1);
  const r2 = await flushOutbox(store, channel, { pacingMs: 0, maxPerCycle: 2 });
  assert.equal(r2.flushed, 1);
  assert.equal(r2.budget_exhausted, undefined);
});

test('flush: partial chunk progress resumes without resending earlier chunks', async t => {
  const store = await seededStore(t);
  const longBody = Array.from({ length: 60 }, (_, i) => `第 ${i} 段 ` + '测试内容句子。'.repeat(30)).join('\n\n');
  await enqueue(store, { notification_id: 'n1', message: longBody });
  let sentCount = 0;
  const sent = [];
  const channel = {
    sendText: async (to, text) => {
      sentCount += 1;
      if (sentCount === 2) throw new ChannelError('SESSION_REQUIRED', 'window closed', { retryable: true, uncertain: false });
      sent.push({ text });
    },
  };
  await flushOutbox(store, channel);
  const partial = (await store.read()).outbox[0];
  assert.equal(partial.sentChunks, 1, 'first chunk recorded before the failure');
  assert.equal(sent.length, 1);

  const channel2 = mockChannel();
  await flushOutbox(store, channel2);
  const total = (await store.read()).outbox.length;
  assert.equal(total, 0, 'drains after resume');
  const resumedText = channel2.sent.map(s => s.text).join('\n');
  assert.ok(!resumedText.includes('第 0 段'), 'already-sent chunk must not be resent');
});
