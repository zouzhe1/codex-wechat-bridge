import { createHash, randomUUID } from 'node:crypto';
import { LocalError } from './store.mjs';
import { readiness } from './session.mjs';
import { classify } from './channel.mjs';
import { mdToText } from './format.mjs';
import { chunk } from './chunker.mjs';

// Queued notifications survive window expiry for 7 days (the old plugin's proven TTL);
// history keeps hashes only — never bodies — for 30 days.
export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_MAX = 1000;
const OUTBOX_MAX = 50;
const MAX_TITLE = 80;
const MAX_BODY = 50_000;      // after chunking this is ~28 messages — plenty for a run summary
const UNCERTAIN_MAX_ATTEMPTS = 3;

const sha = t => createHash('sha256').update(t).digest('hex');

function normalizeTitle(title) {
  return String(title ?? '').replace(/\s*\n\s*/g, ' ').trim().slice(0, MAX_TITLE);
}

/**
 * Idempotent enqueue. Preserves the old plugin's double-hash contract:
 * same id + same body → duplicate (no second send); same id + different body → ID_CONFLICT.
 * Never throws SESSION_REQUIRED — an expired window simply means "queued".
 */
export async function enqueue(store, { notification_id, title = '', message, format = 'text', now = Date.now(), dryRun = false }) {
  if (typeof notification_id !== 'string' || notification_id.length < 1 || notification_id.length > 200) {
    throw new LocalError('INVALID_ID', 'notification_id 必须是 1-200 字符的稳定标识。');
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new LocalError('EMPTY_MESSAGE', '消息内容不能为空。');
  }
  if (message.length > MAX_BODY) {
    throw new LocalError('MESSAGE_TOO_LONG', `消息超过 ${MAX_BODY} 字符上限。`);
  }
  if (format !== 'text' && format !== 'markdown') {
    throw new LocalError('INVALID_FORMAT', 'format 只能是 text 或 markdown。');
  }
  const cleanTitle = normalizeTitle(title);
  const text = cleanTitle ? `${cleanTitle}\n\n${message}` : message;
  const idHash = sha(notification_id);
  const textHash = sha(text);
  if (dryRun) return { status: 'preview', preview: text.slice(0, 500), chars: text.length };

  return store.update(state => {
    const nowMs = now;
    state.notifications ||= [];
    state.outbox ||= [];
    // prune history: TTL then size
    state.notifications = state.notifications.filter(n => nowMs - n.at < HISTORY_TTL_MS);
    if (state.notifications.length >= HISTORY_MAX) state.notifications = state.notifications.slice(-HISTORY_MAX + 1);
    // prune outbox TTL
    state.outbox = state.outbox.filter(o => nowMs - o.createdAt < OUTBOX_TTL_MS);

    const existing = state.notifications.find(n => n.id === idHash);
    if (existing) {
      if (existing.textHash !== textHash) throw new LocalError('ID_CONFLICT', '同一 notification_id 已用于不同内容,拒绝重发。');
      return { status: existing.status, duplicate: true };
    }
    if (state.outbox.length >= OUTBOX_MAX) throw new LocalError('OUTBOX_FULL', `待发队列已满(${OUTBOX_MAX} 条)。`);

    state.notifications.push({
      id: idHash, textHash, status: 'queued',
      clientId: `cwb-${randomUUID()}`, at: nowMs,
    });
    state.outbox.push({
      notification_id, title: cleanTitle, message, format,
      createdAt: nowMs, attempts: 0, sentChunks: 0,
    });
    return { status: 'queued' };
  });
}

function compose(item) {
  const body = item.format === 'markdown' ? mdToText(item.message) : item.message;
  const text = item.title ? `${item.title}\n\n${body}` : body;
  return chunk(text);
}

async function markHistory(store, notificationId, patch) {
  const idHash = sha(notificationId);
  await store.update(state => {
    const entry = (state.notifications || []).find(n => n.id === idHash);
    if (entry) Object.assign(entry, patch);
  }).catch(() => {});
}

