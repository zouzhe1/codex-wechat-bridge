# 第三方组件声明

## @openilink/openilink-sdk-node

- 用途: iLink 协议层(扫码登录、长轮询、发送、CDN AES-128-ECB 加解密、SILK 解码接口)
- 许可: MIT
- 来源: https://github.com/openilink/openilink-sdk-node / https://www.npmjs.com/package/@openilink/openilink-sdk-node
- 说明: **第三方社区项目,非腾讯官方 SDK**(openilink 组织与 iLink 官方团队无关联);官方协议文档见 https://github.com/Tencent/openclaw-weixin
- 运行时依赖: 无(本项目唯一 npm 依赖)

## qrcode-generator(vendor/qrcode.mjs)

- 用途: 登录二维码本地 PNG 生成(无第三方在线服务)
- 版权: Copyright 2009 Kazuhiko Arase
- 许可: MIT
- 来源: https://github.com/kazuhikoarase/qrcode-generator (dist 打包为 ESM,原样保留)

## 协议参考(未包含代码,仅实现依据)

- 腾讯官方仓库 `Tencent/openclaw-weixin`(协议文档 docs/protocol_zh_CN.md)
- 《微信ClawBot功能使用条款》(签约主体: 深圳市腾讯计算机系统有限公司)
