#!/bin/bash
# BotTalk k3s 部署脚本（self-hosted runner 专用）
# 用法：./scripts/deploy-k3s-ci.sh [dev|prod]
# 默认：dev
#
# 此脚本专为 GitHub Actions self-hosted runner 设计
# - 不碰 nginx
# - 不碰生产环境（除非显式指定 prod）
# - 只更新 k3s 镜像和 deployment

set -e

ENV="${1:-dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# 命名空间和 NodePort 配置
if [ "$ENV" = "dev" ]; then
  NAMESPACE="bottalk-dev"
  NODEPORT_APP=30200
  NODEPORT_FEISHU=30201
  NODEPORT_WECOM=30202
  NODEPORT_PORTAL=30203
elif [ "$ENV" = "prod" ]; then
  NAMESPACE="bottalk"
  NODEPORT_APP=30100
  NODEPORT_FEISHU=30101
  NODEPORT_WECOM=30102
  NODEPORT_PORTAL=30103
else
  echo "❌ 用法: $0 [dev|prod]"
  exit 1
fi

echo "========================================"
echo " BotTalk k3s 部署"
echo " 环境: $ENV"
echo " 命名空间: $NAMESPACE"
echo "========================================"

cd "$PROJECT_ROOT"

# Step 1: 构建 Docker 镜像
echo ""
echo "[1/4] 构建 Docker 镜像..."
docker build -t bottalk-app:latest .
docker build -t bottalk-feishu:latest ./feishu
docker build -t bottalk-wecom:latest ./wecom
docker build -t bottalk-portal:latest ./portal
echo "✅ 镜像构建完成"

# Step 2: 导出镜像并导入到 k3s 所有节点
echo ""
echo "[2/4] 分发镜像到 k3s 节点..."
NODES=$(kubectl get nodes -o jsonpath='{.items[*].status.addresses[?(@.type=="InternalIP")].address}')

for node_ip in $NODES; do
  echo "  → 导入到 $node_ip"
  docker save bottalk-app:latest bottalk-feishu:latest bottalk-wecom:latest bottalk-portal:latest | \
    ssh -o StrictHostKeyChecking=no root@$node_ip \
    "ctr -a /run/k3s/containerd/containerd.sock -n k8s.io images import -"
done
echo "✅ 镜像分发完成"

# Step 3: 滚动更新 deployment
echo ""
echo "[3/4] 滚动更新 deployment..."
for deploy in bottalk-app bottalk-feishu bottalk-wecom bottalk-portal; do
  echo "  → 重启 $deploy"
  kubectl rollout restart deployment/$deploy -n $NAMESPACE
done

# Step 4: 等待 rollout 完成
echo ""
echo "[4/4] 等待 rollout 完成..."
for deploy in bottalk-app bottalk-feishu bottalk-wecom bottalk-portal; do
  kubectl rollout status deployment/$deploy -n $NAMESPACE --timeout=120s
done

echo ""
echo "========================================"
echo "✅ 部署完成: $ENV"
echo "========================================"
kubectl get pods -n $NAMESPACE
