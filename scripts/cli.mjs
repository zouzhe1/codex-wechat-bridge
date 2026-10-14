#!/usr/bin/env node
import path from 'node:path';
import { Store, publicError } from './store.mjs';
import { Channel } from './channel.mjs';
import { loginStart, loginPoll } from './login.mjs';
import { publicStatus } from './session.mjs';
import { enqueue, flushOutbox } from './outbox.mjs';
import { startWorker, stopWorker } from './worker.mjs';

const USAGE = `用法: node scripts/cli.mjs <命令> [选项]

命令:
  login [--reconnect]                获取登录二维码(输出 qr_path)
  login-poll [--code N] [--wait S]   轮询扫码结果(code=手机显示的验证码,wait=1-30 秒)
  status                             查看连接/窗口/队列状态
  start                              启动微信接收服务(后台)
  stop                               停止微信接收服务
  notify-mode [on-demand|always]     查看或设置任务完成通知策略(默认 on-demand)
  notify-forward [-- <命令> <参数>...] 查看/设置/清除 notify 转发(通知单槽位,保住原插件的处理程序)
                                     示例: notify-forward -- "C:\...\codex-computer-use.exe" turn-ended
                                     清除: notify-forward -- clear
  configure [--workspace <目录>] [--sandbox read-only|workspace-write]
                                     查看或修改任务执行配置
  send [--markdown] <文本>           手动入队一条测试消息(窗口开启即发送)
  flush                              立即尝试清空待发队列
  help                               显示本帮助`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reconnect') flags.reconnect = true;
    else if (a === '--markdown') flags.markdown = true;
    else if (a === '--code') flags.code = argv[++i];
    else if (a === '--wait') flags.wait = Number(argv[++i]);
    else if (a === '--workspace') flags.workspace = argv[++i];
    else if (a === '--sandbox') flags.sandbox = argv[++i];
    else positional.push(a);
  }
  return { flags, positional };
}

const [command, ...rest] = process.argv.slice(2);
const { flags, positional } = parseArgs(rest);
const store = new Store();
const channel = new Channel();

try {
  let result;
  switch (command) {
    case 'login':
      result = await loginStart(store, channel, { reconnect: !!flags.reconnect });
      break;
    case 'login-poll':
      result = await loginPoll(store, channel, {
        verifyCode: flags.code,
        ...(Number.isInteger(flags.wait) ? { waitSeconds: flags.wait } : {}),
      });
      break;
    case 'status':
      result = publicStatus(await store.read());
      break;
    case 'start':
      result = await startWorker(store);
      break;
    case 'stop':
      result = await stopWorker(store);
      break;
    case 'notify-mode': {
      const mode = positional[0];
      if (!mode) {
        const s = await store.read();
        result = { notify_mode: s.settings?.notify_mode || 'on-demand' };
      } else {
        if (!['on-demand', 'always'].includes(mode)) throw new Error('notify-mode 只能是 on-demand 或 always');
        await store.update(s => { s.settings ||= {}; s.settings.notify_mode = mode; });
        result = { notify_mode: mode };
      }
      break;
    }
    case 'notify-forward': {
      const argv = positional[0] === '--' ? positional.slice(1) : positional;
      if (argv.length === 0) {
        const s = await store.read();
        result = { notify_forward: s.settings?.notify_forward || null };
        break;
      }
      if (argv.length === 1 && argv[0] === 'clear') {
        await store.update(s => { if (s.settings) delete s.settings.notify_forward; });
        result = { notify_forward: null };
        break;
      }
      await store.update(s => {
        s.settings ||= {};
        s.settings.notify_forward = argv;
      });
      result = { notify_forward: argv };
      break;
    }
    case 'configure': {
      const s = await store.read();
      const settings = s.settings || {};
      if (!flags.workspace && !flags.sandbox) {
        result = { settings: { workspace: settings.workspace || null, sandbox: settings.sandbox || 'workspace-write',
          notify_mode: settings.notify_mode || 'on-demand' } };
        break;
      }
      if (flags.sandbox && !['read-only', 'workspace-write'].includes(flags.sandbox)) {
        throw new Error('sandbox 只能是 read-only 或 workspace-write');
      }
      await store.update(state => {
        state.settings ||= {};
        if (flags.workspace) state.settings.workspace = path.resolve(flags.workspace);
        if (flags.sandbox) state.settings.sandbox = flags.sandbox;
      });
      const after = await store.read();
      result = { settings: after.settings };
      break;
    }
    case 'send': {
      const text = positional.join(' ').trim();
      if (!text) throw new Error('send 需要文本内容');
      result = await enqueue(store, {
        notification_id: `manual:${Date.now()}`,
        message: text,
        format: flags.markdown ? 'markdown' : 'text',
      });
      break;
    }
    case 'flush':
      result = await flushOutbox(store, channel);
      break;
    case 'help':
    case undefined:
      console.log(USAGE);
      process.exit(command ? 0 : 1);
      break;
    default:
      console.error(`未知命令: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  if (command === 'login' && result.status === 'scan_required') {
    console.error(`二维码已保存: ${result.qr_path}`);
  }
} catch (e) {
  const err = publicError(e);
  console.error(JSON.stringify({ error: err.code, message: err.message }, null, 2));
  process.exit(1);
}
