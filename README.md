<div align="center">

# BotTalk

### HTTP 一行调用，消息直达手机

**免费 · 开源 · 可自部署 · Server酱替代品**

Push notifications to Feishu or WeChat — free, open-source, self-hostable.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED.svg)](docker-compose.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

[**官网**](https://bot-talk.com) · [**飞书通道**](https://feishu.bot-talk.com) · [**API 文档**](docs/api-reference.md) · [**自部署指南**](docs/self-deploy-guide.md)

---

</div>

## 为什么选择 BotTalk？

|  | BotTalk | Server酱 |
|---|---------|----------|
| **开源** | MIT 开源 | 闭源 |
| **价格** | 完全免费，无限制 | 免费版每天 5 条 |
| **自部署** | Docker 一键部署 | 不支持 |
| **推送通道** | <img src="https://www.feishu.cn/favicon.ico" height="14"> 飞书（推荐）+ 💬 微信 | 企业微信/测试号 |
| **绑定方式** | 扫码即绑定 | 需关注公众号或加入企业 |
| **SDK** | Python / Node.js / Go | 官方仅 API |
| **API 兼容** | 兼容 Server酱格式 | — |

## 推送通道

| 通道 | 特点 | 入口 |
|---|---|---|
| <img src="https://www.feishu.cn/favicon.ico" height="14"> **飞书（推荐）** | 个人用户可扫码即绑，可一个账户多个消息通道，稳定而无限接收 | [feishu.bot-talk.com](https://feishu.bot-talk.com) |
| 💬 **微信** | 已稳定运行数月；受腾讯通道设计限制：连续收消息达到 10 条需回复一条任意消息，假装聊天即可无限使用 | [bot-talk.com](https://bot-talk.com) |

> **两个通道共用同一套 API**，SendKey 格式区分：飞书以 `fs_` 开头，微信为 32 位 hex。`bot-talk.com` 会根据 SendKey 自动路由。

## 🚀 一分钟上手

**1️⃣ 选通道，扫码绑定**
- 飞书（推荐） → [feishu.bot-talk.com](https://feishu.bot-talk.com)
- 微信 → [bot-talk.com](https://bot-talk.com)

**2️⃣ 获取 SendKey** — 绑定后自动生成

**3️⃣ 发消息** — 浏览器地址栏粘贴即可：

```
https://bot-talk.com/YOUR_SENDKEY.send?title=Hello
```

就这么简单。

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
| channel | 否 | 目标通道（`default` / `all` / 逗号分隔 ID） |

\* title 和 desp/msg 不能同时为空

</details>

<details>
<summary><b>返回值与错误码</b></summary>

```json
{"code": 0, "message": "success", "data": {"results": [...]}}
```

| 错误码 | 说明 |
|--------|------|
| 40001 | SendKey 无效 |
| 40002 | 没有可用的推送通道 |
| 40003 | 消息内容为空 |
| 42901 | 超过频率限制 |
| 50001 | 推送失败（详见 `data.reason`） |

</details>

## 它是怎么工作的

```
你的脚本/服务/IoT
       │
       └─ HTTP ──▶ bot-talk.com ──▶ 飞书 App（fs_ SendKey，无限制）
                                └──▶ 微信私聊（hex SendKey，平台有限流）
```

## 🛠 多语言 SDK

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

## 🐳 自部署

### Docker（推荐）

```bash
git clone https://github.com/bot-talk-k/BotTalk.git
cd BotTalk
cp .env.example .env  # 编辑 BASE_URL 为你的域名
docker compose up -d
```

飞书通道在 `feishu/` 子目录，独立部署：

```bash
docker compose -f docker-compose.feishu.yml up -d
# 或使用一键脚本
./deploy-feishu.sh
```

<details>
<summary><b>环境变量</b></summary>

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3000 | 服务端口 |
| BASE_URL | http://localhost:3000 | 对外访问 URL |
| SESSION_SECRET | 随机生成 | Session 签名密钥 |
| TZ | Asia/Shanghai | 时区 |

</details>

详细部署文档：[自部署指南](docs/self-deploy-guide.md)

## 🤝 参与贡献

欢迎 PR 和 Issue！请阅读 [贡献指南](CONTRIBUTING.md)。

## 📄 License

[MIT](LICENSE) — 随便用，开心就好。
