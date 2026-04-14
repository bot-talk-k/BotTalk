<div align="center">

# BotTalk

### 基于微信（非企业微信）机器人的消息推送服务

**免费 · 开源 · 可自部署 · Server酱替代品**

Push notifications to your WeChat — free, open-source, self-hostable.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED.svg)](docker-compose.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

[**官网**](https://bot-talk.com) · [**快速开始**](#-一分钟上手) · [**API 文档**](docs/api-reference.md) · [**自部署指南**](docs/self-deploy-guide.md)

---

</div>

## 为什么选择 BotTalk？

|  | BotTalk | Server酱 |
|---|---------|----------|
| **开源** | MIT 开源 | 闭源 |
| **价格** | 完全免费，无限制 | 免费版每天 5 条 |
| **自部署** | Docker 一键部署 | 不支持 |
| **推送通道** | 微信机器人私聊直达 | 企业微信/测试号 |
| **绑定方式** | 扫码即绑定，无需关注公众号 | 需关注公众号或加入企业 |
| **SDK** | Python / Node.js / Go | 官方仅 API |
| **数据隐私** | 自部署，数据完全自控 | 第三方存储 |
| **API 兼容** | 兼容 Server酱格式 | — |
| **通道自愈** | 限流 + 重试 + 补发 + 探测，7 层机制 | 断了要自己手动重试 |

## 🛡️ 通道稳定性：用一次一字的互动替代复杂保活

**坦白告知**：BotTalk 底层依赖的 [微信 ClawBot](https://ilinkai.weixin.qq.com) 是腾讯仍在内测灰度阶段的协议，存在一个我们无法绕开的限制——**通道如果长时间没有用户互动，会被微信平台静默断开**。这是协议层缺陷，不是 BotTalk 的 bug，也不是任何同类方案能从根本解决的。

我们的做法不是硬扛协议缺陷，而是**通过人性化的互动设计巧妙避开它**：

> 用户收到推送后顺手回一字（"好" "在" "1"）→ 系统**秒回** ✅ "收到，通道状态已刷新" → ClawBot 的 context_token 同步刷新 → 期间失败的消息立即自动补发，带原始时间戳。

这一来一回的"一字换一执"，本来只是为了绕过腾讯的保活限制，实际把**被迫的保活动作变成了双向可感知的对话**：用户一眼知道通道活着，有掌控感；通道顺带就刷新了。大多数社区方案（包括腾讯官方 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) SDK）在这个问题上止步于"能发能收"——掉线让用户自己去猜、去重扫。

### 支撑这个互动闭环的 7 层脚手架

| 机制 | 作用 | 用户感受 |
|------|------|----------|
| ✉️ **用户回复秒回执** | 收到用户任意消息整批统一回一条 ✅ 确认 | 一字就能确认通道死活，告别沉默焦虑 |
| ⚡ **回复触发补发** | 用户回字即刻唤醒 pending 重试并真正发出，带原始推送时间前缀 | 沉默一整天回一字，漏掉的消息立刻到 |
| 🔁 **延时重试队列**（持久化）| 失败消息按 2 / 5 / 15 / 60 分钟退避重试，完整 failure_history 留痕 | 瞬时抖动自动修复，无需用户介入 |
| 🔍 **ret:-2 持续探测** | 重试用尽后每小时低频探测，最多 48 小时 | 通道自然恢复时自动补送历史消息 |
| 🚦 **客户端限流队列** | 同通道最小 10s 发送间隔，防 burst 触发服务端限流 | 批量推送不再集体翻车 |
| 💓 **Poller 心跳监控** | 每 2 分钟扫长轮询进程，挂死自动重启（epoch 机制防双 loop 并发）| 容器运行零人工干预 |
| 📢 **预防性保活提醒** | 4h 无成功推 + 20h 无回复时主动提示用户回一字 | 通道接近沉睡前提前唤醒，降低重扫概率 |

**错误码分类处理**：`ret:-14` 会二次 `getUpdates` 确认是真 session 死还是"半死态"（账号被微信风控），避免把可恢复通道误标失效。

**诚实边界**：这套机制无法让通道"永不失联"——协议缺陷在腾讯修复前没有银弹。但实测下来，**绝大多数抖动在用户无感知的情况下就被修复**，真正需要重扫的情况从"每天数次"降至"数天一次"。

完整协议踩坑分析和实现细节见 [iLink Pitfalls 指南](docs/ilink-pitfalls.md)。

## 🚀 一分钟上手

**1️⃣ 扫码登录** — 访问 [bot-talk.com](https://bot-talk.com)，微信扫码，无需注册

**2️⃣ 获取 SendKey** — 登录后自动生成

**3️⃣ 推送消息** — 浏览器地址栏粘贴即可：

```
https://bot-talk.com/YOUR_SENDKEY.send?title=Hello
```

就这么简单。收到微信消息了吗？

> 💡 微信 ClawBot 是腾讯内测灰度协议，通道偶尔会被平台静默断开。BotTalk 后台有 **7 层自愈机制** 尽量让你无感——详见下方「[通道稳定性](#-通道稳定性用一次一字的互动替代复杂保活)」小节。如真的收不到消息，只需重新扫码即可秒级恢复（SendKey 和历史不变）。

## 📡 API

### GET — 最简单，浏览器直接访问

```
https://bot-talk.com/YOUR_SENDKEY.send?title=服务器挂了
https://bot-talk.com/YOUR_SENDKEY.send?title=服务器挂了&desp=CPU占用100%
```

### POST — 推荐，内容不限长度

```bash
curl -X POST "https://bot-talk.com/YOUR_SENDKEY.send" \
  -H "Content-Type: application/json" \
  -d '{"title": "部署完成", "desp": "v2.1.0 已成功上线"}'
```

### 通用接口

```
GET/POST  /notify?key=YOUR_SENDKEY&title=标题&msg=内容
```

也支持 `Authorization: Bearer SENDKEY` Header 认证。兼容 Server酱 API 格式，**迁移只需改域名**。

<details>
<summary><b>参数说明</b></summary>

| 参数 | 必填 | 说明 |
|------|------|------|
| title | 否* | 消息标题 |
| desp / msg / message | 否* | 消息内容 |
| channel | 否 | 目标通道（多通道时指定） |

\* title 和 desp/msg 不能同时为空

</details>

<details>
<summary><b>返回值与错误码</b></summary>

```json
{"code": 0, "message": "success", "data": {"pushid": 123}}
```

| 错误码 | 说明 |
|--------|------|
| 40001 | SendKey 无效 |
| 40002 | 没有可用的推送通道 |
| 40003 | 消息内容为空 |
| 42901 | 超过频率限制 |
| 50001 | 推送失败 |

</details>

## 它是怎么工作的

```
你的脚本/服务器/IoT ──HTTP请求──▶ BotTalk ──▶ iLink Bot ──▶ 微信私聊消息
```

不需要企业微信，不需要关注公众号。扫码绑定后，消息由 iLink Bot 以**私聊形式**直达微信，体验就像朋友给你发消息。

## 🛠 多语言 SDK

所有能发 HTTP 请求的语言都可以调用。我们还提供官方 SDK：

<table>
<tr>
<td>

**Python**
```bash
pip install bottalk
```
```python
from bottalk import BotTalk

bt = BotTalk("YOUR_SENDKEY")
bt.send("服务器挂了！", desp="CPU 100%")
```

</td>
<td>

**Node.js**
```bash
npm install bottalk
```
```typescript
import { BotTalk } from 'bottalk';

const bt = new BotTalk('YOUR_SENDKEY');
await bt.send('Deploy done', { desp: 'v2.1.0' });
```

</td>
<td>

**Go**
```bash
go get github.com/bot-talk-k/BotTalk-go
```
```go
client := bottalk.New("YOUR_SENDKEY")
client.Send("Hello from Go!")
```

</td>
</tr>
</table>

**不想用 SDK？一行 curl 搞定：**

```bash
curl "https://bot-talk.com/YOUR_SENDKEY.send?title=Hello"
```

## 🐳 自部署

### Docker（推荐，4 行命令）

```bash
git clone https://github.com/bot-talk-k/BotTalk.git
cd BotTalk
cp .env.example .env  # 编辑 BASE_URL 为你的域名
docker compose up -d
```

### 手动部署

```bash
npm install
node app.js
```

<details>
<summary><b>环境变量</b></summary>

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3000 | 服务端口 |
| BASE_URL | http://localhost:3000 | 对外访问 URL |
| SESSION_SECRET | 随机生成 | Session 签名密钥（生产环境建议固定） |
| TZ | Asia/Shanghai | 时区 |

</details>

详细部署文档：[自部署指南](docs/self-deploy-guide.md)（含 Nginx 反向代理、HTTPS、备份恢复）

## 🤝 参与贡献

欢迎 PR 和 Issue！请阅读 [贡献指南](CONTRIBUTING.md)。

安全漏洞请通过 [SECURITY.md](SECURITY.md) 中的方式报告。

## 📄 License

[MIT](LICENSE) — 随便用，开心就好。
