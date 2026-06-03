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
# 注:docker compose recreate 偶尔会留下 shadow 容器(名为 <random>_bottalk)阻塞
# rename,造成 Conflict 错误,部署假装成功但容器跑老代码。2026-05-21 / 2026-06-03
# 各踩一次。这里 build 前先清残留 + 用 --remove-orphans,build 失败时自动清理重试。
echo "🚀 部署到服务器..."
ssh $REMOTE_HOST "cd $REMOTE_PATH && \
  git fetch $SERVER_REMOTE && \
  git reset --hard $SERVER_REMOTE/$BRANCH && \
  echo '─── 当前服务器 HEAD ───' && \
  git log --oneline -3 && \
  echo '─── 清理可能残留的 shadow 容器 ───' && \
  docker ps -a --filter 'name=_bottalk' --format '{{.Names}} {{.ID}}' | grep -v bottalk-feishu | awk '{print $2}' | xargs -r docker rm -f 2>/dev/null || true && \
  echo '─── 重建容器(不用--remove-orphans,避免误删 bottalk-feishu)───' && \
  if ! docker compose up -d --build 2>&1 | tail -10; then \
    echo '⚠️  首次 up 失败,清理 bottalk 容器后重试...' && \
    docker rm -f bottalk 2>/dev/null || true && \
    docker compose up -d --build 2>&1 | tail -10; \
  fi"

# 4. 验证 — 必须确认 IMAGE 是 bottalk-app(不是 sha256 hash 表示老 image 残留)
echo "🩺 验证容器..."
ssh $REMOTE_HOST "docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep bottalk"
ssh $REMOTE_HOST "docker ps --format '{{.Image}}' --filter name='^/bottalk$' | grep -q 'bottalk-app$'" || \
ssh $REMOTE_HOST "docker inspect bottalk --format '{{.Config.Image}}' | grep -q 'bottalk-app'" || {
  echo "❌ 容器跑的不是最新 image — 可能残留 shadow,请手动检查"
  exit 1
}

echo "✅ 部署完成"
