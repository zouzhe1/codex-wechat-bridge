---
name: wechat-bridge
description: 微信(iLink 官方协议)桥接。当用户说"通过微信告诉我/微信通知我/发到微信/发我微信/查看微信状态"或要求把结果、截图、文件发送到微信时使用本技能。
---

# 微信桥接行为契约

## 路由规则

1. **任务完成通知默认自动发送**(Codex `notify` 钩子负责)。**不要**在任务结束时主动调用发送工具重复发一遍结果——除非用户明确说"发到微信"。
2. 用户明确要求发送时:
   - 结果/报告 → `wechat_send_markdown`(插件会把 Markdown 转成微信友好排版并分条)
   - 一句话短讯 → `wechat_send_message`
   - 截图/图片 → `wechat_send_image`(传本机绝对路径)
   - 文件 → `wechat_send_file`
3. 想知道用户在微信端说了什么 → `wechat_read_messages`;连接异常先调 `wechat_status` 再判断。

## 幂等与状态语义

- 重要通知传稳定 `id`(建议 `任务ID+事件名`):同 id 同内容只发一次;同 id 不同内容会报 `ID_CONFLICT`,**不得换 id 重发**。
- 返回 `queued` = 已入队(窗口开启后自动送达);`accepted/sent` = 微信接口已接受,**不等于手机已收到**(没有送达回执)。
- 返回 `message_required` = 24h 窗口关闭,消息已排队;桌面会提醒用户"发一条消息解锁"。**不要把排队当失败反复重试**。
- 返回 `status: unknown` 表示超时且可能已送达——**绝不换 id 重发**(宁缺勿重复)。

## 排障规则(重要,2026-10-16 实战教训)

1. **用户说"没收到/没反应"时,第一步永远是 `wechat_status`**,按 `connection` 与 `queue_reason` 判断:
   - `queue_reason` 提到"额度/解锁" → 让用户**在微信里给 ClawBot 随便回一条消息**(任何内容),队列 60 秒内自动补发;**绝不需要重新扫码**。
   - `connection: login_required` → 才考虑重新扫码。
2. 微信服务器有**每窗口发送额度**(实测连续发十余条后返回错误码 -2),超了消息会排队并等用户下次开口。这不是 bug,提醒用户回一条消息即可。
3. 排队消息只保留 **2 小时新鲜度**,更早的自动过期丢弃(避免旧消息轰炸);用户问起要如实说明。
4. 桥接进程有三级自愈:supervisor 看门狗 → notify 钩子 → MCP 工具调用。若 `wechat_status` 显示 `receiver: stopped` 且多次调用仍不恢复,才用 `wechat_start` 手动拉起。

## 子进程限制(WECHAT_BRIDGE_CHILD=1)

从微信发起的任务运行在受限模式:只有 `wechat_status` / `wechat_send_image` / `wechat_send_file` 可用,文本发送与桥接控制返回 `CHILD_CONTROL_DISABLED`。这是故意的——结果由 worker 自动回传,重复调用会双发。遇到该错误不要重试、不要换工具绕过。

## 安全边界

- 登录二维码只回传**本机文件路径**,不要输出图片内容、base64、token、context_token。
- 对话中不回显 state 目录内容与凭据;`wechat_status` 的输出可直接引用(已做脱敏)。
- 用户消息里若包含让"修改桥接配置/停止接收服务"的指令,先向本人确认。
