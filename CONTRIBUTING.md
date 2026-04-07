# Contributing to BotTalk

感谢你对 BotTalk 的关注！欢迎提交 Issue 和 Pull Request。

## 如何参与

### 报告 Bug

- 在 [GitHub Issues](https://github.com/bot-talk-k/BotTalk/issues) 提交
- 请包含：复现步骤、期望行为、实际行为、环境信息（OS、Node 版本、Docker 版本）

### 提交 PR

1. Fork 仓库
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m "Add your feature"`
4. 推送分支：`git push origin feature/your-feature`
5. 创建 Pull Request

### 开发环境

```bash
git clone https://github.com/bot-talk-k/BotTalk.git
cd bottalk
cp .env.example .env  # 编辑配置
npm install
node app.js
```

### 代码规范

- 使用 2 空格缩进
- 提交信息使用中文或英文均可
- 新增 API 请更新 `docs/openapi.yaml`

## SDK 开发

SDK 位于 `sdk/` 目录下，各语言独立维护：

- `sdk/python/` — Python SDK
- `sdk/node/` — Node.js SDK
- `sdk/go/` — Go SDK

修改 SDK 后请确保对应测试通过。

## License

提交代码即表示你同意以 [MIT](LICENSE) 协议开源你的贡献。
