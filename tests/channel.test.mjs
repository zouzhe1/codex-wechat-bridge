import test from 'node:test';
import assert from 'node:assert/strict';
import { Channel, validatedBase, classify, ChannelError } from '../scripts/channel.mjs';
import { mockFetch } from './helpers.mjs';

test('validatedBase accepts the official host and weixin.qq.com subdomains', () => {
  assert.equal(validatedBase('https://ilinkai.weixin.qq.com'), 'https://ilinkai.weixin.qq.com');
  assert.equal(validatedBase('https://sub.weixin.qq.com'), 'https://sub.weixin.qq.com');
});

test('validatedBase rejects anything off-domain or not bare https origin', () => {
  const bad = [
    'http://ilinkai.weixin.qq.com',          // scheme
    'https://evil.example.com',              // foreign host
    'https://weixin.qq.com.evil.com',        // suffix trick
    'https://user@ilinkai.weixin.qq.com',    // userinfo
    'https://ilinkai.weixin.qq.com:8443',    // port
    'https://ilinkai.weixin.qq.com/path',    // path
    'https://ilinkai.weixin.qq.com?a=1',     // query
    'not a url',
  ];
  for (const url of bad) {
    assert.throws(() => validatedBase(url), e => e.code === 'UNTRUSTED_HOST', url);
  }
});

function bound(fetchImpl) {
  const channel = new Channel({ fetchImpl });
  channel.setSession({ token: 'tok-1', baseUrl: 'https://ilinkai.weixin.qq.com' });
  return channel;
}

test('sendText posts the iLink envelope with bearer auth and accepts ret:0', async () => {
  const fetchImpl = mockFetch(call => {
    assert.equal(call.method, 'POST');
    assert.match(call.url, /\/ilink\/bot\/sendmessage$/);
    assert.equal(call.headers.Authorization, 'Bearer tok-1');
    assert.equal(call.headers.AuthorizationType, 'ilink_bot_token');
    assert.equal(call.body.msg.message_type, 2);
    assert.equal(call.body.msg.item_list[0].text_item.text, '你好');
    assert.equal(call.body.msg.context_token, 'ctx-1');
    return { ret: 0 };
  });
  await bound(fetchImpl).sendText('user-1', '你好', 'ctx-1');
  assert.equal(fetchImpl.calls.length, 1);
});

test('sendText includes run_id when provided', async () => {
  const fetchImpl = mockFetch(call => { assert.equal(call.body.msg.run_id, 'run-9'); return { ret: 0 }; });
  await bound(fetchImpl).sendText('user-1', 'x', 'ctx', { runId: 'run-9' });
});

test('a session-flavoured rejection classifies as SESSION_REQUIRED (retryable)', async () => {
  const fetchImpl = mockFetch(() => ({ ret: -3, errmsg: 'context token expired, 24h' }));
  await assert.rejects(
    () => bound(fetchImpl).sendText('u', 'x', 'ctx'),
    e => e.code === 'SESSION_REQUIRED' && e.retryable === true,
  );
});

test('errcode -14 classifies as SESSION_EXPIRED', async () => {
  const fetchImpl = mockFetch(() => ({ ret: -14, errmsg: 'session expired' }));
  await assert.rejects(
    () => bound(fetchImpl).sendText('u', 'x', 'ctx'),
    e => e.code === 'SESSION_EXPIRED',
  );
});

test('an unrelated business rejection classifies as API_REJECTED (certain: the server said no)', async () => {
  const fetchImpl = mockFetch(() => ({ ret: -99, errmsg: 'mystery' }));
  await assert.rejects(
    () => bound(fetchImpl).sendText('u', 'x', 'ctx'),
    e => e.code === 'API_REJECTED' && e.remoteCode === -99 && e.uncertain === false,
  );
});

test('HTTP 429 → RATE_LIMITED (retryable), HTTP 401 → AUTH_EXPIRED', async () => {
  const limiter = mockFetch(() => new Response('slow down', { status: 429 }));
  await assert.rejects(() => bound(limiter).sendText('u', 'x', 'ctx'),
    e => e.code === 'RATE_LIMITED' && e.retryable === true);
  assert.equal(limiter.calls.length, 1);

  const unauthorized = mockFetch(() => new Response('nope', { status: 401 }));
  await assert.rejects(() => bound(unauthorized).sendText('u', 'x', 'ctx'),
    e => e.code === 'AUTH_EXPIRED');
});

test('an aborted fetch classifies as TIMEOUT (uncertain + retryable)', async () => {
  const fetchImpl = mockFetch(() => { throw new DOMException('The operation was aborted', 'AbortError'); });
  await assert.rejects(() => bound(fetchImpl).sendText('u', 'x', 'ctx'),
    e => e.code === 'TIMEOUT' && e.uncertain === true && e.retryable === true);
});

test('unparseable response body classifies as INVALID_RESPONSE', async () => {
  const fetchImpl = mockFetch(() => new Response('<html>oops</html>', { status: 200 }));
  await assert.rejects(() => bound(fetchImpl).sendText('u', 'x', 'ctx'),
    e => e.code === 'INVALID_RESPONSE');
});

test('presence posts to notifystart/notifystop through the validated host', async () => {
  const fetchImpl = mockFetch(call => {
    assert.match(call.url, /ilink\/bot\/msg\/notifystart$/);
    assert.equal(call.headers.Authorization, 'Bearer tok-1');
    return { ret: 0 };
  });
  await bound(fetchImpl).presence(true);
  const fetchImpl2 = mockFetch(call => {
    assert.match(call.url, /ilink\/bot\/msg\/notifystop$/);
    return { ret: 0 };
  });
  await bound(fetchImpl2).presence(false);
});

test('classify maps plain failures without leaking details', () => {
  const net = classify(new Error('fetch failed: ECONNREFUSED 1.2.3.4'));
  assert.equal(net.code, 'NETWORK_ERROR');
  const local = classify(new Error('boom'));
  assert.equal(local.code, 'LOCAL_FAILURE');
  assert.ok(local instanceof ChannelError);
  assert.ok(!local.message.includes('boom'));
});

test('typing chain: getConfig returns the ticket and sendTyping posts status', async () => {
  const fetchImpl = mockFetch(call => {
    if (call.url.includes('getconfig')) {
      assert.equal(call.body.ilink_user_id, 'u1');
      assert.equal(call.body.context_token, 'ctx');
      return { ret: 0, typing_ticket: 'ticket-1' };
    }
    if (call.url.includes('sendtyping')) {
      assert.equal(call.body.typing_ticket, 'ticket-1');
      assert.equal([1, 2].includes(call.body.status), true);
      return { ret: 0 };
    }
    throw new Error(`unexpected ${call.url}`);
  });
  const channel = bound(fetchImpl);
  const config = await channel.getConfig('u1', 'ctx');
  assert.equal(config.typing_ticket, 'ticket-1');
  await channel.sendTyping('u1', 'ticket-1', 1);
  await channel.sendTyping('u1', 'ticket-1', 2);
  assert.equal(fetchImpl.calls.length, 3);
});

test('typing surfaces business rejection (-14) through the shim', async () => {
  const fetchImpl = mockFetch(() => ({ ret: -14, errmsg: 'session expired' }));
  const channel = bound(fetchImpl);
  await assert.rejects(() => channel.getConfig('u1', 'ctx'), e => e.code === 'SESSION_EXPIRED');
});
