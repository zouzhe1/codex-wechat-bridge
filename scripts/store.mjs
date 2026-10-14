import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export class LocalError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export class Store {
  constructor(directory = process.env.WECHAT_BRIDGE_STATE_DIR || path.join(os.homedir(), '.codex-wechat-bridge')) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, 'state.json');
  }
  async ensure() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(this.directory, 0o700);
  }
  async read() {
    try {
      const s = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (s.version !== 1 || !Array.isArray(s.notifications)) throw new Error('invalid');
      return s;
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, notifications: [], outbox: [], inbox: [], receiver: { enabled: false } };
      throw new LocalError('STATE_INVALID', '本机连接记录无法读取,请检查状态文件;插件不会覆盖它。');
    }
  }
  async write(state) {
    await this.ensure();
    const tmp = path.join(this.directory, `.state-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, this.file);
    } finally { await fs.rm(tmp, { force: true }); }
  }
  async lock(name = 'state', waitMs = 3000) {
    await this.ensure();
    const file = path.join(this.directory, `${name}.lock`);
    const nonce = randomUUID();
    const deadline = Date.now() + waitMs;
    do {
      try {
        const fd = await fs.open(file, 'wx', 0o600);
        try { await fd.writeFile(JSON.stringify({ pid: process.pid, nonce })); } finally { await fd.close(); }
        return async () => {
          try {
            if (JSON.parse(await fs.readFile(file, 'utf8')).nonce === nonce) await fs.unlink(file);
          } catch (e) { if (e.code !== 'ENOENT') throw e; }
        };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const owner = JSON.parse(await fs.readFile(file, 'utf8'));
          if (!isAlive(owner.pid)) { await fs.unlink(file); continue; }
        } catch (err) {
          if (err.code === 'ENOENT') continue;
          // A just-created lock may not have its owner written yet.
          const st = await fs.stat(file).catch(() => null);
          if (st && Date.now() - st.mtimeMs > 120_000) { await fs.unlink(file).catch(() => {}); continue; }
        }
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } while (Date.now() <= deadline);
    throw new LocalError('BUSY', '另一个微信操作正在进行,请稍后重试。');
  }
  async update(fn) {
    const release = await this.lock();
    try {
      const state = await this.read();
      const result = await fn(state);
      await this.write(state);
      return result;
    } finally { await release(); }
  }
}

export function publicError(error) {
  return error instanceof LocalError
    ? { code: error.code, message: error.message }
    : { code: 'LOCAL_FAILURE', message: '本机操作失败。请检查目录权限或运行环境;详细凭据不会输出。' };
}
