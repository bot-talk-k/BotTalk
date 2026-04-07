# BotTalk 自部署指南

本文档面向想要在自己服务器上部署 BotTalk 的开发者。BotTalk 是一个开源的微信消息推送服务（类似 Server酱），基于 Node.js + SQLite，通过 Docker 一键部署。

---

## 目录

- [环境要求](#环境要求)
- [快速开始（5 分钟部署）](#快速开始5-分钟部署)
- [详细配置说明](#详细配置说明)
- [反向代理配置](#反向代理配置)
- [数据持久化与备份](#数据持久化与备份)
- [更新升级](#更新升级)
- [故障排查](#故障排查)
- [生产环境最佳实践](#生产环境最佳实践)

---

## 环境要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Linux（推荐）、macOS、Windows |
| Docker | >= 20.10 |
| Docker Compose | >= 2.0（`docker compose` 命令形式） |
| 内存 | >= 256MB 可用内存 |
| 磁盘 | >= 100MB（数据库随使用量增长） |
| 域名 | 可选，推荐用于 HTTPS 访问 |
| 网络 | 服务器需能访问外网（调用微信 iLink Bot API） |

检查 Docker 版本：

```bash
docker --version
docker compose version
```

---

## 快速开始（5 分钟部署）

### 1. 克隆项目

```bash
git clone https://github.com/bot-talk-k/BotTalk.git
cd bottalk
```

### 2. 创建配置文件

```bash
cp .env.example .env
```

编辑 `.env`，至少修改 `BASE_URL` 为你的实际访问地址：

```bash
# 改为你的域名或 IP
BASE_URL=https://yourdomain.com

# 生产环境建议设置固定的 SESSION_SECRET
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

### 3. 启动服务

```bash
docker compose up -d
```

### 4. 验证部署

```bash
# 健康检查
curl http://localhost:3000/api/config

# 应返回类似：{"base_url":"https://yourdomain.com"}
```

打开浏览器访问 `http://服务器IP:3000` 即可看到 BotTalk 界面。

---

## 详细配置说明

### 环境变量（.env）

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `PORT` | 否 | `3000` | 服务监听端口。容器内部始终监听 3000，此变量控制宿主机映射端口 |
| `BASE_URL` | 是 | `http://localhost:3000` | 对外访问的基础 URL，用于生成二维码和 API 示例。如使用反向代理加了路径前缀，也要写进去（如 `https://yourdomain.com/bottalk`） |
| `SESSION_SECRET` | 否 | 每次启动随机生成 | Session 签名密钥。留空则每次重启后已登录的 session 失效。**生产环境务必设置固定值** |
| `TZ` | 否 | `Asia/Shanghai` | 容器时区，影响定时提醒的触发时间 |

生成 `SESSION_SECRET` 的方法：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### docker-compose.yml（基础配置）

```yaml
services:
  app:
    build: .                          # 从 Dockerfile 构建镜像
    container_name: bottalk
    ports:
      - "${PORT:-3000}:3000"          # 宿主机端口映射，默认 3000
    env_file:
      - .env                          # 加载环境变量
    volumes:
      - ./data:/app/data              # SQLite 数据持久化到宿主机 data/ 目录
    restart: unless-stopped           # 崩溃后自动重启（手动停止除外）
    healthcheck:                      # 每 30 秒检查服务健康状态
      test: ["CMD", "node", "-e", "..."]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s              # 启动后 15 秒开始检查
    logging:
      driver: json-file
      options:
        max-size: "10m"               # 单个日志文件最大 10MB
        max-file: "3"                 # 最多保留 3 个日志文件
```

### docker-compose.prod.yml（生产覆盖配置）

生产环境建议叠加此配置。与基础配置的区别：

| 配置项 | 基础配置 | 生产配置 |
|--------|----------|----------|
| `restart` | `unless-stopped` | `always`（始终重启） |
| 端口绑定 | `0.0.0.0:3000` | `127.0.0.1:3000`（仅本地，需配合反向代理） |
| `NODE_ENV` | 未设置 | `production` |
| 资源限制 | 无 | 内存 256MB，CPU 1 核 |
| 日志大小 | 10MB x 3 | 50MB x 5 |

使用方式：

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## 反向代理配置

生产环境建议使用反向代理来提供 HTTPS 和域名访问。使用生产配置后端口只绑定 `127.0.0.1`，必须通过反向代理暴露。

### Nginx 配置

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    # 自动跳转 HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate     /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 支持
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### Nginx 带路径前缀（如 /bottalk）

```nginx
location /bottalk/ {
    proxy_pass http://127.0.0.1:3000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

使用路径前缀时，`.env` 中的 `BASE_URL` 也要包含路径：

```
BASE_URL=https://yourdomain.com/bottalk
```

### Cloudflare Tunnel

如果你使用 Cloudflare Tunnel，无需在服务器上配置 SSL 证书。

1. 安装 `cloudflared` 并登录：

```bash
cloudflared tunnel login
cloudflared tunnel create bottalk
```

2. 编辑 `~/.cloudflared/config.yml`：

```yaml
tunnel: <your-tunnel-id>
credentials-file: /root/.cloudflared/<your-tunnel-id>.json

ingress:
  - hostname: bottalk.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

3. 启动 Tunnel：

```bash
cloudflared tunnel run bottalk
```

4. 在 Cloudflare DNS 中添加 CNAME 记录，指向 `<your-tunnel-id>.cfargotunnel.com`。

5. 更新 `.env`：

```
BASE_URL=https://bottalk.yourdomain.com
```

### Caddy（简单替代方案）

Caddy 自动管理 HTTPS 证书，配置最简单：

```
yourdomain.com {
    reverse_proxy localhost:3000
}
```

带路径前缀：

```
yourdomain.com {
    handle_path /bottalk/* {
        reverse_proxy localhost:3000
    }
}
```

Caddy 配置文件通常位于 `/etc/caddy/Caddyfile`，修改后执行 `systemctl reload caddy`。

---

## 数据持久化与备份

### 数据库位置

所有数据存储在 SQLite 数据库中，通过 Docker volume 映射到宿主机：

```
./data/bottalk.db      # 主数据库
./data/bottalk.db-wal   # WAL 日志（正常现象，提升并发性能）
./data/bottalk.db-shm   # 共享内存文件
```

`data/` 目录由 `docker-compose.yml` 中的 `volumes: - ./data:/app/data` 映射，容器删除重建后数据不会丢失。

### 备份脚本

创建 `backup.sh`：

```bash
#!/bin/bash
# BotTalk 数据库备份脚本

BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DATA_DIR="./data"

mkdir -p "$BACKUP_DIR"

# 使用 SQLite 的 .backup 命令进行热备份（不影响运行中的服务）
docker exec bottalk node -e "
  const db = require('better-sqlite3')('/app/data/bottalk.db');
  db.backup('/app/data/backup_temp.db').then(() => {
    console.log('Backup completed');
    process.exit(0);
  });
" && cp "$DATA_DIR/backup_temp.db" "$BACKUP_DIR/bottalk_${TIMESTAMP}.db" \
  && rm -f "$DATA_DIR/backup_temp.db"

# 如果上面的方式失败，可以直接复制文件（确保写入暂停）
# cp "$DATA_DIR/bottalk.db" "$BACKUP_DIR/bottalk_${TIMESTAMP}.db"

# 保留最近 7 天的备份
find "$BACKUP_DIR" -name "bottalk_*.db" -mtime +7 -delete

echo "Backup saved to $BACKUP_DIR/bottalk_${TIMESTAMP}.db"
```

```bash
chmod +x backup.sh
```

简化版备份（直接复制，适用于低负载场景）：

```bash
# 直接复制数据库文件
cp ./data/bottalk.db ./backups/bottalk_$(date +%Y%m%d).db
```

设置定时备份（crontab）：

```bash
# 每天凌晨 3 点备份
0 3 * * * cd /path/to/bottalk && ./backup.sh >> /var/log/bottalk-backup.log 2>&1
```

### 恢复步骤

```bash
# 1. 停止服务
docker compose down

# 2. 备份当前数据库（以防万一）
cp ./data/bottalk.db ./data/bottalk.db.old

# 3. 用备份文件替换
cp ./backups/bottalk_20260401_030000.db ./data/bottalk.db

# 4. 删除 WAL 文件（恢复时需要清除）
rm -f ./data/bottalk.db-wal ./data/bottalk.db-shm

# 5. 重新启动
docker compose up -d
```

---

## 更新升级

### 标准更新流程

```bash
cd /path/to/bottalk

# 1. 拉取最新代码
git pull

# 2. 重新构建并启动（--build 强制重新构建镜像）
docker compose up -d --build
```

如果使用生产配置：

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

### 数据库自动迁移

BotTalk 使用基于版本号的自动迁移机制（见 `db.js`）。每次启动时，应用会检查 `schema_version` 表，自动执行尚未运行的迁移。你不需要手动执行任何数据库变更，更新代码后重启即可。

当前迁移版本包括：
- v1: 基础表（users、reminders、push_logs、logs）
- v2: channels 频道表
- v3: 旧数据迁移到 channels
- v4: sessions 会话表
- v5: activity_logs 活动日志表
- v6: push_logs 增加 channel_id
- v7: users 增加 email 字段
- v8: push_logs 增加 response 字段
- v9: reminders 增加 send_count 和 max_count

---

## 故障排查

### 查看日志

```bash
# 查看实时日志
docker compose logs -f

# 查看最近 100 行日志
docker compose logs --tail 100

# 查看容器状态和健康检查结果
docker inspect bottalk --format='{{json .State.Health}}' | python3 -m json.tool
```

### 健康检查端点

```bash
curl http://localhost:3000/api/config
# 正常返回：{"base_url":"https://..."}
```

### 常见问题

**Q: 容器启动后立即退出**

```bash
# 查看退出日志
docker compose logs app

# 常见原因：端口被占用
# 解决：修改 .env 中的 PORT 或停止占用端口的服务
sudo lsof -i :3000
```

**Q: 访问页面白屏或 502**

- 检查容器是否正常运行：`docker compose ps`
- 检查健康状态是否 healthy：`docker inspect bottalk --format='{{.State.Health.Status}}'`
- 确认反向代理配置中的端口与 `.env` 中的 `PORT` 一致

**Q: 二维码扫码后无法绑定**

- 确认 `.env` 中 `BASE_URL` 设置正确，浏览器能通过该 URL 访问到服务
- 确认服务器能访问外网（iLink Bot API）

**Q: 重启后需要重新登录**

- 未设置 `SESSION_SECRET`。每次启动随机生成密钥，重启后旧 session 失效
- 解决：在 `.env` 中设置固定的 `SESSION_SECRET`

**Q: 定时提醒时间不对**

- 检查 `.env` 中的 `TZ` 时区设置
- 默认是 `Asia/Shanghai`（UTC+8）

**Q: 数据库文件权限错误**

```bash
# 确保 data 目录有正确权限
sudo chown -R 1000:1000 ./data
```

---

## 生产环境最佳实践

### 1. 使用生产配置文件

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

生产配置会：
- 将端口绑定限制为 `127.0.0.1`（只允许反向代理访问）
- 设置 `NODE_ENV=production`
- 限制容器资源（256MB 内存，1 CPU）
- 增大日志轮转空间（50MB x 5）

### 2. 设置固定 SESSION_SECRET

```bash
# 生成并写入 .env
echo "SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" >> .env
```

### 3. 日志轮转

Docker 的 `json-file` 日志驱动已在 `docker-compose.yml` 中配置了轮转（基础配置 10MB x 3，生产配置 50MB x 5）。如需进一步管理，可配合 logrotate。

### 4. 定期备份

参考上方 [数据持久化与备份](#数据持久化与备份) 章节，设置 crontab 定时备份。

### 5. 监控建议

利用健康检查端点进行简单监控：

```bash
# 简单的可用性检查脚本
#!/bin/bash
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/config)
if [ "$RESPONSE" != "200" ]; then
    echo "BotTalk is down! HTTP status: $RESPONSE" | mail -s "BotTalk Alert" admin@yourdomain.com
fi
```

也可以对接 Uptime Kuma、Prometheus 等监控工具，定期请求 `/api/config` 检查可用性。

### 6. 防火墙

如果使用生产配置（端口绑定 127.0.0.1），无需额外配置防火墙规则。如果使用基础配置，建议通过防火墙限制 3000 端口的外部访问：

```bash
# UFW 示例
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 3000/tcp
sudo ufw enable
```
