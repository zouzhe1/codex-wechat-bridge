import { createHash } from 'node:crypto';
import { isAlive } from './store.mjs';

// Window tracking is *observational*: we never refuse to send because of a local
// counter (the old plugin's fatal design). The only gates are protocol facts:
// a context_token is required, and errcode -14 means the server froze us.
export const WINDOW_MS = 24 * 60 * 60 * 1000;   // context_token lifetime (server-side)
export const BLOCK_MS = 60 * 60 * 1000;         // -14 cooldown, mirrors official session-guard
export const FRESH_MS = 5 * 60_000;             // inbound older than this won't run tasks (still refreshes the window)
export const SEEN_KEEP = 200;

function digest(text) { return createHash('sha256').update(text).digest('hex'); }

/** One of: not_connected | login_required | blocked | message_required | token_expired | ready */
export function readiness(account, now = Date.now()) {
  if (!account?.token) return 'not_connected';
  if (account.authExpired) return 'login_required';
  if (account.blockedUntil && now < account.blockedUntil) return 'blocked';
  if (!account.contextToken || !account.lastInboundAt) return 'message_required';
  if (now - account.lastInboundAt >= WINDOW_MS) return 'token_expired';
  return 'ready';
}

export function receiverRunning(state, now = Date.now()) {
  const r = state.receiver;
  return !!(r?.enabled && isAlive(r.pid) && r.heartbeat && now - r.heartbeat < 90_000);
}

/** Public status — never exposes token / userId / message bodies. */
export function publicStatus(state, now = Date.now()) {
  const account = state.account;
  const ready = readiness(account, now);
  const windowRemaining = account?.lastInboundAt
    ? Math.max(0, account.lastInboundAt + WINDOW_MS - now)
    : 0;
  return {
    connection: ready,
    bound: !!account?.token,
    window_remaining_ms: windowRemaining,
    window_expired: ready === 'token_expired',
    blocked_until: account?.blockedUntil && now < account.blockedUntil
      ? new Date(account.blockedUntil).toISOString() : undefined,
    pending_messages: (state.inbox || []).length,
    pending_notifications: (state.outbox || []).length,
    receiver: receiverRunning(state, now) ? 'running' : 'stopped',
    last_error: state.receiver?.lastError,
    notify_mode: state.settings?.notify_mode || 'on-demand',
    has_cursor: typeof account?.cursor === 'string' && account.cursor.length > 0,
  };
}

export function markBlocked(state, now = Date.now()) {
  state.account ||= {};
  state.account.blockedUntil = now + BLOCK_MS;
}

/**
 * A successful getupdates response proves the bot_token is still valid — clear any
 * authExpired flag a transient 401/403 may have left behind. Without this, one
 * flaky request permanently bricks the session with "请重新扫码".
 */
export function clearAuthFlag(state) {
  if (state.account?.authExpired) state.account.authExpired = false;
}

/**
 * Inbound message ingestion: refreshes the window (context_token / lastInboundAt),
 * dedups, and returns fresh executable inbox items.
 *
 * `response` is the full getupdates payload ({msgs, get_updates_buf, ...}).
 * Differences from the old plugin: no sentInWindow counter, no sessionBlocked flag,
 * stale messages still refresh the window (they simply don't execute tasks).
 */
export function ingest(state, response, now = Date.now()) {
  const account = state.account;
  const fresh = [];
  if (!account?.token) return fresh;
  account.seen ||= [];
  state.inbox ||= [];
  const list = (Array.isArray(response?.msgs) ? response.msgs : [])
    .slice()
    .sort((a, b) => (a.create_time_ms || 0) - (b.create_time_ms || 0));
  for (const m of list) {
    if (m.message_type !== 1 || m.from_user_id !== account.userId || m.group_id || !m.context_token ||
        (m.to_user_id && m.to_user_id !== account.botId)) continue;
    const time = Number(m.create_time_ms);
    if (!Number.isFinite(time) || time <= 0 || time > now + 60_000 || time < (account.lastInboundAt || 0)) continue;
    const id = digest(JSON.stringify([m.message_id ?? m.client_id ?? m.seq, time, m.context_token]));
    if (account.seen.includes(id)) continue;
    account.seen = [...account.seen.slice(-199), id];

    // Any valid inbound message re-opens the window — this is the *only* renewal path.
    account.contextToken = m.context_token;
    account.runId = m.run_id || undefined;
    account.lastInboundAt = time;
    delete account.blockedUntil;

    const items = m.item_list || [];
    // text = text items + voice transcriptions (voice_item.text arrives server-side)
    const text = items
      .filter(i => (i.type === 1 && typeof i.text_item?.text === 'string') ||
        (i.type === 3 && typeof i.voice_item?.text === 'string'))
      .map(i => (i.text_item ?? i.voice_item).text).join('\n').trim();
    // media descriptors are captured whole; hydration (download to disk) happens
    // in the consume loop so the poll loop never blocks on network I/O
    const media = [];
    for (const i of items) {
      if (i.type === 2 && i.image_item?.media) {
        media.push({ kind: 'image', media: i.image_item.media, name: 'image' });
      } else if (i.type === 4 && i.file_item?.media) {
        media.push({ kind: 'file', media: i.file_item.media, name: i.file_item.file_name || 'file' });
      } else if (i.type === 5 && i.video_item?.media) {
        media.push({ kind: 'video', media: i.video_item.media, name: 'video' });
      }
    }
    const hasToolCall = items.some(i => i.type === 11 || i.type === 12);

    if ((text || media.length || hasToolCall) && now - time < FRESH_MS && time >= (account.connectedAt || 0) - 10_000) {
      fresh.push({
        id, at: time,
        text: text.slice(0, 20_000),
        has_media: media.length > 0,
        media: media.length ? media : undefined,
        tool_calls: hasToolCall,
        context_token: m.context_token,
        run_id: m.run_id,
        message_id: m.message_id,
      });
    }
  }
  if (typeof response?.get_updates_buf === 'string') account.cursor = response.get_updates_buf;
  state.inbox = [...state.inbox, ...fresh].slice(-20);
  return fresh;
}
