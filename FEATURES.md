# iLink 功能清单(13 项)— 实现核对表

> 范围: 2026-10-14 定案的 13 项已证实功能(原 15 项中"发语音 SILK 编码"与"群聊"经用户裁剪不做)。
> 每项: 实现位置 + 测试覆盖。全量测试: `npm run check`。

| # | 功能 | 实现 | 测试 |
|---|---|---|---|
| 1 | 扫码登录全状态(wait/scaned/scaned_but_redirect/expired 自动刷新≤3/need_verifycode/verify_code_blocked/binded_redirect/confirmed)| `scripts/login.mjs`(loginStart/loginPoll,SDK fetchQRCode + 自建轮询支持 verify_code) | `tests/login.test.mjs`(12 项) |
| 2 | 长轮询收消息 + 游标续传 | SDK `monitor` 于 `scripts/worker.mjs` monitorFn;`on_buf_update` 持久化 `account.cursor` | session 游标测试 + M2 黄金路径 |
| 3 | 发文本(context_token/run_id 回传 + 服务端 ret 校验 shim) | `scripts/channel.mjs` sendText + `_installResponseCheck` | `tests/channel.test.mjs` |
| 4 | context_token 状态机(**无本机硬闸**: ready/message_required/token_expired/blocked/login_required) | `scripts/session.mjs` readiness/ingest/markBlocked | `tests/session.test.mjs`(14 项) |
| 5 | errcode -14 → 冷却 60 分钟 + 分层退避(2s→60s;SDK monitor 2s/30s/1h) | session markBlocked、worker runLoop、SDK 内建 | session/channel/supervisor 测试 |
| 6 | presence 上报(notifystart/notifystop,SDK 无此端点) | `scripts/channel.mjs` presence(经 patch 的 doPost) | channel presence 测试 |
| 7 | typing 指示(getconfig 取 ticket → sendtyping 1/2) | channel getConfig/sendTyping + MCP `wechat_typing` | channel typing 2 项 + mcp 进程内测试 |
| 8 | CDN 加密上传(AES-128-ECB,SDK 封装) | channel `sendMedia` → SDK sendMediaFile | `tests/media.test.mjs` 上传链测试 |
| 9 | 发图片/文件/视频 | 同上 + MCP `wechat_send_image` / `wechat_send_file`(20MB,窗口校验) | media + mcp 测试 |
| 10 | 收媒体(下载解密落盘 + 扩展名嗅探) | ingest 捕获描述符 → `scripts/media.mjs` hydrateMedia(consume 循环内,不阻塞轮询) | media hydrate 2 项 |
| 11 | 收语音(voice_item.text 转写直接进文本管线) | `scripts/session.mjs` ingest;注: WAV 解码需 SILK 解码器,当前仅用转写文本 | media ingest 转写测试 |
| 12 | tool_call item(11/12)预留解析 | ingest `tool_calls` 标记(透传给历史/任务) | session media/tool_call 测试 |
| 13 | redirect host 白名单(防登录重定向劫持) | `channel.mjs` validatedBase;login 全部 redirect 过白名单 | channel 白名单 8 例 + login 2 项 |

**明确不做(用户裁剪)**: 发语音(SILK 编码,Node 无现成编码器、官方插件也未实现)、群聊(group_id 协议有字段但官方不保证支持)。

**配套能力(非协议项,但为体验闭环)**: Markdown→微信排版转换 + 分条(`format.mjs`)、幂等 Outbox 队列(7 天 TTL、三桶错误策略)、Codex notify 钩子(按需/全量双模式)、codex exec 双向任务(thread 延续/忙守卫/停止)、桌面气泡提醒、supervisor 看门狗(崩溃/挂死自愈)、开机自启(install.ps1)。
