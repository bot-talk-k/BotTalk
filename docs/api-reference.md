# BotTalk API 参考文档

## 概述

BotTalk 是一个开源的微信推送服务（类似 Server酱），通过微信 iLink Bot 向用户发送消息推送。

**基础 URL**：由部署环境决定，通过环境变量 `BASE_URL` 配置。

- 自部署示例：`https://your-server.example.com`
- 托管服务：`https://bot-talk.com`

## 认证方式

BotTalk 使用两种认证方式：

### 1. SendKey（推送 API）

用于消息推送接口。SendKey 是一个 32 位十六进制字符串，在用户注册时自动生成。

- **路径传参**：`GET /{sendkey}.send?title=xxx`
- **Query 传参**：`GET /notify?key={sendkey}&msg=xxx`
- **Bearer Token**：`Authorization: Bearer {sendkey}`

> **安全提示**：SendKey 等同于密码，请勿在公开场合暴露。如果泄露，请立即通过 API 重置。通过 GET 请求传递 SendKey 时，它会出现在服务器日志和浏览器历史记录中，敏感场景建议使用 POST + Bearer Token 方式。

### 2. Session Cookie（管理 API）

用于通道管理、提醒、日志查看等管理接口。通过 `/api/auth/login` 或扫码注册后自动设置。

- Cookie 有效期：30 天
- 后端存储：SQLite

---

## 推送 API

推送 API 是 BotTalk 的核心功能，无需登录 session，仅需 SendKey 即可调用。

### 风格一：Server酱兼容格式

```
GET/POST /{sendkey}.send
```

**参数**（Query 或 Body 均可）：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是* | 消息标题 |
| desp | string | 否 | 消息内容（Body 中也接受 `message`） |
| channel | string | 否 | 目标通道，见下方说明 |

> *`title` 和 `desp`/`message` 不能同时为空。

**请求示例**：

```bash
# GET 请求
curl "https://bot-talk.com/YOUR_SENDKEY.send?title=Hello&desp=World"

# POST 请求
curl -X POST "https://bot-talk.com/YOUR_SENDKEY.send" \
  -H "Content-Type: application/json" \
  -d '{"title": "Hello", "desp": "World"}'
```

### 风格二：通用推送格式

```
GET/POST /notify
```

**参数**：

| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| key | Query 或 Header (`Authorization: Bearer {key}`) | string | 是 | SendKey |
| title | Query/Body | string | 是* | 消息标题 |
| msg / desp / message | Query/Body | string | 否 | 消息内容 |
| channel | Query/Body | string | 否 | 目标通道 |

> *`title` 和消息内容不能同时为空。

**请求示例**：

```bash
# GET + Query 参数
curl "https://bot-talk.com/notify?key=YOUR_SENDKEY&title=Hello&msg=World"

# POST + Bearer Token
curl -X POST "https://bot-talk.com/notify" \
  -H "Authorization: Bearer YOUR_SENDKEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Server Alert", "message": "CPU usage > 90%"}'
```

### channel 参数说明

| 值 | 说明 |
|---|---|
| 留空 或 `default` | 发送到默认通道 |
| `all` | 发送到所有已激活通道 |
| `1,3,5` | 逗号分隔的通道 ID，发送到指定通道 |

### 推送响应格式

