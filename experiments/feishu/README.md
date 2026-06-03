# 飞书通道 MVP 原型

> ⚠️ 这是 **隔离实验目录**,不是 bot-talk 的生产代码。验证完飞书 Device Flow + 无 10 条限流后,会迁出 channels 表 + 主链路。

## 设计意图

bot-talk 主通道(微信 ClawBot/iLink)的根本痛点是**强制双向"聊天"** + ~10 条限流。X4/X5 失联状态机只是兜底,无法绕开。

**飞书新机制**:`@larksuite/openclaw-lark-tools` 通过 `archetype=PersonalAgent` 的 Device Flow,用户扫码授权 → 客户端代用户创建飞书 app + 拿凭证,**完全不接触飞书后台**。TomAI 已实测,bot-talk 借鉴。

MVP 目标:**自己跑通"扫码 → 拿到 appId/Secret → 发 20+ 条无限流"** 这一最小验证路径。

## 文件结构

```
experiments/feishu/
├── auth.js     - Device Flow OAuth 封装(start/poll/validate)
├── client.js   - REST 发消息(getTenantToken 缓存 + sendText)
├── routes.js   - 5 个 admin-only endpoint
└── README.md   - (本文件)

public/feishu-proto.html   - 测试页(QR + 发送表单 + 计数器 + 连发 20 条)

data/feishu-proto.json     - 绑定凭证(运行时生成,gitignore 已覆盖 data/)
```

## 启用方式

**默认关闭**(生产 deploy 默认不挂载)。本地测试:

```bash
ENABLE_FEISHU_PROTO=1 npm start
# 浏览器 http://localhost:3000/feishu-proto.html (admin 账号登录)
```

## 自验流程

1. **绑定**:打开测试页,选 "飞书(国内)" → 点 "开始绑定" → 用飞书 App 扫 QR → 选 "一键创建机器人" → 确认 → 页面显示 "已绑定 ✓"。
2. **首发**:输入文字 → 点 "单条发送" → 飞书 App 收到消息。
3. **限流压测**:点 "连发 20 条" → 飞书 App 应收到全部 20 条(对照 iLink 的 9-10 条断点)。后端串行间隔 500ms,前端实时计数。
4. **长期验证**(可选,7-14 天后):
   - 不在飞书里给 bot 回复任何东西
   - 再点 "连发 20 条" → 应仍能全部送达(对照 iLink 的 "24h 不互动需重扫"——飞书侧不存在)。

## 验证里程碑(全部满足 = MVP 成功 → 排期正式版)

- [ ] 扫码绑定一次完成
- [ ] 单条发送成功
- [ ] 连发 20 条全部到达(关键:**对照 iLink 9-10 条限流**)
- [ ] 14 天后回测仍可发送(关键:**对照 iLink 时间衰减**)

## 后续清理

正式版上线后:
1. 把 Device Flow 集成进 `routes/channels.js`(绑定 flow 加 "飞书" 选项)
2. 把 sendText 集成进 `routes/notify.js handlePush`(按 channel_type dispatch)
3. 加 WebSocket 接收处理 inbound
4. 删 `experiments/feishu/` 整个目录 + `public/feishu-proto.html`
5. 删 `data/feishu-proto.json`

## API 端点速查

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/feishu-proto/status` | 当前绑定状态(脱敏) |
| POST | `/api/feishu-proto/qrcode/start` | 启动 Device Flow,返 QR URL + deviceCode |
| POST | `/api/feishu-proto/qrcode/poll` | 轮询绑定,完成时落地凭证 |
| POST | `/api/feishu-proto/send` | 发消息(可批量,body.count<=50) |
| POST | `/api/feishu-proto/list-chats` | 列出 bot 所在 chat(诊断用) |
| POST | `/api/feishu-proto/verify` | 验证当前凭证 |
| POST | `/api/feishu-proto/reset` | 清除当前绑定 |

全部需 admin role。
