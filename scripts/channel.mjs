import { randomBytes } from 'node:crypto';
import { Client, APIError, HTTPError, RequestError, NoContextTokenError } from '@openilink/openilink-sdk-node';
import { LocalError } from './store.mjs';

// Official channel version; bump alongside @tencent-weixin/openclaw-weixin releases.
export const DEFAULT_VERSION = process.env.ILINK_CHANNEL_VERSION || '2.4.10';
export const API_BASE = 'https://ilinkai.weixin.qq.com';

export function validatedBase(value) {
  let u;
  try { u = new URL(value); } catch { throw new LocalError('UNTRUSTED_HOST', '微信返回的接口地址无效。'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash ||
      !(u.hostname === 'ilinkai.weixin.qq.com' || u.hostname.endsWith('.weixin.qq.com'))) {
    throw new LocalError('UNTRUSTED_HOST', '微信接口地址未通过域名检查,连接已停止。');
  }
  return u.origin;
}

export class ChannelError extends LocalError {
  constructor(code, message, { remoteCode = null, uncertain = false, retryable = false } = {}) {
    super(code, message);
    this.remoteCode = remoteCode;
    this.uncertain = uncertain;   // true = request may or may not have been accepted remotely
    this.retryable = retryable;
  }
}

function sessionClassified(code, message, remoteCode) {
  if (code === -14) return new ChannelError('SESSION_EXPIRED', '微信会话已过期,已暂停发送 1 小时以防风控。', { remoteCode, uncertain: false });
  return new ChannelError('SESSION_REQUIRED', '微信要求刷新会话,请向 ClawBot 发一条消息后重试。', { remoteCode, retryable: true, uncertain: false });
}

// Parse an iLink response body and throw a classified error when ret/errcode is non-zero.
function assertPayloadOk(body, endpoint) {
  let payload;
  try { payload = JSON.parse(body); } catch {
    throw new ChannelError('INVALID_RESPONSE', '微信返回了无法识别的响应。', { uncertain: true, retryable: true });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ChannelError('INVALID_RESPONSE', '微信响应格式无效。', { uncertain: true, retryable: true });
  }
  for (const field of ['ret', 'errcode']) {
    if (payload[field] !== undefined && Number(payload[field]) !== 0) {
      const code = Number(payload[field]);
      const msg = String(payload.errmsg || '');
      if (code === -14) throw sessionClassified(-14, '', code);
      if (/context|session|24.?h|expired|limit|频|次数|过期/i.test(msg)) throw sessionClassified(code, '', code);
      if (/rate|too many|频繁/i.test(msg)) throw new ChannelError('RATE_LIMITED', `微信限流(错误码 ${code}),稍后自动重试。`, { remoteCode: code, retryable: true, uncertain: false });
      throw new ChannelError('API_REJECTED', `微信拒绝请求(错误码 ${Number.isFinite(code) ? code : '未知'})。`, { remoteCode: Number.isFinite(code) ? code : null, uncertain: false });
    }
  }
  return payload;
}

export function classify(error, depth = 0) {
  if (error instanceof ChannelError || error instanceof LocalError) return error;
  if (error instanceof HTTPError) {
    const status = error.statusCode;
    if (status === 401 || status === 403) return new ChannelError('AUTH_EXPIRED', '微信登录凭据已失效,请重新扫码绑定。', { remoteCode: status, uncertain: false });
    if (status === 429) return new ChannelError('RATE_LIMITED', '微信限流,稍后自动重试。', { remoteCode: status, uncertain: false, retryable: true });
    return new ChannelError('HTTP_ERROR', `微信接口返回 HTTP ${status}。`, { remoteCode: status, uncertain: status >= 500, retryable: status >= 500 });
  }
  if (error instanceof APIError) {
    if (error.isSessionExpired()) return sessionClassified(-14, '', -14);
    return new ChannelError('API_REJECTED', `微信拒绝请求(错误码 ${error.errCode})。`, { remoteCode: error.errCode, uncertain: false });
  }
  if (error instanceof RequestError) {
    if (error.isTimeout()) return new ChannelError('TIMEOUT', '等待微信响应超时。', { uncertain: true, retryable: true });
    return new ChannelError('NETWORK_ERROR', '暂时无法连接微信,请检查网络。', { uncertain: true, retryable: true });
  }
  if (error instanceof NoContextTokenError) {
    return new ChannelError('SESSION_REQUIRED', '尚无可用会话,请先向 ClawBot 发一条消息。', { retryable: true, uncertain: false });
  }
  // The SDK wraps failures (e.g. `ilink: upload media: <cause>`); unwrap typed causes
  // so a -14 buried three levels down still classifies as SESSION_EXPIRED.
  if (error?.cause && depth < 5 && error.cause !== error) {
    const inner = classify(error.cause, depth + 1);
    if (inner.code !== 'LOCAL_FAILURE') return inner;
  }
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    if (/timeout|aborted/i.test(error.message)) return new ChannelError('TIMEOUT', '等待微信响应超时。', { uncertain: true, retryable: true });
    if (/Failed to decode|not a JSON object/i.test(error.message)) return new ChannelError('INVALID_RESPONSE', '微信返回了无法识别的响应。', { uncertain: true, retryable: true });
    if (/fetch|network|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(error.message)) return new ChannelError('NETWORK_ERROR', '暂时无法连接微信,请检查网络。', { uncertain: true, retryable: true });
  }
  return new ChannelError('LOCAL_FAILURE', '本机协议操作失败。', {});
}