**成功**（至少一个通道推送成功）：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "results": [
      { "channel_id": 1, "status": "success" }
    ]
  }
}
```

**失败**（全部通道推送失败）：

```json
{
  "code": 50001,
  "message": "全部推送失败",
  "data": {
    "results": [
      {
        "channel_id": 1,
        "status": "failed",
        "token_invalid": false,
        "reason": "context_expired",
        "ret_code": -2
      }
    ],
    "reason": "context_expired",
    "hint": "通道因长期无互动暂时受限... 让收信人在微信里向 ClawBot 回复任意一条消息..."
  }
}
```

### 推送错误码

| 错误码 | 说明 |
|--------|------|
| 0 | 成功（至少一个通道推送成功） |
| 40001 | SendKey 无效或缺失 |
| 40002 | 没有可用的推送通道（未绑定或未激活） |
| 40003 | title 和消息内容不能同时为空 |
| 42901 | 发送频率超限（每 SendKey 每小时最多 100 条） |
| 50001 | 全部推送失败（详见 `data.reason`） |

### 50001 失败原因（`data.reason`）

50001 是笼统失败码，**真正的"该让用户做什么"看 `data.reason` + `data.hint`**。

| `data.reason` | 含义 | 解决方法 | 用户回复能解决吗 |
|---|---|---|---|
| `context_expired` | iLink ret:-2/-14 半死，context_token 老化（**最常见**） | **让收信人在微信里向 ClawBot 回复任意消息** | ✅ 能 |
| `channel_dead` | token 真死（getUpdates 也失败 / HTTP 401/403） | 让收信人重新扫码绑定 | ❌ 不能 |
| `account_restricted` | iLink 半死态：能收消息但不能被推送（账号疑似被风控） | 联系平台或换号 | ❌ 不能 |
| `no_channel` | 指定的通道未绑定或 context_token 已彻底过期 | 检查 `channel` 参数，或重新扫码 | ❌ 不能 |
| `transient` | 网络抖动 / 服务端排队满 | 系统自动重试，多数情况自动恢复 | — |

**自动补发**：当 `reason` 是 `context_expired` 或 `transient` 时，系统已自动入队重试（+2/+7/+22/+82 分钟 4 次退避）。生产数据显示 `context_expired` 通过用户回复触发的恢复占所有恢复成功 case 的 94%——**这是开发者最该向终端用户传达的恢复路径**。

### 单通道结果（`data.results[i]`）

| 字段 | 说明 |
|---|---|
| `channel_id` | 通道 ID |
| `status` | `success` / `failed` / `skipped` |
| `token_invalid` | （仅 failed）token 是否真死，true → 需重扫 |
| `reason` | （仅 failed）细分原因，同上表枚举 |
| `ret_code` | （仅 failed）iLink 原始 ret 码（如 `-2` / `-14`） |

### 50001 自救手册：开发者侧最小代码

终端用户**不会**看到管理员告警，他们只能依赖你 app 里基于响应做的提示。把响应里的 `data.hint` 接到你 app 的 toast / 邮件兜底 / 业务日志，就能让收信人 1-2 分钟内自助解锁。

**curl + jq**

```bash
resp=$(curl -sk "https://bot-talk.com/${KEY}.send?title=订单异常&desp=...")
code=$(echo "$resp" | jq -r '.code')
if [ "$code" = "50001" ]; then
  reason=$(echo "$resp" | jq -r '.data.reason')
  hint=$(echo "$resp" | jq -r '.data.hint')
  if [ "$reason" = "context_expired" ]; then
    echo "提示收信人: $hint"   # 走你自己的邮件/SMS/IM 兜底
  elif [ "$reason" = "channel_dead" ]; then
    echo "需重新扫码: $hint"
  fi
fi
```

**Node**

```js
import { BotTalk, PushFailedError } from '@bot-talk/sdk';
const client = new BotTalk(process.env.BOTTALK_KEY);
try {
  await client.send('订单 #123 异常');
} catch (e) {
  if (e instanceof PushFailedError) {
    if (e.isRecoverableByReply) {
      // ✅ 最常见路径：让收信人回复 ClawBot 即可
      myApp.toast(`收信人暂时收不到。${e.hint}`);
      myApp.sendBackupEmail(recipient, e.hint);
    } else if (e.reason === 'channel_dead') {
      myApp.alert(`通道已死，需要 ${recipient} 重新扫码`);
    }
  }
}
```

**Python**

```python
from bottalk import BotTalk, PushFailedError
client = BotTalk(os.environ['BOTTALK_KEY'])
try:
    client.send('订单 #123 异常')
