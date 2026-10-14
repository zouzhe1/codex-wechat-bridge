import { publicStatus } from './session.mjs';

export const HELP = [
  '【微信 ↔ Codex 桥】可用指令:',
  '• 进度 / 状态 — 查看连接与任务状态',
  '• 连接测试 — 探活',
  '• 停止 — 中止当前任务',
  '• 新任务 <描述> — 开新会话',
  '• 帮助 — 显示本条',
  '其余内容将作为任务交给 Codex 执行。',
].join('\n');

/** Command word table — case-insensitive exact match; anything else is a task prompt. */
export function parseCommand(value) {
  const text = String(value ?? '').trim();
  const lower = text.toLowerCase();
  if (/^(帮助|\/help|help)$/.test(lower)) return { type: 'help' };
  if (/^(进度|状态|\/status|status)$/.test(lower)) return { type: 'status' };
  if (/^(停止|\/stop|stop)$/.test(lower)) return { type: 'stop' };
  if (/^(连接测试|\/ping|ping)$/.test(lower)) return { type: 'ping' };
  const newTask = text.match(/^(?:新任务|\/new)\s+([\s\S]+)$/i);
  if (newTask) return { type: 'new', prompt: newTask[1].trim() };
  return { type: 'prompt', prompt: text };
}

export function statusText(state) {
  const s = publicStatus(state);
  const lines = [
    `连接: ${s.connection}`,
    `接收服务: ${s.receiver}`,
    `窗口剩余: ${s.window_remaining_ms > 0 ? Math.round(s.window_remaining_ms / 60_000) + ' 分钟' : (s.window_expired ? '已过期(发一条消息即恢复)' : '—')}`,
    `待发消息: ${s.pending_messages} 条入站 / ${s.pending_notifications} 条出站`,
  ];
  if (s.blocked_until) lines.push(`风控冷却至: ${s.blocked_until}`);
  if (s.last_error) lines.push(`最近错误: ${s.last_error}`);
  return lines.join('\n');
}

/**
 * P0 reply for task prompts: codex exec lands in P1; until then answer honestly.
 * Local commands (ping/status/help/stop) are fully handled here.
 */
export const PENDING_TASK_REPLY = '已收到你的消息。Codex 任务执行将在下一阶段接入,当前为协议链路验证。';
