import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Route-aware fetch mock: handler(call) → object | Response. Records every call. */
export function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    let body;
    if (options?.body !== undefined && options?.body !== null) {
      try { body = JSON.parse(options.body); } catch { body = String(options.body).slice(0, 64); } // binary CDN payloads
    }
    const call = { url: String(url), method: options?.method, headers: options?.headers || {}, body };
    calls.push(call);
    const out = await handler(call, options);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Queue-based handler: shift the next scripted reply per matcher, else repeat the last. */
export function sequenced(matcher, replies) {
  const queue = [...replies];
  return call => {
    if (!matcher(call)) throw new Error(`unexpected request: ${call.method} ${call.url}`);
    return queue.length > 1 ? queue.shift() : queue[0];
  };
}

export async function tempDir(prefix = 'cwb-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

export const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