// Drain the outbox while the window is open.
// Three-bucket error policy:
//   server-said-later (SESSION_*, RATE_LIMITED, HTTP_ERROR, AUTH_EXPIRED) → keep queued;
//   uncertain (TIMEOUT, NETWORK, INVALID_RESPONSE) → retry up to 3 attempts, then mark
//     unknown+drop (never re-send under the same id after that — duplicates are worse
//     than a gap);
//   certain rejection (API_REJECTED, UNTRUSTED, …) → mark rejected+drop.
export async function flushOutbox(store, channel, { now = Date.now() } = {}) {
  const KEEP = new Set(['SESSION_REQUIRED', 'SESSION_EXPIRED', 'RATE_LIMITED', 'HTTP_ERROR', 'AUTH_EXPIRED', 'BUSY']);
  const first = await store.read();
  const connection = readiness(first.account, now);
  if (connection !== 'ready') return { flushed: 0, connection, remaining: (first.outbox || []).length };

  let flushed = 0;
  for (;;) {
    const snap = await store.read();
    if (readiness(snap.account, Date.now()) !== 'ready') return { flushed, connection: 'not_ready', remaining: (snap.outbox || []).length };
    snap.outbox = (snap.outbox || []).filter(o => Date.now() - o.createdAt < OUTBOX_TTL_MS);
    const item = snap.outbox[0];
    if (!item) return { flushed, connection: 'ready', remaining: 0 };

    try {
      const chunks = compose(item);
      for (let i = item.sentChunks || 0; i < chunks.length; i++) {
        await channel.sendText(snap.account.userId, chunks[i], snap.account.contextToken, { runId: snap.account.runId });
        await store.update(state => {
          const it = (state.outbox || []).find(o => o.notification_id === item.notification_id && o.createdAt === item.createdAt);
          if (it) it.sentChunks = i + 1;
        });
      }
      await store.update(state => {
        state.outbox = (state.outbox || []).filter(
          o => !(o.notification_id === item.notification_id && o.createdAt === item.createdAt));
      });
      await markHistory(store, item.notification_id, { status: 'accepted', updatedAt: Date.now() });
      flushed += 1;
      continue;
    } catch (e) {
      const err = classify(e);
      await store.update(state => { state.receiver ||= {}; state.receiver.lastError = err.code; }).catch(() => {});

      if (err.code === 'AUTH_EXPIRED') {
        await store.update(state => { if (state.account) state.account.authExpired = true; }).catch(() => {});
        return { flushed, connection: 'login_required', remaining: (await store.read()).outbox.length, error: err.code };
      }
      if (KEEP.has(err.code)) {
        return { flushed, connection: connectionOf(err), remaining: (await store.read()).outbox.length, error: err.code };
      }
      if (err.uncertain === true) {
        const attempts = (item.attempts || 0) + 1;
        if (attempts < UNCERTAIN_MAX_ATTEMPTS) {
          await store.update(state => {
            const it = (state.outbox || []).find(o => o.notification_id === item.notification_id && o.createdAt === item.createdAt);
            if (it) it.attempts = attempts;
          }).catch(() => {});
          return { flushed, connection: 'ready', remaining: (await store.read()).outbox.length, error: err.code };
        }
        await store.update(state => {
          state.outbox = (state.outbox || []).filter(
            o => !(o.notification_id === item.notification_id && o.createdAt === item.createdAt));
        });
        await markHistory(store, item.notification_id, { status: 'unknown', updatedAt: Date.now() });
        return { flushed, connection: 'ready', remaining: (await store.read()).outbox.length, error: err.code };
      }
      // certain rejection: drop so the queue cannot jam
      await store.update(state => {
        state.outbox = (state.outbox || []).filter(
          o => !(o.notification_id === item.notification_id && o.createdAt === item.createdAt));
      });
      await markHistory(store, item.notification_id, { status: 'rejected', updatedAt: Date.now(), remoteCode: err.remoteCode ?? null });
      continue;
    }
  }
}

function connectionOf(err) {
  if (err.code === 'SESSION_EXPIRED') return 'blocked';
  if (err.code === 'SESSION_REQUIRED') return 'message_required';
  if (err.code === 'RATE_LIMITED') return 'rate_limited';
  return 'ready';
}
