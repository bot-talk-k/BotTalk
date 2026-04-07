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

## 🚀 一分钟上手

**1️⃣ 扫码登录** — 访问 [bot-talk.com](https://bot-talk.com)，微信扫码，无需注册

**2️⃣ 获取 SendKey** — 登录后自动生成

**3️⃣ 推送消息** — 浏览器地址栏粘贴即可：

```
https://bot-talk.com/YOUR_SENDKEY.send?title=Hello
```

就这么简单。收到微信消息了吗？

> 💡 由于微信 ClawBot 当前策略是同一微信号只保持一个活跃通道，绑定新应用会自动失效之前的连接。如果发现消息未收到，只需重新扫码即可恢复，秒级完成。

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
