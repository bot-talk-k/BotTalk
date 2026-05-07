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

## 🛡️ 通道稳定性：使用微信 ClawBot 的几件事

**坦白告知**：BotTalk 底层依赖的 [微信 ClawBot](https://ilinkai.weixin.qq.com) 是腾讯仍在内测灰度阶段的协议。它**被腾讯设计为智能体聊天通道**，所以人为加了一个限制——如果通道完全不像聊天、只是单向收消息，会被微信平台先挂起，直到收到一次微信端的任意字（如"1"）才能继续接收新消息。

### 用户需要知道的 4 件事

1. **连续收 10 次消息不回，通道一定阻塞** — 这是基于本平台用户实测数据。被阻塞后回复一字立刻恢复；调用端可通过 BotTalk API 返回的 `code: 50001` + `data.reason` + `data.hint` 准确感知发生了什么、该怎么办。

2. **同一微信连续快速接收 7-8 条**也可能提前触发限流。要完全顺畅，**最好收到 4-5 条就随便回一条**（任意字即可），系统会立刻回执确认。

3. **扫码后长时间零互动**（官方 24 小时，实测可能 2 天），通道会被微信主动解绑——这种情况只能重新扫码。

4. **好消息**：失联后回 [bot-talk.com](https://bot-talk.com) 重扫一次，**SendKey 和发送历史都保留**，你的应用代码完全不用改。

### 我们的做法

我们不硬扛协议缺陷，而是**让收消息这件事自然变成对话**：你回复后系统秒回一条 ✅ 确认，失败的消息自动通过重试队列补发并带原始时间戳。被迫的保活动作就这样变成了双向可感知的对话——你一眼知道通道活着，通道顺带就刷新了。

后台还有这些自愈机制，大多数情况完全无感：

| 机制 | 作用 |
|---|---|
| ⚡ 用户回复秒回执 + 失败补发 | 沉默期间漏掉的消息，你回一字后自动到达，带原始时间 |
| 🔁 延时重试队列 | 失败消息按 +2 / +7 / +22 / +82 分钟退避自动重试 |
| 🚦 客户端限流队列 | 同通道最小 10s 发送间隔，防 burst 触发服务端限流 |
| 💓 Poller 心跳监控 | 每 2 分钟扫长轮询，挂死自动重启（epoch 机制防双 loop 并发）|
| 📢 预防性保活提醒 | 临近沉睡时主动提示你回一字，降低重扫概率 |
| 🔍 50001 错误细分 | 响应自带 `data.reason` + `data.hint`，告诉调用方该让用户做什么 |

**诚实边界**：这套机制无法让通道"永不失联"——协议缺陷在腾讯修复前没有银弹。但实测下来，绝大多数抖动在用户无感知的情况下就被修复，真正需要重扫的情况从"每天数次"降至"数天一次"。

完整协议踩坑分析见 [iLink Pitfalls 指南](docs/ilink-pitfalls.md)。

## 🚀 一分钟上手

**1️⃣ 扫码登录** — 访问 [bot-talk.com](https://bot-talk.com)，微信扫码，无需注册

**2️⃣ 获取 SendKey** — 登录后自动生成

**3️⃣ 推送消息** — 浏览器地址栏粘贴即可：

```
https://bot-talk.com/YOUR_SENDKEY.send?title=Hello
```

就这么简单。收到微信消息了吗？

> 💡 微信 ClawBot 是腾讯内测灰度协议，通道有几个使用前提——详见下方「[通道稳定性](#️-通道稳定性使用微信-clawbot-的几件事)」小节。如真的收不到消息，只需重新扫码即可秒级恢复（SendKey 和历史不变）。

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
| 50001 | 推送失败（详见 `data.reason` + `data.hint`） |

**遇到 50001 不要慌**：响应 `data.reason` 会告诉你**该让终端用户做什么**：

- `context_expired`（最常见）→ **让收信人在微信里向 ClawBot 回复任意一条消息**，1-2 分钟内系统会自动补发本条消息，无需重扫码
- `channel_dead` → 让收信人重新扫码绑定
- `account_restricted` → 账号被风控，需联系平台
- `no_channel` → 检查 `channel` 参数

详见 [API 参考文档](docs/api-reference.md#50001-失败原因-datareason)。

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
