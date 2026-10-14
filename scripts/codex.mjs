import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LocalError } from './store.mjs';

export async function findCodex() {
  if (process.env.WECHAT_BRIDGE_CODEX_BIN) return process.env.WECHAT_BRIDGE_CODEX_BIN;
  if (process.platform === 'win32') {
    // Bundled CLI: %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe (newest wins).
    const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    try {
      let best = null; let bestMtime = 0;
      for (const entry of await fs.readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(base, entry.name, 'codex.exe');
        const stat = await fs.stat(candidate).catch(() => null);
        if (stat && stat.mtimeMs > bestMtime) { best = candidate; bestMtime = stat.mtimeMs; }
      }
      if (best) return best;
    } catch { /* fall through */ }
  }
  if (process.platform === 'darwin') {
    for (const executable of ['/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex']) {
      if (await fs.access(executable).then(() => true, () => false)) return executable;
    }
  }
  return 'codex';
}

export function codexArgs({ workspace, sandbox = 'workspace-write', threadId, resultPath }) {
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw new LocalError('INVALID_SANDBOX', '微信任务只支持只读或工作目录可写模式。');
  if (!path.isAbsolute(workspace)) throw new LocalError('INVALID_WORKSPACE', '任务目录必须是绝对路径。');
  const args = ['exec', '--sandbox', sandbox, '-C', workspace, '-c', 'approval_policy="never"',
    '--skip-git-repo-check', '--color', 'never'];
  if (threadId) {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new LocalError('INVALID_THREAD', '保存的 Codex 任务编号无效。');
    args.push('resume');
  }
  args.push('--json', '--output-last-message', resultPath);
  if (threadId) args.push(threadId);
  args.push('-');
  return args;
}

export function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
    timer.unref();
  }
}

export function runCodex({ executable, workspace, sandbox, threadId, resultPath, prompt, onEvent = () => {}, timeoutMs = 60 * 60_000 }, spawnImpl = spawn) {
  const args = codexArgs({ workspace, sandbox, threadId, resultPath });
  const child = spawnImpl(executable, args, { cwd: workspace, shell: false, detached: process.platform !== 'win32',
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, WECHAT_BRIDGE_CHILD: '1' } });
  let stopped = false; let timedOut = false; let output = ''; let session = threadId; let finalMessage = '';
  const stop = () => { stopped = true; stopProcessTree(child); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs); timer.unref();
  const done = new Promise(resolve => {
    let settled = false;
    const finish = async code => {
      if (settled) return; settled = true; clearTimeout(timer);
      try {
        const stat = await fs.stat(resultPath);
        if (stat.size < 1024 * 1024) finalMessage = await fs.readFile(resultPath, 'utf8');
        await fs.chmod(resultPath, 0o600);
      } catch {}
      resolve({ status: timedOut ? 'timed_out' : stopped ? 'stopped' : code === 0 ? 'completed' : 'failed',
        threadId: session, finalMessage: finalMessage.trim(), resultPath });
    };
    child.once('error', () => { void finish(-1); });
    child.once('close', code => { void finish(code); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      output += data;
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'thread.started' && /^[0-9a-f-]{36}$/i.test(event.thread_id || '')) session = event.thread_id;
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') finalMessage = event.item.text || finalMessage;
          onEvent({ threadId: session, type: event.type, itemType: event.item?.type });
        } catch {}
      }
      if (output.length > 1024 * 1024) output = '';
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(`你正在处理扫码绑定用户本人从微信发来的任务。默认用中文简洁回复。结果会由微信桥接插件自动转发,不要调用微信工具重复转发、启动接收服务或修改插件状态。按工作目录中的项目规则执行;遇到需要额外权限的步骤,说明具体阻碍,不要绕过权限。\n\n用户消息:\n${prompt}`);
  });
  return { child, stop, done };
}
