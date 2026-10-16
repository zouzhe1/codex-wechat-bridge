# codex-wechat-bridge

[![check](https://github.com/zouzhe1/codex-wechat-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/zouzhe1/codex-wechat-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522-blue)
![tests](https://img.shields.io/badge/tests-115%20passing-brightgreen)

把 OpenAI Codex 接进微信 —— 基于**腾讯官方 iLink 协议**(微信 ClawBot 插件的底层 Bot 协议,非逆向)。

- **任务完成自动通知**(Codex `notify` 钩子,拿结果全文;默认按需、可切全量)
- **双向对话**: 手机微信发消息 → Codex 执行 → 结果回微信(thread 延续、忙守卫、停止指令)
- **Markdown 自动转微信排版**并分条发送(不叠行、不句中截断)
- **收发图片/文件/视频**、语音收取(转写)、typing 指示、扫码登录
- **24h 窗口排队**: 窗口关闭消息入队(7 天)+ 桌面气泡提醒"发一条消息即解锁",绝不静默丢弃
- **看门狗**: supervisor 崩溃/挂死自愈、开机自启(install.ps1)、-14 风控冷却 60 分钟

13 项协议功能逐项核对见 [FEATURES.md](./FEATURES.md);114 项离线测试 `npm run check`。

## 要求

- Node.js ≥ 22(Windows / macOS / Linux)
- 微信 v8.0.70+ 且可用 ClawBot 插件(逐步放量中)
- Codex CLI(通知与 exec 调用)
- ⚠️ **同一微信号同一时间只能绑定一个 iLink 连接**(官方 ClawBot 插件、本桥、其他 iLink 工具三选一)

## 快速开始

```bash
npm install                 # 装唯一依赖 @openilink/openilink-sdk-node
node scripts/cli.mjs login  # 输出 qr_path,用手机微信扫码并在手机上确认
node scripts/cli.mjs login-poll   # 轮询直到 connected(手机显示数字码时加 --code 123456)
node scripts/cli.mjs start  # 启动接收服务(supervisor + worker,后台)
node scripts/cli.mjs status # 检查连接/窗口/队列
```

### 1. 任务完成通知(config.toml 必加一行)

```toml
# ~/.codex/config.toml
notify = ["node", "D:/path/to/codex-wechat-bridge/scripts/notify.mjs"]
```

- 默认 `on-demand`: **只有微信发起的任务**完成后自动通知,TUI 里普通回话不打扰;用户说"微信通知我"时模型调 MCP 工具发送。
- 想每个回话都通知: `node scripts/cli.mjs notify-mode always`(幂等键防重,子进程自动跳过防双发)。

> **⚠️ `notify` 是单槽位字段(整个 config.toml 只有一行)**。如果你已有别的插件在用(比如 computer-use 的 `codex-computer-use.exe turn-ended`),先把**原命令**登记为转发目标,再把 notify 行换成我们的脚本——我们的 notify 会把事件原样转发给它,互不影响:
>
> ```bash
> node scripts/cli.mjs notify-forward -- "C:\Users\你\AppData\Local\OpenAI\Codex\...\codex-computer-use.exe" turn-ended
> ```
>
> 查看/清除: `notify-forward`(无参) / `notify-forward -- clear`。

### 2. 双向消息 / 工具(二选一)

**方式 A — 装插件(推荐)**

```bash
codex plugin marketplace add zouzhe1/codex-wechat-bridge
codex plugin install wechat-bridge@wechat-bridge
```

**方式 B — 手配 config.toml**

```toml
[mcp_servers.wechat]
command = "node"
args = ["D:/path/to/codex-wechat-bridge/scripts/mcp-server.mjs"]
default_tools_approval_mode = "approve"
tool_timeout_sec = 60
```

MCP 工具: `wechat_status` / `wechat_send_message` / `wechat_send_markdown` / `wechat_send_image` / `wechat_send_file` / `wechat_read_messages` / `wechat_typing` / `wechat_login` / `wechat_login_poll` / `wechat_start` / `wechat_stop`。

### 3. 开机自启(可选但推荐)

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1    # 注册启动项(隐藏窗口,supervisor 看门狗)
powershell -ExecutionPolicy Bypass -File uninstall.ps1  # 卸载
```

实现: 当前用户启动文件夹(`shell:startup`)里的 `codex-wechat-bridge.vbs` 以隐藏窗口拉起 supervisor——**无需管理员**(schtasks ONLOGON 需要提权,故不采用)。日志: `~/.codex-wechat-bridge/worker.log`。

### 4. 任务执行配置

```bash
node scripts/cli.mjs configure --workspace D:/your/project --sandbox workspace-write
```

## 微信里能用的指令

| 发送 | 作用 |
|---|---|
| `连接测试` / `ping` | 探活,回 PONG |
| `状态` / `进度` | 连接、窗口、队列与**任务列表**(每个任务有编号 #N 和名字) |
| `新任务 <描述>` | 开新 Codex 会话 |
| `停止` | 终止当前任务 |
| `帮助` | 指令列表 |
| 其余任意文字 | 作为任务交给 Codex 执行;开始/完成通知都带 `#编号 任务名`,不再出现无意义的 UUID |
| 图片/文件 | 自动下载落盘并作为任务素材交给 Codex |

## 关于 24 小时窗口(重要预期管理)

iLink 是**被动应答**协议: 必须你先发消息,bot 才能在 24h 内回复(`context_token` 是服务端下发的回话凭证)。这是微信服务端规则,任何中间层都改不了——**本插件不骗你**:

- 窗口内: 全实时。但实测服务器有**每窗口发送额度**(连续发十余条后返回错误码 `-2`,第三方接入文档描述为"每 10 次下发后需用户再发起一次对话")。额度用完消息自动排队,你在微信里**回任意一条消息**即可解锁,队列 60 秒内补发。
- 排队消息只保留 **2 小时新鲜度**(可调),更早的自动过期——第二天醒来被昨天的旧通知轰炸不是我们想要的行为。
- 窗口关闭/额度用完/风控冷却: 桌面气泡提醒原因和解锁方法,绝不静默吞消息。
- **三级自愈**: supervisor 看门狗(崩溃/挂死自动重启)→ Codex notify 钩子(每个回合结束巡检复活)→ MCP 工具调用(顺手复活)。电脑不重启也能自愈;重启后由启动文件夹的 VBS 拉起。
- 单次 401/403 不再永久标记"需要重新扫码"——一次成功的长轮询即自动治愈误报;只有凭据真正失效才要求重新登录。

## 目录

```
scripts/    notify.mjs(Codex钩子) mcp-server.mjs worker.mjs supervisor.mjs
            channel/login/session(协议) outbox(队列) format+chunker(Markdown)
            media(收发媒体) codex.mjs(exec) cli.mjs toast.mjs store.mjs
skills/     wechat-bridge/SKILL.md(模型行为契约)
tests/      114 项离线测试(node --test + fetch 注入 mock)
.codex-plugin/plugin.json  .mcp.json  .agents/plugins/marketplace.json
install.ps1 / uninstall.ps1
```

## FAQ

**为什么过 24 小时没消息了?** 见上文窗口说明。看 `node scripts/cli.mjs status` 的 `window_remaining_ms`;桌面气泡会在队列积压时提醒。

**手机发 ping 没反应?** `status` 里 `receiver` 应为 `running`;不是则 `node scripts/cli.mjs start`。装了 install.ps1 后重启电脑自动恢复;崩溃由 supervisor 自动重启(日志 `~/.codex-wechat-bridge/worker.log`)。

**发 10 条就没消息?** 本插件没有本机条数拦截;若服务端限流会自动退避(`RATE_LIMITED`),窗口刷新后继续。

**从 codex-wechat-clawbot 迁移?** 状态不兼容,需重新 `login` 扫码。工具名不同(旧 `wechat_send_notification` → 新 `wechat_send_markdown/send_message`);config.toml 换 `notify` 路径;旧插件停用避免抢绑定(单账号单连接)。

**协议版本升级?** `ILINK_CHANNEL_VERSION` 环境变量可配(默认 `2.4.10`,跟随官方 `@tencent-weixin/openclaw-weixin`);对拍后调整。

**会封号吗?** iLink 是官方条款允许的 Bot 接入(《微信ClawBot功能使用条款》),低风险但非零;`-14` 冷却 60 分钟是官方同款防风控策略。勿用于营销群发。

## 第三方组件

见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。协议层 `@openilink/openilink-sdk-node`(MIT,第三方社区项目,非腾讯官方 SDK);二维码生成 `qrcode-generator`(MIT)。

## License

MIT
