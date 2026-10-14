import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalError } from './store.mjs';
import { validatedBase, classify, API_BASE } from './channel.mjs';
import { receiverRunning } from './session.mjs';
import { saveQr } from './qr.mjs';

const PENDING_TTL_MS = 5 * 60_000;
const MAX_QR_REFRESH = 3;

/** Step 1: mint a login QR (or reuse a fresh pending one) and persist `state.pending`. */
export async function loginStart(store, channel, { reconnect = false } = {}) {
  const release = await store.lock('login');
  try {
    const s = await store.read();
    if (s.account?.token && !s.account.authExpired && !reconnect) {
      return { status: 'connected', message: '已有微信绑定;重新绑定请明确使用 reconnect。' };
    }
    if (receiverRunning(s)) throw new LocalError('BRIDGE_RUNNING', '请先停止微信接收服务再重新绑定。');
    if (s.pending && Date.now() - s.pending.createdAt < PENDING_TTL_MS) {
      return { status: 'scan_required', qr_path: path.join(store.directory, s.pending.qrFilename || 'login-qr.png'),
        expires_at: new Date(s.pending.createdAt + 300_000).toISOString() };
    }
    const qr = await channel.fetchQRCode();
    if (typeof qr.qrcode !== 'string' || typeof qr.qrcode_img_content !== 'string' || qr.qrcode_img_content.length > 4000) {
      throw new LocalError('QR_INVALID', '微信未返回有效的登录二维码。');
    }
    await store.ensure();
    const qrFilename = `login-${randomUUID()}.png`;
    const qrPath = path.join(store.directory, qrFilename);
    const size = await saveQr(qr.qrcode_img_content, qrPath);
    const createdAt = Date.now();
    await store.update(state => {
      state.pending = { qrcode: qr.qrcode, base: validatedBase(channel.client.baseUrl || API_BASE), createdAt, qrFilename, refreshes: 1 };
    });
    return { status: 'scan_required', qr_path: qrPath, ...size,
      expires_at: new Date(createdAt + 300_000).toISOString(),
      message: '用手机微信扫描二维码并确认;如显示数字验证码,请用 login-poll --code 提供。' };
  } finally { await release(); }
}

/**
 * Step 2: poll the pending QR once. Handles the full official status set:
 * wait / scaned / scaned_but_redirect(whitelist-checked) / expired(auto-refresh ≤3) /
 * need_verifycode / verify_code_blocked / bimed_redirect / confirmed.
 */
export async function loginPoll(store, channel, { verifyCode, waitSeconds = 25 } = {}) {
  if (verifyCode !== undefined && !/^\d{4,12}$/.test(String(verifyCode))) {
    throw new LocalError('INVALID_CODE', '验证码应为微信显示的 4 至 12 位数字。');
  }
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 30) {
    throw new LocalError('INVALID_WAIT', '等待时间应为 1 至 30 秒。');
  }
  const release = await store.lock('login');
  try {
    const s = await store.read();
    const p = s.pending;
    if (!p) return { status: s.account?.token ? 'connected' : 'no_login' };

    const r = await channel.pollQRStatus(p.qrcode, p.base, { verifyCode, timeoutMs: waitSeconds * 1000 });

    switch (r.status) {
      case 'confirmed': {
        if (!r.bot_token || !r.ilink_bot_id || !r.ilink_user_id) {
          throw new LocalError('LOGIN_INCOMPLETE', '登录响应缺少本人身份或凭据,未建立连接。');
        }
        const base = validatedBase(r.baseurl || p.base);
        await store.update(state => {
          state.account = {
            token: r.bot_token, botId: r.ilink_bot_id, userId: r.ilink_user_id, base,
            generation: randomUUID(), connectedAt: Date.now(), cursor: '', seen: [],
            authExpired: false,
          };
          state.inbox = [];
          delete state.pending;
        });
        await fs.rm(path.join(store.directory, path.basename(p.qrFilename || 'login-qr.png')), { force: true });
        return { status: 'connected', message: '扫码绑定成功。' };
      }
      case 'scaned_but_redirect': {
        if (!r.redirect_host) return { status: 'scaned' };
        const base = validatedBase(`https://${r.redirect_host}`); // throws UNTRUSTED_HOST for anything off-domain
        await store.update(state => { if (state.pending?.qrcode === p.qrcode) state.pending.base = base; });
        return { status: 'scaned', message: '微信正在确认登录,请继续检查。' };
      }
      case 'binded_redirect': {
        if (!s.account?.token || s.account.authExpired) {
          throw new LocalError('BOUND_ELSEWHERE', '微信显示已有绑定,但本机没有可用凭据,请解除旧连接后重新扫码。');
        }
        await store.update(state => { delete state.pending; });
        return { status: 'connected', message: '继续使用本机已有微信绑定。' };
      }
      case 'expired':
      case 'verify_code_blocked': {
        // Auto-refresh the QR up to MAX_QR_REFRESH times instead of giving up (clawbot
        // deletes the pending entry here, which forces a manual restart — we don't).
        const refreshes = (p.refreshes || 1) + 1;
        if (refreshes > MAX_QR_REFRESH) {
          await store.update(state => { delete state.pending; });
          await fs.rm(path.join(store.directory, path.basename(p.qrFilename || 'login-qr.png')), { force: true });
          return { status: 'expired', message: '二维码刷新次数已用尽,请重新发起登录。' };
        }
        await fs.rm(path.join(store.directory, path.basename(p.qrFilename || 'login-qr.png')), { force: true });
        const qr = await channel.fetchQRCode();
        if (typeof qr.qrcode !== 'string' || typeof qr.qrcode_img_content !== 'string') {
          throw new LocalError('QR_INVALID', '微信未返回有效的登录二维码。');
        }
        const qrFilename = `login-${randomUUID()}.png`;
        const qrPath = path.join(store.directory, qrFilename);
        await saveQr(qr.qrcode_img_content, qrPath);
        await store.update(state => {
          if (state.pending?.qrcode === p.qrcode) {
            state.pending = { qrcode: qr.qrcode, base: p.base, createdAt: Date.now(), qrFilename, refreshes };
          }
        });
        return { status: 'scan_required', qr_path: qrPath,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          message: `二维码已过期并自动刷新(第 ${refreshes}/${MAX_QR_REFRESH} 次),请扫描新二维码。` };
      }
      case 'need_verifycode':
        return { status: 'need_verifycode', message: '请提供手机微信显示的数字验证码(login-poll --code)。' };
      case 'scaned':
        return { status: 'scaned', message: '已扫描,请在手机上确认。' };
      case 'wait':
      case undefined:
        return { status: 'wait' };
      default:
        return { status: 'wait', message: `未识别的状态 ${r.status},继续等待。` };
    }
  } catch (e) {
    if (e?.code === 'TIMEOUT') return { status: 'wait' };
    throw classify(e);
  } finally { await release(); }
}
