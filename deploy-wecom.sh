#!/usr/bin/env bash
# 企业微信独立站部署入口 — 与 deploy.sh(微信)/deploy-feishu.sh 完全独立,互不影响。
#
# 流程:本地 commit + push → 服务器 git pull → 只 rebuild wecom 容器
# 微信站 bottalk / 飞书站 bottalk-feishu 完全不动。
#
# 用法:
#   ./deploy-wecom.sh                    # 部署当前 HEAD
#   ./deploy-wecom.sh "commit message"   # 自动 commit + 部署

set -e

REMOTE_HOST="rn"
REMOTE_PATH="/opt/bottalk"
BRANCH="main"
LOCAL_REMOTE="bot-talk-k"
SERVER_REMOTE="origin"
COMPOSE="docker-compose.wecom.yml"

# 1. 未提交改动?
if [ -n "$(git status --porcelain)" ]; then
  if [ -n "$1" ]; then
    echo "📝 自动提交..."
    git add -A
    git commit -m "$1"
  else
    echo "⚠️  本地有未提交改动。先 commit 或传 commit message。"
    git status -s
    exit 1
  fi
fi

# 2. push
LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse $LOCAL_REMOTE/$BRANCH 2>/dev/null || echo "none")
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo "📤 推送到 $LOCAL_REMOTE/$BRANCH..."
  git push $LOCAL_REMOTE $BRANCH
fi

# 3. 服务器 pull + 只重建 wecom 容器
echo "🏢 部署企业微信站到服务器..."
ssh $REMOTE_HOST "cd $REMOTE_PATH && \
  git fetch $SERVER_REMOTE && \
  git reset --hard $SERVER_REMOTE/$BRANCH && \
  echo '─── 当前服务器 HEAD ───' && \
  git log --oneline -3 && \
  echo '─── 确保 wecom-data 卷目录存在且容器用户(uid 999)可写 ───' && \
  mkdir -p wecom-data && (chown 999:999 wecom-data 2>/dev/null || chmod 777 wecom-data) && \
  echo '─── 清理可能残留的 shadow 容器 ───' && \
  docker ps -a --filter 'name=_bottalk-wecom' --format '{{.ID}}' | xargs -r docker rm -f 2>/dev/null || true && \
  echo '─── 重建 wecom 容器 ───' && \
  if ! docker compose -f $COMPOSE up -d --build 2>&1 | tail -12; then \
    echo '⚠️  首次 up 失败,清理 bottalk-wecom 后重试...' && \
    docker rm -f bottalk-wecom 2>/dev/null || true && \
    docker compose -f $COMPOSE up -d --build 2>&1 | tail -12; \
  fi"

# 4. 验证 — wecom 容器健康 + 微信站/飞书站仍在跑
echo "🩺 验证容器..."
ssh $REMOTE_HOST "docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep bottalk"
ssh $REMOTE_HOST "docker ps --format '{{.Names}}' | grep -q '^bottalk-wecom$'" || {
  echo "❌ bottalk-wecom 容器未在运行,请手动检查"
  exit 1
}
ssh $REMOTE_HOST "docker ps --format '{{.Names}}' | grep -q '^bottalk$'" || {
  echo "⚠️  微信站 bottalk 容器不在运行 —— 企业微信部署不该影响它,请检查!"
  exit 1
}

echo "✅ 企业微信站部署完成(微信站 / 飞书站不受影响)"
