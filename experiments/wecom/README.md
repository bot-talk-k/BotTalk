# 企业微信智能机器人通道 MVP 原型

> ⚠️ **隔离实验目录**,不是 bot-talk 生产代码。验证「扫码即用 + WS 长连接收发 + 无 iLink 式限流」后再决定是否做正式独立站(对标 `feishu/`)。

## 与飞书的根本差异(必读)

| | 飞书(`experiments/feishu/`) | 企业微信(本目录) |
|---|---|---|
| 扫码授权 | `@larksuite/openclaw-lark-tools` Device Flow(Node 端轮询) | `@wecom/wecom-aibot-sdk` **浏览器** Popup+PostMessage(在网页里弹窗) |
| 拿到什么 | appId + appSecret + **open_id**(含发送目标) | botid + secret(**不含**发送目标) |
| 发送 | 无状态 REST `im/v1/messages`(每条独立换 token) | **有状态 WebSocket 长连接** `wss://openws.work.weixin.qq.com` |
| 发送目标 | 绑定即返回 open_id | 只能从 `enter_chat` 事件 / 用户首条消息里**捕获 userid** |
| 后端形态 | 被动 HTTP(app.js 无后台任务) | **常驻 WS 连接**(心跳 30s + 自动重连) |

底层 SDK:
- 浏览器授权:`@wecom/wecom-aibot-sdk`(MIT),`openBotInfoAuthWindow({source})` → `{botid, secret}`。已 vendor 为 [`public/wecom-aibot-sdk.umd.js`](../../public/wecom-aibot-sdk.umd.js)。
- 后端长连接:`@wecom/aibot-node-sdk` v1.0.7 的 `WSClient`(自动 `aibot_subscribe` + `ping` + 重连 + `sendMessage`/`aibot_send_msg`)。

## 文件结构

```
experiments/wecom/
├── client.js   - WSClient 单例封装(connect/sendMarkdown/getState/disconnect + 捕获 userid)
├── routes.js   - admin-only endpoints(status/bind/connect/disconnect/inbound/send/reset)
└── README.md
public/wecom-proto.html       - 测试页(扫码 + 捕获 userid + 收发 + 连发压测)
public/wecom-aibot-sdk.umd.js - vendor 的浏览器授权 SDK
data/wecom-proto.json         - 绑定凭证(运行时生成,gitignore 已覆盖 data/)
```

## 启用方式(本地测试)

```bash
ENABLE_WECOM_PROTO=1 npm start
# 浏览器 http://localhost:3000/wecom-proto.html (admin 账号登录)
```

> WS 长连接从**运行 node 的机器**连出去。本地测即从你电脑连 `openws.work.weixin.qq.com`。

## 自验流程

1. **扫码绑定**:① 卡片点「扫码接入」→ 弹企业微信授权窗 → 企业微信 App 扫码 → 自动拿 BotID/Secret → 后端自动建 WS 长连接(「当前状态」应显示 `WS 已连接+认证`)。
2. **捕获 userid**:② 卡片提示下,在**企业微信里打开这个机器人的会话,发一句话(如 `hi`)** → 后端 WS 收到 → `userid` 自动捕获(badge 变绿)。这是主动推送的前提。
3. **主动推送**:③ 卡片「单条发送」→ 企业微信应收到 markdown 消息。
4. **限流压测**:「连发 20 条」→ 应全部送达(官方限频 30/min、1000/h 按会话,留 500ms 间隔;对照 iLink 9-10 条断点)。

## 验证里程碑

- [ ] 浏览器扫码拿到 botid/secret(确认 `source` 值可用)
- [ ] WS 长连接 authenticated
- [ ] 发一句话后捕获到 userid
- [ ] 单条主动推送到达
- [ ] 连发 20 条全部到达(对照 iLink 限流)

## 已知未决 / 坑点

- **`source` 参数**:授权窗 `work.weixin.qq.com/ai/qc/gen?source=...`。默认沿用 TomAI 的 `lobster-ai`(用户已实测可用)。bot-talk 若要自己的 source,需确认企业微信侧是否对 source 有白名单 —— 待测。
- **userid 捕获依赖交互**:`enter_chat` 仅「当天首次进入单聊」触发;为稳妥,任何收到的单聊消息都会刷新 userid。
- **进程重启**:WS 连接不持久化,重启后需「诊断」卡片点「重连」(或正式版做启动自动重连)。

## 正式版若要做(对标 feishu/ 独立站)

- 独立 `wecom/` 子目录 + 独立 DB(channels 存 botid/secret/userid)
- 常驻 WS 连接池(每个绑定一条),启动恢复 + 断线重连
- `/:key.send` 推送 API 对齐微信/飞书契约 → markdown 卡片走 `sendMessage`
- 删 `experiments/wecom/` + `public/wecom-proto.html` + `public/wecom-aibot-sdk.umd.js`