except PushFailedError as e:
    if e.is_recoverable_by_reply:
        my_app.notify_sender(f'收信人暂时收不到。{e.hint}')
        my_app.send_backup_email(recipient, e.hint)
    elif e.reason == 'channel_dead':
        my_app.alert_ops(f'通道已死，{recipient} 需重扫')
```

**Go**

```go
import "errors"
import bottalk "github.com/bot-talk-k/BotTalk/sdk/go"

err := client.Send("订单 #123 异常")
var pe *bottalk.PushFailedError
if errors.As(err, &pe) {
    if pe.IsRecoverableByReply() {
        myApp.NotifySender("收信人暂时收不到。" + pe.Hint)
    } else if pe.Reason == bottalk.ReasonChannelDead {
        myApp.AlertOps(fmt.Sprintf("通道已死，%s 需重扫", recipient))
    }
}
```

---

## 认证 API

挂载路径：`/api/auth`

### POST /api/auth/register

通过邮箱注册新用户，自动生成 SendKey 并建立登录 session。

**请求 Body**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| email | string | 是 | 邮箱地址 |

**请求示例**：

```bash
curl -X POST "https://bot-talk.com/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com"}'
```

**成功响应**：

```json
{
  "success": true,
  "data": {
    "id": 1,
    "email": "user@example.com",
    "send_key": "a1b2c3d4e5f6..."
  }
}
```

**错误响应**：

```json
{ "success": false, "error": "请输入邮箱地址" }
{ "success": false, "error": "邮箱格式无效" }
{ "success": false, "error": "该邮箱已注册" }
```

### POST /api/auth/login

通过 SendKey 登录，建立 session。

**请求 Body**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| send_key | string | 是 | 用户的 SendKey |

**请求示例**：

```bash
curl -X POST "https://bot-talk.com/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"send_key": "YOUR_SENDKEY"}' \
  -c cookies.txt
