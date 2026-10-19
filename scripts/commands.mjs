import { publicStatus } from './session.mjs';

export const HELP = [
  '【微信 ↔ Codex 桥】可用指令:',
  '• 进度 / 状态 — 连接、窗口、队列与任务列表(任务有编号 #N)',
  '• 连接测试 — 探活',
  '• 停止 — 中止当前任务',
  '• 新任务 <描述> — 开新会话',
  '• 帮助 — 显示本条',
  '其余内容将作为任务交给 Codex 执行,结果以 #编号 回报。',
].join('\n');

/** Command word table — case-insensitive exact match; anything else is a task prompt. */
export function parseCommand(value) {
  const text = String(value ?? '').trim();
  const lower = text.toLowerCase();
  if (/^(帮助|\/帮助|\/help|help)$/.test(lower)) return { type: 'help' };
  if (/^(进度|\/进度|状态|\/状态|\/status|status)$/.test(lower)) return { type: 'status' };
  if (/^(停止|\/停止|\/stop|stop)$/.test(lower)) return { type: 'stop' };
  if (/^(连接测试|\/连接测试|\/ping|ping)$/.test(lower)) return { type: 'ping' };
  const newTask = text.match(/^(?:新任务|\/新任务|\/new)\s+([\s\S]+)$/i);
  if (newTask) return { type: 'new', prompt: newTask[1].trim() };
  return { type: 'prompt', prompt: text };
}

const ERROR_HINTS = {
  API_REJECTED: '服务器拒绝发送(多为窗口发送额度用完): 在微信里给 ClawBot 回一条消息即可解锁队列',
  AUTH_EXPIRED: '登录凭据失效,需要重新扫码绑定',
  RATE_LIMITED: '被微信限流,稍后自动重试',
  SESSION_EXPIRED: '会话过期冷却中(约 1 小时),发一条消息可提前恢复',
  NETWORK_ERROR: '网络波动,自动重试中',
};

const TASK_ICONS = { completed: '✅', failed: '❌', timed_out: '⏰', stopped: '🛑', interrupted: '⚠️' };

function taskLines(state) {
  const lines = [];
  const job = state.receiver?.job;
  if (job?.status === 'running' && job.no) {
    const mins = Math.max(1, Math.round((Date.now() - job.startedAt) / 60_000));
    lines.push(`进行中: #${job.no} ${job.name}(${mins} 分钟)`);
  }
  const recent = (state.tasks || []).filter(t => t.status !== 'running').slice(-4).reverse();
  if (recent.length) {
    lines.push('近期任务:');
    for (const t of recent) {
      const mins = t.finishedAt ? Math.max(1, Math.round((Date.now() - t.finishedAt) / 60_000)) : null;
      lines.push(`• #${t.no} ${t.name} ${TASK_ICONS[t.status] || ''}${mins ? ` ${mins} 分钟前` : ''}`);
    }
  }
  return lines;
}

export function statusText(state) {
  const s = publicStatus(state);
  const lines = [
    `连接: ${s.connection}`,
    `接收服务: ${s.receiver}`,
    `窗口剩余: ${s.window_remaining_ms > 0 ? Math.round(s.window_remaining_ms / 60_000) + ' 分钟' : (s.window_expired ? '已过期(发一条消息即恢复)' : '—')}`,
    `待发消息: ${s.pending_messages} 条入站 / ${s.pending_notifications} 条出站`,
  ];
  lines.push(...taskLines(state));
  if (s.blocked_until) lines.push(`风控冷却至: ${s.blocked_until}`);
  const hint = state.receiver?.queueReason || ERROR_HINTS[state.receiver?.lastError];
  if (hint) lines.push(`提示: ${hint}`);
  else if (s.last_error) lines.push(`最近错误: ${s.last_error}`);
  return lines.join('\n');
}

/**
 * P0 reply for task prompts: codex exec lands in P1; until then answer honestly.
 * Local commands (ping/status/help/stop) are fully handled here.
 */
export const PENDING_TASK_REPLY = '已收到你的消息。Codex 任务执行将在下一阶段接入,当前为协议链路验证。';
