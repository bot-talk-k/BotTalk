#!/usr/bin/env bash
# BotTalk 唯一部署入口
#
# 流程：本地 commit + push → 服务器 git pull → docker rebuild
# 禁止任何手动 scp 单文件部署，避免文件遗漏导致服务器跑旧代码。
#
# 用法：
#   ./deploy.sh                    # 部署 main 分支当前 HEAD
#   ./deploy.sh "commit message"   # 自动 commit 当前改动 + 部署
#
# 前置：
#   - 本地 git 已 push 到 origin/main
#   - 服务器 /opt/bottalk 已 git init 并跟踪 origin/main
#   - SSH 别名 rn 可用

set -e

REMOTE_HOST="rn"
REMOTE_PATH="/opt/bottalk"
BRANCH="main"
LOCAL_REMOTE="bot-talk-k"   # 本地 git remote 名（git remote -v 看）
SERVER_REMOTE="origin"      # 服务器 git remote 名（init 时用了 origin）

# 1. 本地有未提交改动（含 untracked）？提示
if [ -n "$(git status --porcelain)" ]; then
  if [ -n "$1" ]; then
    echo "📝 自动提交未提交改动..."
    git add -A
    git commit -m "$1"
  else
    echo "⚠️  本地有未提交改动。要么先 commit，要么传 commit message 作为参数。"
    git status -s
    exit 1
  fi
fi

# 2. 本地领先远端？push
LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse $LOCAL_REMOTE/$BRANCH 2>/dev/null || echo "none")
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo "📤 推送到 $LOCAL_REMOTE/$BRANCH..."
  git push $LOCAL_REMOTE $BRANCH
fi

# 3. 服务器 pull + rebuild
echo "🚀 部署到服务器..."
ssh $REMOTE_HOST "cd $REMOTE_PATH && \
  git fetch $SERVER_REMOTE && \
  git reset --hard $SERVER_REMOTE/$BRANCH && \
  echo '─── 当前服务器 HEAD ───' && \
  git log --oneline -3 && \
  echo '─── 重建容器 ───' && \
  docker compose up -d --build 2>&1 | tail -8"

# 4. 验证
echo "🩺 验证容器..."
ssh $REMOTE_HOST "docker ps --format '{{.Names}}: {{.Status}}' | grep bottalk"

echo "✅ 部署完成"