```

**成功响应**：

```json
{
  "success": true,
  "data": {
    "id": 1,
    "email": "user@example.com",
    "send_key": "a1b2c3d4e5f6...",
    "channel_count": 2
  }
}
```

**错误响应**：

```json
{ "success": false, "error": "请输入 SendKey" }
{ "success": false, "error": "SendKey 无效" }
```

### GET /api/auth/me

获取当前登录用户信息。**需要登录 session。**

**请求示例**：

```bash
curl "https://bot-talk.com/api/auth/me" -b cookies.txt
```

**成功响应**：

```json
{
  "success": true,
  "data": {
    "id": 1,
    "email": "user@example.com",
    "send_key": "a1b2c3d4e5f6...",
    "channel_count": 2
  }
}
```

**错误响应**（未登录）：

```json
{ "error": "Unauthorized. Please log in." }
```
HTTP 状态码：`401`

### POST /api/auth/logout

退出登录，销毁 session。**需要登录 session。**

**请求示例**：

```bash
curl -X POST "https://bot-talk.com/api/auth/logout" -b cookies.txt
```

**成功响应**：

```json
{ "success": true }
```

---

## SendKey 管理 API

挂载路径：`/api/key`。**所有接口需要登录 session。**

### GET /api/key

获取当前用户的 SendKey。

**请求示例**：

```bash
curl "https://bot-talk.com/api/key" -b cookies.txt
```

**成功响应**：

```json
{
  "success": true,
  "data": { "send_key": "a1b2c3d4e5f6..." }
}
```

### POST /api/key/reset

重置 SendKey。旧 Key 立即失效。

**请求示例**：

```bash
curl -X POST "https://bot-talk.com/api/key/reset" -b cookies.txt
```

**成功响应**：

```json
{
  "success": true,
  "data": { "send_key": "new_key_here..." }
}
```

---

## 通道管理 API

挂载路径：`/api/channels`。

### 公开接口（无需登录）

#### POST /api/channels/qrcode-public

生成扫码绑定二维码（用于新用户注册 + 绑定通道）。

**请求示例**：

```bash
curl -X POST "https://bot-talk.com/api/channels/qrcode-public" -c cookies.txt
```

**成功响应**：

```json
{
  "success": true,
  "data": {
    "qrcode": "qrcode_string",
    "qrcode_url": "https://...",
    "expire_time": 300
  }
}
```

> 注意：响应中的 `data` 字段直接透传 iLink API 返回内容，字段可能随上游变化。

#### GET /api/channels/bind-status-public/:qrcode

轮询扫码状态。扫码完成后自动创建用户和默认通道，并建立登录 session。

**路径参数**：

| 参数 | 说明 |
|------|------|
| qrcode | 从 `/qrcode-public` 获取的二维码字符串 |

**请求示例**：

```bash
curl "https://bot-talk.com/api/channels/bind-status-public/QRCODE_STRING" -b cookies.txt
```

**未扫码时的响应**（状态仍在等待）：

```json
{
  "success": true,
  "data": { "status": "waiting" }
}
```

**二维码过期**：

```json
{
  "success": true,
  "data": { "status": "expired" }
}
```

**扫码完成 - 新用户**：

```json
{
  "success": true,
  "data": {
    "id": 1,
    "send_key": "a1b2c3d4...",
    "status": "pending",
    "wechat_openid": "user_openid",
    "is_new": true
  }
}
```

**扫码完成 - 已有用户（自动登录）**：

```json
{
  "success": true,
  "data": {
    "id": 1,
    "send_key": "existing_key...",
    "status": "pending",
    "wechat_openid": "user_openid",
    "is_new": false
  }
}
```

> `status: "pending"` 表示通道正在等待激活。用户需要在微信中向 Bot 发送一条消息以完成激活。

### 需要登录的接口

以下接口均需要登录 session（Cookie），未登录返回 `401`。

#### GET /api/channels

获取当前用户的所有通道（不含已删除的 `inactive` 通道）。

**请求示例**：

```bash
curl "https://bot-talk.com/api/channels" -b cookies.txt
```

**成功响应**：

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "user_id": 1,
      "name": "默认通道",
      "channel_type": "wechat_ilink",
      "wechat_openid": "user_openid",
      "bot_token": "...",
      "context_token": "...",
      "status": "active",
      "is_default": 1,
      "created_at": "2025-01-01 00:00:00"
    }
  ]
}
```

#### POST /api/channels/qrcode

为当前用户生成添加新通道的二维码。每个用户最多 10 个通道。

**请求示例**：

```bash
curl -X POST "https://bot-talk.com/api/channels/qrcode" -b cookies.txt
```

**成功响应**：与 `qrcode-public` 格式相同。

**超过上限时的错误**：

```json
{ "success": false, "data": { "error": "Maximum 10 channels allowed" } }
```
HTTP 状态码：`400`

#### GET /api/channels/bind-status/:qrcode

轮询新通道的扫码绑定状态。

**路径参数**：

| 参数 | 说明 |
|------|------|
| qrcode | 从 `/api/channels/qrcode` 获取的二维码字符串 |

**扫码完成 - 新通道**：

```json
{
  "success": true,
  "data": {
    "id": 2,
    "name": "Channel 2",
    "status": "pending",
    "wechat_openid": "new_openid",
    "is_default": 0
  }
}
```

**扫码完成 - 同一微信重绑**：

```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "默认通道",
    "status": "pending",
    "wechat_openid": "same_openid",
    "is_default": 1,
    "rebind": true
  }
}
```

**该微信已被其他账户绑定**：

```json
{
  "success": false,
  "data": {
    "error": "wechat_already_bound",
    "message": "该微信已被其他账户绑定"
  }
}
```

#### GET /api/channels/:id/activation

检查通道是否已激活（用户在微信中发送了第一条消息）。

**请求示例**：

```bash
curl "https://bot-talk.com/api/channels/1/activation" -b cookies.txt
```

**成功响应**：

