# Security Policy

## 报告安全漏洞

如果你发现 BotTalk 的安全漏洞，请**不要**在公开 Issue 中报告。

请通过以下方式联系我们：

- Email: bot-talk-k@users.noreply.github.com
- 标题请注明：`[BotTalk Security]`

我们会在 48 小时内确认收到，并尽快修复。

## 支持的版本

| 版本 | 支持状态 |
|------|----------|
| latest (main) | 支持 |

## 安全建议

自部署用户请注意：

- 使用 HTTPS 反向代理（Nginx/Caddy）
- 设置独立的 `SESSION_SECRET` 环境变量
- 定期更新依赖：`npm audit && npm update`
- 限制 Docker 容器的网络和资源访问