/**
 * iLink protocol channel on top of the OpeniLink SDK.
 * Adds: send-response validation (the SDK silently ignores ret/errcode on send),
 * redirect/host whitelist enforcement, presence endpoints, typed error classification.
 */
export class Channel {
  constructor({ fetchImpl, version = DEFAULT_VERSION } = {}) {
    this.client = new Client('', { ...(fetchImpl ? { fetch_impl: fetchImpl } : {}), version });
    this._installResponseCheck();
  }

  // The SDK's doPost returns the parsed HTTP body but callers (sendMessage/sendTyping)
  // discard it, so a business-level rejection would look like success. Patch the instance
  // method (runtime-visible despite TS `private`; the SDK's own tests patch it too).
  _installResponseCheck() {
    const client = this.client;
    const original = client.doPost.bind(client);
    client.doPost = async (endpoint, payload, timeoutMs) => {
      const response = await original(endpoint, payload, timeoutMs);
      if (endpoint === 'ilink/bot/sendmessage' || endpoint === 'ilink/bot/getconfig' ||
          endpoint === 'ilink/bot/sendtyping' || endpoint.startsWith('ilink/bot/msg/')) {
        assertPayloadOk(response.body, endpoint);
      }
      return response;
    };
  }

  get version() { return this.client.version; }

  setSession({ token, baseUrl }) {
    if (token) this.client.setToken(token);
    if (baseUrl) this.client.setBaseUrl(validatedBase(baseUrl));
  }

  restoreContextToken(userId, contextToken) {
    if (userId && contextToken) this.client.setContextToken(userId, contextToken);
  }

  generateClientId() {
    return `codex-wechat-bridge:${Date.now()}-${randomBytes(2).toString('hex')}`;
  }

  /** Send a text message; must carry a context_token from a recent inbound message. */
  async sendText(to, text, contextToken, { runId } = {}) {
    try {
      await this.client.sendMessage({
        from_user_id: '',
        to_user_id: to,
        client_id: this.generateClientId(),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken,
        ...(runId ? { run_id: runId } : {}),
      });
    } catch (e) { throw classify(e); }
  }

  /** Presence report (SDK has no endpoint for this; rides the patched doPost). */
  async presence(online) {
    try {
      await this.client.doPost(`ilink/bot/msg/${online ? 'notifystart' : 'notifystop'}`,
        { base_info: { channel_version: this.client.version } }, 5000);
    } catch (e) { throw classify(e); }
  }

  /**
   * Upload + send a media file (image/video/file). The SDK handles the whole
   * getuploadurl → AES-128-ECB → CDN upload → sendmessage chain.
   * caption (optional) is sent as a text message first by the SDK.
   */
  async sendMedia(to, contextToken, data, fileName, caption = '') {
    try {
      await this.client.sendMediaFile(to, contextToken, data, fileName, caption);
    } catch (e) { throw classify(e); }
  }

  /** Download + decrypt a CDN media payload to raw bytes. */
  async downloadMedia(media) {
    try { return await this.client.downloadMedia(media); }
    catch (e) { throw classify(e); }
  }

  async getConfig(userId, contextToken) {
    try { return await this.client.getConfig(userId, contextToken); }
    catch (e) { throw classify(e); }
  }

  async sendTyping(userId, typingTicket, status) {
    try { await this.client.sendTyping(userId, typingTicket, status); }
    catch (e) { throw classify(e); }
  }

  async fetchQRCode() {
    try { return await this.client.fetchQRCode(); }
    catch (e) { throw classify(e); }
  }

  /**
   * QR status poll with verify_code support (SDK's pollQRStatus has no verify_code
   * parameter) — builds the query itself via the SDK's doGetText (headers/auth stay
   * inside the SDK). Returns {status:'wait'} on long-poll timeout.
   */
  async pollQRStatus(qrcode, baseUrl, { verifyCode, timeoutMs = 35_000 } = {}) {
    const base = validatedBase(baseUrl || this.client.baseUrl);
    const url = new URL(`${base}/ilink/bot/get_qrcode_status`);
    url.searchParams.set('qrcode', qrcode);
    if (verifyCode) url.searchParams.set('verify_code', verifyCode);
    try {
      const response = await this.client.doGetText(url.toString(), {}, timeoutMs);
      let payload;
      try { payload = JSON.parse(response.body); } catch {
        throw new ChannelError('INVALID_RESPONSE', '微信返回了无法识别的响应。', { uncertain: true, retryable: true });
      }
      if (!payload || typeof payload !== 'object') {
        throw new ChannelError('INVALID_RESPONSE', '微信响应格式无效。', { uncertain: true, retryable: true });
      }
      return payload;
    } catch (e) {
      if (e instanceof RequestError && e.isTimeout()) return { status: 'wait' };
      throw classify(e);
    }
  }
}