```json
{ "success": true, "data": { "activated": true } }
```

#### PATCH /api/channels/:id

更新通道名称或设为默认通道。

**请求 Body**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 否 | 新的通道名称 |
| is_default | integer | 否 | 设为 1 则将此通道设为默认，其他通道自动取消默认 |

**请求示例**：

```bash
curl -X PATCH "https://bot-talk.com/api/channels/1" \
  -H "Content-Type: application/json" \
  -d '{"name": "我的手机", "is_default": 1}' \
  -b cookies.txt
```

**成功响应**：返回更新后的完整通道对象。

```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "我的手机",
    "is_default": 1,
    "status": "active",
    "..."
  }
}
```

#### POST /api/channels/:id/check

检测通道是否存活（通过服务端 poller 心跳检测，不调用 iLink API）。

**请求示例**：

```bash
curl -X POST "https://bot-talk.com/api/channels/1/check" -b cookies.txt
```

**成功响应**：

```json
{
  "success": true,
  "data": {
    "alive": true,
    "reason": null,
    "last_ok_seconds_ago": 5,
    "status": "active"
  }
}
```

**通道不存活时**：

```json
{
  "success": true,
  "data": {
    "alive": false,
    "reason": "session_expired",
    "last_ok_seconds_ago": 3600,
    "status": "inactive"
  }
}
```

`reason` 可能的值：`no_poller`、`stopped`、`session_expired`、`heartbeat_timeout`

#### DELETE /api/channels/:id

软删除通道（将状态设为 `inactive`）。

**请求示例**：

```bash
curl -X DELETE "https://bot-talk.com/api/channels/1" -b cookies.txt
```

**成功响应**：

```json
{ "success": true, "data": { "message": "Channel deleted" } }
```

---

## 推送日志 API

挂载路径：`/api/push-logs`。**需要登录 session。**

### GET /api/push-logs

获取当前用户最近 50 条推送日志。

**请求示例**：

```bash
curl "https://bot-talk.com/api/push-logs" -b cookies.txt
```

**成功响应**：

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "user_id": 1,
      "title": "Hello",
      "content": "World",
      "status": "success",
      "ip": "1.2.3.4",
      "channel_id": 1,
      "channel_name": "默认通道",
      "response": "{\"errcode\":0,\"errmsg\":\"ok\",\"http_status\":200,\"duration_ms\":150}",
      "created_at": "2025-01-01 12:00:00"
    }
  ]
}
```

---

## 提醒 API

挂载路径：`/api/reminders`。**所有接口需要登录 session。**

### GET /api/reminders

获取当前用户的所有提醒。

**请求示例**：

```bash
curl "https://bot-talk.com/api/reminders" -b cookies.txt
```

**成功响应**：

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "user_id": 1,
      "title": "喝水提醒",
      "message": "记得喝水",
      "time": "09:00",
      "type": "daily",
      "enabled": 1,
      "send_count": 5,
      "max_count": 0,
      "created_at": "2025-01-01 00:00:00"
    }
  ]
}
```

### POST /api/reminders

创建新提醒。

**请求 Body**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | 提醒标题 |
| message | string | 否 | 提醒内容 |
| time | string | 是 | 触发时间，格式 `HH:MM` 或 `YYYY-MM-DDTHH:MM` |
| type | string | 否 | 类型：`once`（默认）、`daily`、`every2min`（体验用） |
| max_count | integer | 否 | 最大发送次数，0 表示无限制（默认 0） |

**请求示例**：

```bash
curl -X POST "https://bot-talk.com/api/reminders" \
  -H "Content-Type: application/json" \
  -d '{"title": "喝水提醒", "message": "记得喝水", "time": "09:00", "type": "daily"}' \
  -b cookies.txt
```

**成功响应**：

```json
{ "success": true, "id": 1 }
```

### DELETE /api/reminders/:id

删除指定提醒（同时删除关联的发送日志）。仅能删除自己的提醒。

