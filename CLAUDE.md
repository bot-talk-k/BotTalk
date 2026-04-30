# BotTalk 项目规则

## 时区：默认北京时间（UTC+8）

**用户位于北京时间**。所有与用户讨论的时间默认是北京时间，不要用 UTC。

**SQLite `created_at`、`docker logs` 时间戳全部是 UTC**——引用这些时间陈述给用户时，**必须** `+8h` 显式转换成北京时间再说出口。例：log 里 `13:05:21` → 要说"北京 21:05:21"，不要说"13:05"让用户误以为是下午 1 点。

**绝不**根据 UTC 小时判断"用户现在是早上/晚上/睡觉时间"——以 [.claude/hooks/inject-time.js](.claude/hooks/inject-time.js) 注入的"当前北京时间上下文"为准。

## 部署：禁止 scp，唯一入口是 ./deploy.sh

**强制规则**：所有部署只能通过本地 `./deploy.sh` 执行。**禁止**任何形式的：
- `scp <file> rn:/opt/bottalk/...`
- `ssh rn "vi /opt/bottalk/..."`
- 任何在服务器上手动改代码的操作

**为什么**：项目曾因为手动 scp 漏文件导致服务器跑旧代码（见 commit `9607943` 部署事故 — 4 文件中只 scp 了 1 个，剩下 3 个文件服务器一直是旧版，用户误以为修复生效）。git 现在是唯一真理来源：本地 → push → 服务器 git pull → rebuild。

**正确流程**：
```bash
# 本地改完代码，commit + 部署一步到位
./deploy.sh "fix: xxx"

# 或者已经 commit 了，直接部署
./deploy.sh
```

deploy.sh 内部做：本地 commit（如有传参）→ push origin/main → ssh 服务器 `git fetch + git reset --hard origin/main + docker compose up -d --build` → 验证容器健康。

**例外**：`docker exec bottalk node -e "..."` 这种**只读**的服务器调试是 OK 的（看数据库、看日志）。但**改代码**绝对不行。

## 服务器信息

- SSH 别名：`rn`（RackNerd VPS）
- 项目路径：`/opt/bottalk`
- 数据库：SQLite，挂载在 `/opt/bottalk/data/`（`.gitignore` 排除，docker rebuild 不会动）
- 服务器代码：通过 git 跟踪 `origin/main`，由 `deploy.sh` 自动同步

## 数据库迁移

加 migration 时**必须**写在 `db.js` 末尾（在 `// ── Helpers ──` 之前），用 `hasRun(N) / markRun(N)` 模式，递增 N。**禁止**直接在服务器跑 SQL — 否则下次部署可能冲突。
