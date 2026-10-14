import test from 'node:test';
import assert from 'node:assert/strict';
import { readiness, ingest, publicStatus, markBlocked, receiverRunning,
  WINDOW_MS, BLOCK_MS, FRESH_MS } from '../scripts/session.mjs';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function account(overrides = {}) {
  return { token: 'tok', base: 'https://ilinkai.weixin.qq.com', userId: 'u1', botId: 'b1',
    contextToken: 'ctx', lastInboundAt: NOW - HOUR, connectedAt: NOW - 2 * HOUR, ...overrides };
}

function message(overrides = {}) {
  return { message_type: 1, from_user_id: 'u1', to_user_id: 'b1', context_token: 'ctx-2',
    create_time_ms: NOW - 1000, item_list: [{ type: 1, text_item: { text: 'hello' } }], ...overrides };
}

test('readiness covers all six states without any local counter', () => {
  assert.equal(readiness(undefined, NOW), 'not_connected');
  assert.equal(readiness({ token: 't', authExpired: true }, NOW), 'login_required');
  assert.equal(readiness({ ...account(), blockedUntil: NOW + HOUR }, NOW), 'blocked');
  assert.equal(readiness({ ...account(), contextToken: undefined }, NOW), 'message_required');
  assert.equal(readiness({ ...account(), lastInboundAt: NOW - WINDOW_MS - 1 }, NOW), 'token_expired');
  assert.equal(readiness(account(), NOW), 'ready');
  // The old plugin's 10-message counter must not exist anywhere.
  const ready = account();
  assert.equal('sentInWindow' in ready, false);
  assert.equal(readiness({ ...ready, sentInWindow: 10 }, NOW), 'ready', 'a message counter must not gate readiness');
});

test('markBlocked applies a 60-minute -14 cooldown', () => {
  const state = { account: account() };
  markBlocked(state, NOW);
  assert.equal(state.account.blockedUntil, NOW + BLOCK_MS);
  assert.equal(readiness(state.account, NOW), 'blocked');
  assert.equal(readiness(state.account, NOW + BLOCK_MS), 'ready', 'cooldown lifts itself');
});

function stateWith(accountOverrides = {}) {
  return { version: 1, notifications: [], outbox: [], inbox: [],
    account: account(accountOverrides), receiver: { enabled: false } };
}

test('ingest refreshes the window from any valid inbound message', () => {
  const state = stateWith({ lastInboundAt: NOW - 23 * HOUR });
  const fresh = ingest(state, { msgs: [message({ context_token: 'fresh-token' })] }, NOW);
  assert.equal(fresh.length, 1);
  assert.equal(state.account.contextToken, 'fresh-token');
  assert.equal(state.account.lastInboundAt, NOW - 1000);
  assert.equal(readiness(state.account, NOW), 'ready');
  assert.equal(state.inbox.length, 1);
});

test('ingest dedups by message fingerprint', () => {
  const state = stateWith();
  const resp = { msgs: [message()] };
  ingest(state, resp, NOW);
  ingest(state, resp, NOW);
  assert.equal(state.inbox.length, 1);
  assert.equal(state.account.seen.length, 1);
});

test('stale messages refresh the window but do not enqueue tasks', () => {
  const state = stateWith({ lastInboundAt: NOW - 23 * HOUR });
  const fresh = ingest(state, { msgs: [message({ create_time_ms: NOW - FRESH_MS - 60_000 })] }, NOW);
  assert.equal(fresh.length, 0);
  assert.equal(state.inbox.length, 0);
  assert.ok(state.account.lastInboundAt > NOW - 23 * HOUR, 'window still refreshed');
});

test('ingest ignores foreign senders, groups, non-user types and token-less messages', () => {
  const state = stateWith();
  ingest(state, { msgs: [
    message({ from_user_id: 'someone-else' }),
    message({ group_id: 'g1' }),
    message({ message_type: 2 }),
    message({ context_token: undefined }),
    message({ to_user_id: 'another-bot' }),
  ] }, NOW);
  assert.equal(state.inbox.length, 0);
  assert.equal(state.account.contextToken, 'ctx', 'window must not move for foreign traffic');
  assert.equal(state.account.lastInboundAt, NOW - HOUR);
  assert.equal(state.account.seen.length, 0, 'foreign traffic must not burn dedup slots');
});

test('ingest persists the getupdates cursor', () => {
  const state = stateWith();
  ingest(state, { msgs: [], get_updates_buf: 'CURSOR-42' }, NOW);
  assert.equal(state.account.cursor, 'CURSOR-42');
});

test('a fresh inbound message lifts the -14 block (window reopened)', () => {
  const state = stateWith({ blockedUntil: NOW + 30 * 60_000 });
  ingest(state, { msgs: [message()] }, NOW);
  assert.equal(state.account.blockedUntil, undefined);
  assert.equal(readiness(state.account, NOW), 'ready');
});

test('ingest surfaces media and tool-call messages without decoding them yet', () => {
  const state = stateWith();
  const fresh = ingest(state, { msgs: [message({ item_list: [
    { type: 2, image_item: { media: { full_url: 'https://cdn/x' } } },
  ] })] }, NOW);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].has_media, true);
  assert.equal(fresh[0].text, '');

  const state2 = stateWith();
  const fresh2 = ingest(state2, { msgs: [message({ item_list: [
    { type: 11, tool_call_start: {} },
  ] })] }, NOW);
  assert.equal(fresh2[0].tool_calls, true);
});

test('publicStatus never leaks token or user identity', () => {
  const state = stateWith();
  state.receiver = { enabled: true, pid: process.pid, heartbeat: Date.now() };
  const json = JSON.stringify(publicStatus(state, NOW));
  assert.ok(!json.includes('tok'), 'token leaked');
  assert.ok(!json.includes('u1'), 'userId leaked');
  assert.ok(!json.includes('ctx'), 'context_token leaked');
  assert.equal(publicStatus(state, NOW).receiver, 'running');
});

test('receiverRunning requires a recent heartbeat from a live pid', () => {
  assert.equal(receiverRunning({ receiver: { enabled: true, pid: process.pid, heartbeat: Date.now() } }, NOW), true);
  assert.equal(receiverRunning({ receiver: { enabled: true, pid: process.pid, heartbeat: NOW - 100_000 } }, NOW), false);
  assert.equal(receiverRunning({ receiver: { enabled: false, pid: process.pid, heartbeat: Date.now() } }, NOW), false);
  assert.equal(receiverRunning({ receiver: { enabled: true, pid: 999_999_99, heartbeat: Date.now() } }, NOW), false);
});