**请求示例**：

```bash
curl -X DELETE "https://bot-talk.com/api/reminders/1" -b cookies.txt
```

**成功响应**：

```json
{ "success": true }
```

**错误响应**：

```json
{ "success": false, "error": "提醒不存在" }
```

### PATCH /api/reminders/:id/enable

启用或禁用指定提醒。

**请求 Body**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| enabled | boolean | 是 | `true` 启用，`false` 禁用 |

**请求示例**：

```bash
curl -X PATCH "https://bot-talk.com/api/reminders/1/enable" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}' \
  -b cookies.txt
```

**成功响应**：

```json
{ "success": true }
```

---

## 配置 API

### GET /api/config

获取服务器配置信息（公开接口，无需认证）。

**请求示例**：

```bash
curl "https://bot-talk.com/api/config"
```

**成功响应**：

```json
{ "base_url": "https://bot-talk.com" }
```

---

## 旧版 API（兼容）

以下接口来自旧版 `login.js`，仍然可用但建议迁移到新版 API。

### GET /api/login/qrcode（旧版）

获取登录二维码。建议迁移到 `POST /api/channels/qrcode-public`。

### GET /api/login/status/:qrcode（旧版）

查询扫码状态并自动绑定用户。建议迁移到 `GET /api/channels/bind-status-public/:qrcode`。

### POST /api/login/reset-key（旧版）

重置 SendKey（通过 `user_id` 即 `wechat_openid`）。建议迁移到 `POST /api/key/reset`。

**请求 Body**：`{ "user_id": "wechat_openid" }`

### GET /api/login/bind-status（旧版）

检查绑定状态。

**Query 参数**：`user_id` — 用户的 wechat_openid

### GET /api/login/push-logs（旧版）

获取推送日志。建议迁移到 `GET /api/push-logs`。

**Query 参数**：`user_id` — 用户的 wechat_openid

---

## 速率限制

| 限制类型 | 限额 | 说明 |
|---------|------|------|
| 推送 API | 每 SendKey 每小时 100 条 | 超限返回错误码 `42901` |

速率限制为内存计数，服务重启后重置。

---

## 通用说明

### 响应格式

API 有两种响应风格：

**推送 API**（`/notify`、`/{key}.send`）使用 `code` + `message` 风格：

```json
{ "code": 0, "message": "success", "data": { ... } }
```

**管理 API**（`/api/auth`、`/api/channels` 等）使用 `success` 布尔值风格：

```json
{ "success": true, "data": { ... } }
{ "success": false, "error": "错误信息" }
```

> **一致性说明**：两套 API 的响应格式不同。推送 API 使用数字错误码以兼容 Server酱生态，管理 API 使用布尔 `success` 字段。调用时请注意区分。

### 自部署 vs 托管服务差异

| 项目 | 自部署 | 托管服务 |
|------|--------|---------|
| BASE_URL | 自行配置 | `https://bot-talk.com` |
| SESSION_SECRET | 建议通过环境变量设置固定值 | 已配置 |
| 数据存储 | 本地 SQLite（`data/bottalk.db`） | 同 |
| 通道上限 | 每用户 10 个 | 同 |
| 速率限制 | 每 Key 每小时 100 条（可自行修改代码） | 同 |

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3000 | 服务端口 |
| BASE_URL | `http://localhost:{PORT}` | 对外 URL |
| SESSION_SECRET | 随机生成 | Session 加密密钥（重启后变化，建议固定） |

### CORS

服务默认启用 CORS（`cors()`），允许所有来源跨域请求。

### 通道生命周期

1. **pending** — 已扫码绑定，等待用户在微信中发送第一条消息
2. **active** — 已激活，可正常接收推送
3. **inactive** — 已停用（手动删除、token 过期、session 失效）

通道 token 过期（iLink 返回 `ret: -14` 或 HTTP 401/403）时，系统自动将通道标记为 `inactive`。需要用户重新扫码绑定以恢复。
