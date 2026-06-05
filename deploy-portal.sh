#!/usr/bin/env bash
# 门户(官网 + 综合看板)部署入口 — 独立,微信/飞书/企业微信容器完全不动。
#
# 用法:
#   ./deploy-portal.sh                    # 部署当前 HEAD
#   ./deploy-portal.sh "commit message"   # 自动 commit + 部署

set -e

REMOTE_HOST="rn"
REMOTE_PATH="/opt/bottalk"
BRANCH="main"
LOCAL_REMOTE="bot-talk-k"
SERVER_REMOTE="origin"
COMPOSE="docker-compose.portal.yml"

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

LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse $LOCAL_REMOTE/$BRANCH 2>/dev/null || echo "none")
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo "📤 推送到 $LOCAL_REMOTE/$BRANCH..."
  git push $LOCAL_REMOTE $BRANCH
fi

echo "🌐 部署门户到服务器..."
ssh $REMOTE_HOST "cd $REMOTE_PATH && \
  git fetch $SERVER_REMOTE && \
  git reset --hard $SERVER_REMOTE/$BRANCH && \
  echo '─── 当前服务器 HEAD ───' && \
  git log --oneline -3 && \
  echo '─── 确保 portal-data 卷目录存在且容器用户(uid 999)可写 ───' && \
  mkdir -p portal-data && (chown 999:999 portal-data 2>/dev/null || chmod 777 portal-data) && \
  echo '─── 清理可能残留的 shadow 容器 ───' && \
  docker ps -a --filter 'name=_bottalk-portal' --format '{{.ID}}' | xargs -r docker rm -f 2>/dev/null || true && \
  echo '─── 重建 portal 容器 ───' && \
  if ! docker compose -f $COMPOSE up -d --build 2>&1 | tail -12; then \
    echo '⚠️  首次 up 失败,清理 bottalk-portal 后重试...' && \
    docker rm -f bottalk-portal 2>/dev/null || true && \
    docker compose -f $COMPOSE up -d --build 2>&1 | tail -12; \
  fi"

echo "🩺 验证容器..."
ssh $REMOTE_HOST "docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep bottalk"
ssh $REMOTE_HOST "docker ps --format '{{.Names}}' | grep -q '^bottalk-portal$'" || {
  echo "❌ bottalk-portal 容器未在运行,请手动检查"
  exit 1
}
ssh $REMOTE_HOST "docker ps --format '{{.Names}}' | grep -q '^bottalk$'" || {
  echo "⚠️  微信站 bottalk 容器不在运行 —— 门户部署不该影响它,请检查!"
  exit 1
}

echo "✅ 门户部署完成(各渠道容器不受影响)"
