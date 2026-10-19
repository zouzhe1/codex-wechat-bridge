import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, HELP, statusText, PENDING_TASK_REPLY } from '../scripts/commands.mjs';

test('parseCommand recognises the local command table (case-insensitive)', () => {
  assert.deepEqual(parseCommand('帮助'), { type: 'help' });
  assert.deepEqual(parseCommand('/HELP'), { type: 'help' });
  assert.deepEqual(parseCommand('状态'), { type: 'status' });
  assert.deepEqual(parseCommand('/状态'), { type: 'status' });
  assert.deepEqual(parseCommand('/进度'), { type: 'status' });
  assert.deepEqual(parseCommand('/status'), { type: 'status' });
  assert.deepEqual(parseCommand('停止'), { type: 'stop' });
  assert.deepEqual(parseCommand('/停止'), { type: 'stop' });
  assert.deepEqual(parseCommand('连接测试'), { type: 'ping' });
  assert.deepEqual(parseCommand('/连接测试'), { type: 'ping' });
  assert.deepEqual(parseCommand('  ping  '), { type: 'ping' });
  assert.deepEqual(parseCommand('新任务 优化 README'), { type: 'new', prompt: '优化 README' });
  assert.deepEqual(parseCommand('/新任务 优化 README'), { type: 'new', prompt: '优化 README' });
});

test('anything else becomes a task prompt — including shell-looking text', () => {
  assert.deepEqual(parseCommand('$(touch /tmp/pwned)'), { type: 'prompt', prompt: '$(touch /tmp/pwned)' });
  assert.deepEqual(parseCommand('请不要停止任务'), { type: 'prompt', prompt: '请不要停止任务' });
  assert.deepEqual(parseCommand(''), { type: 'prompt', prompt: '' });
});

test('statusText reports window state and never exposes credentials', () => {
  const state = {
    version: 1, notifications: [], outbox: [{ notification_id: 'n' }], inbox: [{ id: 1 }],
    account: { token: 'SECRET-TOKEN', userId: 'SECRET-USER', contextToken: 'SECRET-CTX',
      lastInboundAt: Date.now() - 1000 },
    receiver: { enabled: true, pid: process.pid, heartbeat: Date.now() },
  };
  const text = statusText(state);
  assert.ok(text.includes('连接: ready'));
  assert.ok(text.includes('接收服务: running'));
  assert.ok(!text.includes('SECRET'), 'credentials leaked into status text');
  assert.ok(PENDING_TASK_REPLY.length > 0 && HELP.includes('连接测试'));
});

test('statusText lists the running task and recent task history', () => {
  const now = Date.now();
  const state = {
    version: 1, notifications: [], outbox: [], inbox: [],
    account: { token: 't', userId: 'u', contextToken: 'c', lastInboundAt: now - 1000 },
    receiver: { enabled: true, pid: process.pid, heartbeat: now,
      job: { no: 7, name: '重构登录模块', status: 'running', startedAt: now - 5 * 60_000 } },
    tasks: [
      { no: 5, name: '查看目录结构', status: 'completed', finishedAt: now - 60 * 60_000 },
      { no: 6, name: '修复打包脚本', status: 'failed', finishedAt: now - 30 * 60_000 },
      { no: 7, name: '重构登录模块', status: 'running', startedAt: now - 5 * 60_000 },
    ],
  };
  const text = statusText(state);
  assert.ok(text.includes('进行中: #7 重构登录模块(5 分钟)'), text);
  assert.ok(text.includes('近期任务:'), text);
  assert.ok(text.includes('• #6 修复打包脚本 ❌ 30 分钟前'), text);
  assert.ok(text.includes('• #5 查看目录结构 ✅ 60 分钟前'), text);
  assert.ok(!/#[0-9a-f]{8}-/.test(text), 'no raw UUIDs may reach the user');
});
