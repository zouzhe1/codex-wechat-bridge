#!/usr/bin/env node
/**
 * MCP stdio server for Codex (NDJSON — one JSON-RPC message per line).
 * Transport/error-model/schema-validation skeleton follows the proven clawbot design;
 * the tool table and actions are ours.
 *
 * Child guard: when spawned under a worker-initiated `codex exec`
 * (WECHAT_BRIDGE_CHILD=1) only wechat_status is callable — the bridge owns its own
 * lifecycle and result delivery, so the model cannot double-send or kill the worker.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Store, LocalError, publicError } from './store.mjs';
import { Channel, classify } from './channel.mjs';
import { publicStatus, receiverRunning } from './session.mjs';
import { enqueue } from './outbox.mjs';
import { loginStart, loginPoll } from './login.mjs';
import { startWorker, stopWorker } from './worker.mjs';

const SERVER_INFO = { name: 'codex-wechat-bridge', version: '0.1.0' };
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'];
const MAX_LINE = 64 * 1024;

const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = (description, extra = {}) => ({ type: 'string', description, ...extra });
const idArg = { type: 'string', minLength: 1, maxLength: 200,
  description: '可选的稳定幂等键(同 id 同内容只发一次;同 id 异内容报错)。不传则自动生成。' };

const TOOLS = [
  {
    name: 'wechat_status',
    description: '查看微信桥接状态: 连接、24h 窗口剩余、待发队列、接收服务、通知模式。只读,不产生任何发送。',
    inputSchema: object(),
    annotations: { readOnlyHint: true, title: '微信状态' },
  },
  {
    name: 'wechat_send_message',
    description: '向微信发送一条纯文本消息(会按段落自动分条)。消息进入队列,窗口开启即送达;接口接受不等于手机已收到。通知默认由插件自动发送,勿重复发送任务结果。',
    inputSchema: object({
      text: text('要发送的文本内容(1-50000 字符)。', { minLength: 1, maxLength: 50_000 }),
      id: idArg,
    }, ['text']),
    annotations: { title: '发送微信文本' },
  },
  {
    name: 'wechat_send_markdown',
    description: '向微信发送 Markdown 内容。微信不支持原生 Markdown,插件会把标题/列表/代码块转换成清晰的纯文本后分条发送。用途: 用户明确要求"微信通知我/发到微信"时发送任务结果。',
    inputSchema: object({
      markdown: text('Markdown 内容(1-50000 字符)。', { minLength: 1, maxLength: 50_000 }),
      id: idArg,
      title: text('首行标题(可选,≤80 字符)。', { maxLength: 80 }),
    }, ['markdown']),
    annotations: { title: '发送微信 Markdown' },
  },
  {
    name: 'wechat_send_image',
    description: '向微信发送一张本地图片(需窗口开启: 微信端最近 24 小时内发过消息)。需要 iLink CDN 加密上传,插件自动处理。窗口关闭时返回 session_required。',
    inputSchema: object({
      path: text('本机图片绝对路径(PNG/JPG/GIF/WebP,≤20MB)。', { minLength: 4, maxLength: 500 }),
      caption: text('附带说明文字(可选,会作为单独一条文本先发送)。', { maxLength: 1000 }),
      id: idArg,
    }, ['path']),
    annotations: { title: '发送微信图片' },
  },
  {
    name: 'wechat_send_file',
    description: '向微信发送一个本地文件(需窗口开启)。最大 20MB。窗口关闭时返回 session_required。',
    inputSchema: object({
      path: text('本机文件绝对路径(≤20MB)。', { minLength: 4, maxLength: 500 }),
      id: idArg,
    }, ['path']),
    annotations: { title: '发送微信文件' },
  },
  {
    name: 'wechat_read_messages',
    description: '读取最近从微信收到的消息(最近 20 条)。用于了解用户在微信端说了什么。',
    inputSchema: object({
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: '返回条数。' },
    }),
    annotations: { readOnlyHint: true, title: '读取微信消息' },
  },
  {
    name: 'wechat_typing',
    description: '在微信会话中显示"正在输入"指示(iLink 原生能力)。需要窗口开启。',
    inputSchema: object(),
    annotations: { title: '正在输入' },
  },
  {
    name: 'wechat_login',
    description: '获取微信扫码登录二维码,返回本机 PNG 绝对路径(把路径给用户扫)。已有绑定时需显式 reconnect。',
    inputSchema: object({
      reconnect: { type: 'boolean', default: false, description: 'true=重新绑定(先停止接收服务)。' },
    }),
    annotations: { title: '微信扫码登录' },
  },
  {
    name: 'wechat_login_poll',
    description: '轮询扫码状态。手机扫码确认后返回 connected;若返回 need_verifycode,再带 code 调用一次。',
    inputSchema: object({
      code: { type: 'string', pattern: '^\\d{4,12}$', description: '手机上显示的 4-12 位数字验证码。' },
      wait_seconds: { type: 'integer', minimum: 1, maximum: 30, default: 25, description: '长轮询等待秒数。' },
    }),
    annotations: { title: '轮询扫码状态' },
  },
  {
    name: 'wechat_start',
    description: '启动微信后台接收服务(常驻)。收到消息、清空队列都依赖它。',
    inputSchema: object(),
    annotations: { title: '启动微信接收' },
  },
  {
    name: 'wechat_stop',
    description: '停止微信后台接收服务。',
    inputSchema: object(),
    annotations: { title: '停止微信接收' },
  },
].map(tool => ({ annotations: { title: tool.name }, ...tool }));

function typeOk(value, type) {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return true;
}

export function validateArgs(schema, args) {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  const props = schema.properties || {};
  const allowed = new Set(Object.keys(props));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new LocalError('INVALID_ARGS', `未知参数: ${key}`);
  }
  for (const req of schema.required || []) {
    if (value[req] === undefined) throw new LocalError('INVALID_ARGS', `缺少参数: ${req}`);
  }
  for (const [key, def] of Object.entries(props)) {
    let v = value[key];
    if (v === undefined) {
      if (def.default !== undefined) value[key] = def.default;
      continue;
    }
    if (Array.isArray(def.enum) && !def.enum.includes(v)) throw new LocalError('INVALID_ARGS', `${key} 必须是 ${def.enum.join('/')} 之一`);
    if (def.type && !typeOk(v, def.type)) throw new LocalError('INVALID_ARGS', `${key} 类型应为 ${def.type}`);
    if (typeof v === 'number') {
      if (def.minimum !== undefined && v < def.minimum) throw new LocalError('INVALID_ARGS', `${key} 不能小于 ${def.minimum}`);
      if (def.maximum !== undefined && v > def.maximum) throw new LocalError('INVALID_ARGS', `${key} 不能大于 ${def.maximum}`);
    }
    if (typeof v === 'string') {
      if (def.minLength !== undefined && v.length < def.minLength) throw new LocalError('INVALID_ARGS', `${key} 太短`);
      if (def.maxLength !== undefined && v.length > def.maxLength) throw new LocalError('INVALID_ARGS', `${key} 太长`);
      if (def.pattern && !new RegExp(def.pattern).test(v)) throw new LocalError('INVALID_ARGS', `${key} 格式不正确`);
    }
  }
  return value;
}

// Worker-initiated codex exec children may read status and push media, but never
// control the bridge or send text (result delivery is the worker's job — no double-send).
const CHILD_ALLOWED = new Set(['wechat_status', 'wechat_send_image', 'wechat_send_file']);

export async function callTool(name, rawArgs, { store = new Store(), channel = new Channel() } = {}) {
  if (process.env.WECHAT_BRIDGE_CHILD === '1' && !CHILD_ALLOWED.has(name)) {
    throw new LocalError('CHILD_CONTROL_DISABLED', '微信任务子进程不能控制桥接服务或重复发送文本。');
  }
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new LocalError('UNKNOWN_TOOL', `未知工具: ${name}`);
  const args = validateArgs(tool.inputSchema, rawArgs);

  switch (name) {
    case 'wechat_status': {
      const s = await store.read();
      return { ...publicStatus(s), job: s.receiver?.job, messages_saved: (s.messages || []).length };
    }
    case 'wechat_send_message':
      return enqueue(store, { notification_id: args.id || `tool:${randomUUID()}`, message: args.text, format: 'text' });
    case 'wechat_send_markdown':
      return enqueue(store, { notification_id: args.id || `tool:${randomUUID()}`, message: args.markdown, title: args.title || '', format: 'markdown' });
    case 'wechat_send_image':
    case 'wechat_send_file': {
      const s = await store.read();
      if (!s.account?.token) throw new LocalError('LOGIN_REQUIRED', '请先扫码绑定微信。');
      if (!s.account.contextToken) {
        return { status: 'message_required', message: '尚无会话: 请先在微信里给 ClawBot 发一条消息,再发送媒体。' };
      }
      const file = path.resolve(args.path);
      let data;
      try { data = await fs.readFile(file); }
      catch { throw new LocalError('FILE_UNREADABLE', `无法读取文件: ${file}`); }
      if (data.length > 20 * 1024 * 1024) throw new LocalError('FILE_TOO_LARGE', '媒体文件超过 20MB 上限。');
      channel.setSession({ token: s.account.token, baseUrl: s.account.base });
      try {
        if (name === 'wechat_send_image' && args.caption) {
          await channel.sendText(s.account.userId, args.caption, s.account.contextToken, { runId: s.account.runId });
        }
        await channel.sendMedia(s.account.userId, s.account.contextToken, data, path.basename(file), '');
        return { status: 'sent', delivery_verified: false, message: '微信接口已接受媒体;没有手机已收到回执。' };
      } catch (e) {
        const err = classify(e);
        if (['SESSION_REQUIRED', 'SESSION_EXPIRED', 'RATE_LIMITED'].includes(err.code)) {
          return { status: 'message_required', error: err.code, message: err.message };
        }
        if (err.uncertain === true) return { status: 'unknown', error: err.code, message: err.message };
        throw err;
      }
    }
    case 'wechat_read_messages': {
      const s = await store.read();
      const messages = (s.messages || []).slice(-args.limit);
      return { count: messages.length, messages };
    }
    case 'wechat_typing': {
      const s = await store.read();
      if (!s.account?.token) throw new LocalError('LOGIN_REQUIRED', '请先扫码绑定微信。');
      if (!s.account.contextToken) throw new LocalError('SESSION_REQUIRED', '尚无会话,请先在微信里发一条消息。');
      channel.setSession({ token: s.account.token, baseUrl: s.account.base });
      try {
        const config = await channel.getConfig(s.account.userId, s.account.contextToken);
        if (!config.typing_ticket) return { sent: false, reason: 'no_typing_ticket' };
        await channel.sendTyping(s.account.userId, config.typing_ticket, 1);
        setTimeout(() => { channel.sendTyping(s.account.userId, config.typing_ticket, 2).catch(() => {}); }, 2000).unref?.();
        return { sent: true };
      } catch (e) {
        const err = classify(e);
        if (['SESSION_REQUIRED', 'SESSION_EXPIRED', 'AUTH_EXPIRED'].includes(err.code)) {
          return { sent: false, error: err.code, message: err.message };
        }
        throw err;
      }
    }
    case 'wechat_login':
      return loginStart(store, channel, { reconnect: !!args.reconnect });
    case 'wechat_login_poll':
      return loginPoll(store, channel, { verifyCode: args.code, waitSeconds: args.wait_seconds ?? 25 });
    case 'wechat_start':
      return startWorker(store);
    case 'wechat_stop':
      return stopWorker(store);
    default:
      throw new LocalError('UNKNOWN_TOOL', `未知工具: ${name}`);
  }
}

export async function dispatch(request, deps) {
  const { id, method, params } = request;
  switch (method) {
    case 'initialize':
      return { protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} }, serverInfo: SERVER_INFO,
        instructions: [
          '这是微信(iLink)桥接工具。行为契约:',
          '1. 任务完成通知默认由插件自动发送(notify 钩子),不要主动重复发送任务结果。',
          '2. 仅当用户明确要求"微信通知我/发到微信"时调用 wechat_send_markdown。',
          '3. 微信端只显示纯文本,Markdown 会由插件转换;接口返回 queued/accepted 不等于手机已收到。',
          '4. 幂等: 重要通知传稳定 id(任务ID+事件);unknown/rejected 状态不得换 id 重发。',
          '5. 登录二维码只返回文件路径,不要输出图片内容或凭据。',
        ].join('\n') };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const data = await callTool(String(params?.name), params?.arguments, deps);
      return { content: [{ type: 'text', text: JSON.stringify(data) }],
        isError: data && typeof data === 'object' && ['unknown', 'rejected'].includes(data.status) ? true : undefined };
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
  }
}

export function startServer({ store = new Store(), channel = new Channel() } = {}) {
  const write = value => { process.stdout.write(`${JSON.stringify(value)}\n`); };
  const handle = async request => {
    const { id } = request;
    if (id === undefined || id === null) return; // notification (e.g. notifications/initialized)
    try {
      const result = await dispatch(request, { store, channel });
      write({ jsonrpc: '2.0', id, result });
    } catch (e) {
      if (e.rpcCode) write({ jsonrpc: '2.0', id, error: { code: e.rpcCode, message: e.message } });
      else if (e instanceof LocalError || e?.code) {
        write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(publicError(e)) }], isError: true } });
      } else {
        write({ jsonrpc: '2.0', id, error: { code: -32603, message: publicError(e).message } });
      }
    }
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > MAX_LINE * 2) { buffer = ''; write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } }); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      if (line.length > MAX_LINE) { write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } }); continue; }
      let request;
      try { request = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0') {
        write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        continue;
      }
      void handle(request);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === selfPath) startServer();
