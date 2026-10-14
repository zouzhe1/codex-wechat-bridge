import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../scripts/store.mjs';
import { Channel, ChannelError } from '../scripts/channel.mjs';
import { worker, startWorker, stopWorker, makeLocalRunner } from '../scripts/worker.mjs';
import { flushOutbox } from '../scripts/outbox.mjs';
import { mockFetch, tempDir, cleanup } from './helpers.mjs';

async function waitFor(fn, ms = 5000, label = 'condition') {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${label}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

test('startWorker refuses to spawn without a bound account', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  await assert.rejects(() => startWorker(new Store(dir)), e => e.code === 'LOGIN_REQUIRED');
});

test('worker() exits early with login_required when no credentials exist', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const result = await worker({ store, channel: new Channel({ fetchImpl: async () => new Response('{}') }) });
  assert.deepEqual(result, { status: 'login_required' });
  // The worker lock must have been released on the early return.
  const release = await store.lock('worker', 100);
  await release();
});

test('stopWorker on an idle bridge reports stopped and marks the flag', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const r = await stopWorker(store);
  assert.equal(r.status, 'stopped');
  assert.equal((await store.read()).receiver.enabled, false);
});

test('localRunner answers ping with PONG using the inbound message context_token', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const sent = [];
  const channel = { sendText: async (to, text, ctx, opts) => { sent.push({ to, text, ctx, opts }); } };
  const runner = makeLocalRunner(store);
  const state = { account: { userId: 'u1' } };
  const item = { id: 'i1', context_token: 'ctx-x', run_id: 'run-x' };

  await runner(channel, state, item, { type: 'ping' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'u1');
  assert.match(sent[0].text, /^PONG/);
  assert.equal(sent[0].ctx, 'ctx-x');
  assert.deepEqual(sent[0].opts, { runId: 'run-x' });

  await runner(channel, state, item, { type: 'help' });
  assert.match(sent[1].text, /可用指令/);
});

test('localRunner queues a reply when the window refuses the send (never drops it)', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const channel = {
    sendText: async () => { throw new ChannelError('SESSION_REQUIRED', '需要新会话', { retryable: true }); },
  };
  const runner = makeLocalRunner(store);
  const state = { account: { userId: 'u1' } };

  const r = await runner(channel, state, { id: 'i9', context_token: 'ctx' }, { type: 'ping' });
  assert.equal(r.queued, true);
  assert.equal(r.error, 'SESSION_REQUIRED');
  const s = await store.read();
  assert.equal(s.outbox.length, 1);
  assert.equal(s.outbox[0].notification_id, 'reply:i9');
  assert.match(s.outbox[0].message, /PONG/);
});

test('localRunner rethrows non-retryable failures instead of jamming the outbox', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const channel = {
    sendText: async () => { throw new ChannelError('API_REJECTED', '拒绝', { remoteCode: -99, uncertain: false }); },
  };
  const runner = makeLocalRunner(store);
  await assert.rejects(
    () => runner(channel, { account: { userId: 'u1' } }, { id: 'i10', context_token: 'ctx' }, { type: 'ping' }),
    e => e.code === 'API_REJECTED',
  );
  assert.equal((await store.read()).outbox.length, 0);
});

test('M2 golden path: inbound task → busy guard → codex exec → result → flush delivers', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const now = Date.now();
  await store.update(s => {
    s.account = { token: 'tok', base: 'https://ilinkai.weixin.qq.com', userId: 'u1', botId: 'b1',
      contextToken: 'ctx', lastInboundAt: now - 1000, connectedAt: now - 10_000, cursor: '' };
    s.settings = { workspace: dir, sandbox: 'read-only' };
  });

  const sentTexts = [];
  const channel = new Channel({ fetchImpl: mockFetch(call => {
    if (call.url.includes('sendmessage')) sentTexts.push(call.body.msg.item_list[0].text_item.text);
    return { ret: 0 };
  }) });
  channel.presence = async () => {};

  const inbound = text => ({ message_type: 1, from_user_id: 'u1', to_user_id: 'b1',
    context_token: 'ctx-live', create_time_ms: Date.now(),
    item_list: [{ type: 1, text_item: { text } }] });
  channel.client.monitor = async (handler, opts) => {
    await handler(inbound('新任务 测试任务'));
    await handler(inbound('第二条任务来了'));
    while (opts.should_continue()) await new Promise(r => setTimeout(r, 50));
  };

  let resolveDone;
  const THREAD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const fakeCodex = ({ onEvent }) => {
    onEvent({ type: 'thread.started', threadId: THREAD });
    const done = new Promise(resolve => { resolveDone = () => resolve({ status: 'completed', threadId: THREAD, finalMessage: '## 结果\n\n任务完成正文。', resultPath: '' }); });
    return { child: { pid: 12_345, exitCode: null, signalCode: null }, stop() { resolveDone?.(); }, done };
  };

  let stopFn;
  const stopSignal = new Promise(resolve => { stopFn = resolve; });
  const wp = worker({ store, channel, codexRunner: fakeCodex, stopSignal });

  // start ack + busy reply go out directly (window is open)
  await waitFor(() => sentTexts.length >= 2, 5000, 'start ack + busy reply');
  assert.match(sentTexts[0], /已开始执行任务/);
  assert.match(sentTexts[1], /上一个任务还在运行/);

  // finish the fake codex → the result lands in the outbox
  resolveDone();
  const queued = await waitFor(async () => {
    const s = await store.read();
    return (s.outbox || []).find(o => o.notification_id.startsWith('result:'));
  }, 5000, 'result enqueued');
  assert.equal(queued.format, 'markdown');

  // flush delivers it as converted, chunked text
  const before = sentTexts.length;
  const r = await flushOutbox(store, channel);
  assert.equal(r.flushed, 1);
  const delivered = sentTexts.slice(before).join('\n');
  assert.match(delivered, /✅ Codex 任务完成/);
  assert.match(delivered, /任务完成正文/);
  assert.match(delivered, new RegExp(THREAD), 'thread id footer survives');
  assert.ok(!delivered.includes('##'), 'markdown markers converted');

  // bookkeeping
  const final = await store.read();
  assert.equal(final.receiver.threadId, THREAD, 'thread id persisted for resume');
  assert.equal(final.receiver.job.status, 'completed');
  assert.equal((final.messages || []).length, 2, 'inbound history recorded');
  assert.equal(final.outbox.length, 0);

  stopFn();
  const result = await wp;
  assert.equal(result.status, 'stopped');
  assert.equal((await store.read()).receiver.enabled, false);
});
