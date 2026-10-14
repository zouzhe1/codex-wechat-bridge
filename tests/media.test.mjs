import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../scripts/store.mjs';
import { Channel } from '../scripts/channel.mjs';
import { hydrateMedia, mediaPrompt } from '../scripts/media.mjs';
import { ingest } from '../scripts/session.mjs';
import { mockFetch, tempDir, cleanup } from './helpers.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test('sendMedia runs the full upload chain: getuploadurl → CDN → sendmessage', async () => {
  const seen = [];
  const fetchImpl = mockFetch(call => {
    seen.push(call.url);
    if (call.url.includes('getuploadurl')) return { ret: 0, upload_param: 'p', upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload' };
    if (call.url.includes('cdn.weixin.qq.com')) {
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'enc-query-1' } });
    }
    if (call.url.includes('sendmessage')) {
      const items = call.body.msg.item_list;
      assert.equal(call.body.msg.message_type, 2);
      assert.ok(items.length === 1 || items.some(i => i.image_item), 'image item must be sent');
      return { ret: 0 };
    }
    return { ret: 0 };
  });
  const channel = new Channel({ fetchImpl });
  channel.setSession({ token: 'tok', baseUrl: 'https://ilinkai.weixin.qq.com' });
  await channel.sendMedia('u1', 'ctx', PNG, 'shot.png', '');
  assert.ok(seen.some(u => u.includes('getuploadurl')), 'upload url requested');
  assert.ok(seen.some(u => u.includes('cdn.weixin.qq.com')), 'CDN upload hit');
  assert.ok(seen.some(u => u.includes('sendmessage')), 'sendmessage hit');
});

test('sendMedia surfaces CDN rejection through the classifier', async () => {
  const fetchImpl = mockFetch(call => {
    if (call.url.includes('getuploadurl')) return { ret: -14, errmsg: 'session expired' };
    return { ret: 0 };
  });
  const channel = new Channel({ fetchImpl });
  channel.setSession({ token: 'tok', baseUrl: 'https://ilinkai.weixin.qq.com' });
  await assert.rejects(() => channel.sendMedia('u1', 'ctx', PNG, 'a.png'), e => e.code === 'SESSION_EXPIRED');
});

test('hydrateMedia downloads to disk, sniffs extensions and strips CDN payloads', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const channel = { downloadMedia: async media => {
    assert.ok(media.full_url, 'CDN media passed through');
    return PNG;
  } };
  const item = { id: 'abcdef0123456789x', media: [
    { kind: 'image', media: { full_url: 'https://cdn/x' }, name: 'screenshot' },
    { kind: 'file', media: { full_url: 'https://cdn/y' }, name: '报告.docx' },
  ] };
  await hydrateMedia(channel, store, item);
  assert.ok(item.media[0].path.endsWith('.png'), item.media[0].path);
  assert.ok(item.media[1].path.endsWith('.docx'), item.media[1].path);
  assert.equal(item.media[0].media, undefined, 'CDN payload dropped after download');
  const bytes = await fs.readFile(item.media[0].path);
  assert.deepEqual(bytes, PNG);
});

test('hydrateMedia records an error code when download fails', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const store = new Store(dir);
  const { ChannelError } = await import('../scripts/channel.mjs');
  const channel = { downloadMedia: async () => { throw new ChannelError('TIMEOUT', 'x', { uncertain: true, retryable: true }); } };
  const item = { id: 'deadbeef01234567x', media: [{ kind: 'image', media: { full_url: 'https://cdn/x' }, name: 'x' }] };
  await hydrateMedia(channel, store, item);
  assert.equal(item.media[0].error, 'TIMEOUT');
  assert.equal(item.media[0].path, undefined);
});

test('mediaPrompt turns media-only messages into an actionable task', () => {
  const withPath = mediaPrompt({ media: [{ kind: 'image', path: 'C:/tmp/a.png' }] });
  assert.ok(withPath.includes('C:/tmp/a.png'));
  assert.ok(withPath.includes('图片'));
  const failed = mediaPrompt({ media: [{ kind: 'video', error: 'TIMEOUT' }] });
  assert.ok(failed.includes('下载失败'));
  assert.equal(mediaPrompt({ media: [] }), '');
});

test('ingest captures media descriptors and voice transcriptions', () => {
  const now = 1_700_000_000_000;
  const state = { version: 1, notifications: [], outbox: [], inbox: [],
    account: { token: 't', userId: 'u1', botId: 'b1', contextToken: 'ctx',
      lastInboundAt: now - 1000, connectedAt: now - 10_000 } };
  const fresh = ingest(state, { msgs: [{ message_type: 1, from_user_id: 'u1', to_user_id: 'b1',
    context_token: 'c2', create_time_ms: now - 500, item_list: [
      { type: 2, image_item: { media: { full_url: 'https://cdn/img' } } },
      { type: 4, file_item: { media: { full_url: 'https://cdn/f' }, file_name: 'data.csv' } },
      { type: 5, video_item: {} }, // no media → not captured
    ] }] }, now);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].has_media, true);
  assert.equal(fresh[0].media.length, 2, 'only items with CDN media are captured');
  assert.equal(fresh[0].media[1].name, 'data.csv');

  const state2 = { ...state, inbox: [] };
  const fresh2 = ingest(state2, { msgs: [{ message_type: 1, from_user_id: 'u1', to_user_id: 'b1',
    context_token: 'c3', create_time_ms: now - 400, item_list: [
      { type: 3, voice_item: { text: '这是语音转写', media: {} } },
    ] }] }, now);
  assert.equal(fresh2[0].text, '这是语音转写', 'voice transcription enters the text pipeline');
});
