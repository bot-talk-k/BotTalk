#!/bin/bash
# Deploy BotTalk to k3s (dev or prod)
# Usage: ./deploy-k3s.sh [dev|prod]
# Default: dev

set -e

ENV="${1:-dev}"
REPO_DIR="/home/liqiang/bottalk"

if [ "$ENV" = "dev" ]; then
  NAMESPACE="bottalk-dev"
  NODEPORT_APP=30200
  NODEPORT_FEISHU=30201
  NODEPORT_WECOM=30202
  NODEPORT_PORTAL=30203
  BASE_URL="https://dev.bot-talk.com"
  FEISHU_BASE_URL="https://dev.bot-talk.com/feishu-app"
  WECOM_BASE_URL="https://dev.bot-talk.com/wecom-app"
  PORTAL_BASE_URL="https://dev.bot-talk.com/portal-app"
  WECHAT_SITE_URL="https://dev.bot-talk.com"
elif [ "$ENV" = "prod" ]; then
  NAMESPACE="bottalk"
  NODEPORT_APP=30100
  NODEPORT_FEISHU=30101
  NODEPORT_WECOM=30102
  NODEPORT_PORTAL=30103
  BASE_URL="https://bot-talk.com"
  FEISHU_BASE_URL="https://feishu.bot-talk.com"
  WECOM_BASE_URL="https://wecom.bot-talk.com"
  PORTAL_BASE_URL="https://portal.bot-talk.com"
  WECHAT_SITE_URL="https://bot-talk.com"
else
  echo "Usage: $0 [dev|prod]"
  exit 1
fi

echo "========================================"
echo " Deploy BotTalk to: $ENV"
echo " Namespace: $NAMESPACE"
echo " NodePorts: $NODEPORT_APP-$NODEPORT_PORTAL"
echo "========================================"

# Step 1: Pull latest code
echo ""
echo "[1/6] Pulling latest code..."
cd "$REPO_DIR"
git pull origin main

# Step 2: Ensure namespace exists
echo ""
echo "[2/6] Ensuring namespace $NAMESPACE exists..."
kubectl get ns "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"

# Step 3: Apply ConfigMap + Secret + PVCs
echo ""
echo "[3/6] Applying config..."
cat <<EOF | kubectl apply -n "$NAMESPACE" -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: bottalk-config
data:
  TZ: "Asia/Shanghai"
  NODE_ENV: "production"
  BASE_URL: "$BASE_URL"
  FEISHU_BASE_URL: "$FEISHU_BASE_URL"
  WECHAT_SITE_URL: "$WECHAT_SITE_URL"
  WECOM_BASE_URL: "$WECOM_BASE_URL"
  PORTAL_BASE_URL: "$PORTAL_BASE_URL"
  FEISHU_INTERNAL_URL: "http://bottalk-feishu:3000"
  WECOM_INTERNAL_URL: "http://bottalk-wecom:3000"
  INTERNAL_STATS_TOKEN: ""
  SUPERADMIN_FEISHU_SENDKEY: ""
  PORTAL_ADMIN_PASSWORD: ""
---
apiVersion: v1
kind: Secret
metadata:
  name: bottalk-secret
type: Opaque
data:
  SESSION_SECRET: Q0hBTkdFX01FX1RPX0FfUkFORE9NX1NFQ1JFVA==
  INTERNAL_STATS_TOKEN: ""
  SUPERADMIN_FEISHU_SENDKEY: ""
  PORTAL_ADMIN_PASSWORD: ""
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: bottalk-data
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 2Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: feishu-data
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 2Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: wecom-data
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 2Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: portal-data
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
EOF

# Step 4: Build Docker images
echo ""
echo "[4/6] Building Docker images..."
docker build -t bottalk-app:latest .
docker build -t bottalk-feishu:latest ./feishu
docker build -t bottalk-wecom:latest ./wecom
docker build -t bottalk-portal:latest ./portal

# Step 5: Import images into k3s containerd
echo ""
echo "[5/6] Importing images into k3s..."
CTR="sudo ctr -a /run/k3s/containerd/containerd.sock -n k8s.io"
for img in bottalk-app bottalk-feishu bottalk-wecom bottalk-portal; do
  echo "  -> $img"
  docker save "$img:latest" | $CTR images import -
done

# Step 6: Apply Deployments + Services
echo ""
echo "[6/6] Deploying pods..."

deploy_service() {
  local name=$1
  local nodeport=$2
  cat <<EOF | kubectl apply -n "$NAMESPACE" -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $name
  labels:
    app.kubernetes.io/name: $name
    app.kubernetes.io/part-of: bottalk
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: $name
  template:
    metadata:
      labels:
        app.kubernetes.io/name: $name
        app.kubernetes.io/part-of: bottalk
    spec:
      containers:
        - name: $name
          image: ${name}:latest
          imagePullPolicy: Never
          ports:
            - containerPort: 3000
          envFrom:
            - configMapRef:
                name: bottalk-config
            - secretRef:
                name: bottalk-secret
          env:
            - name: PORT
              value: "3000"
          volumeMounts:
            - name: data
              mountPath: /app/data
          resources:
            requests:
              memory: "128Mi"
              cpu: "50m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          readinessProbe:
            httpGet:
              path: /api/config
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /api/config
              port: 3000
            initialDelaySeconds: 30
            periodSeconds: 30
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: ${name#bottalk-}-data
      restartPolicy: Always
---
apiVersion: v1
kind: Service
metadata:
  name: $name
  labels:
    app.kubernetes.io/name: $name
spec:
  type: NodePort
  ports:
    - port: 3000
      targetPort: 3000
      nodePort: $nodeport
      name: http
  selector:
    app.kubernetes.io/name: $name
EOF
}

# Fix PVC names: bottalk-app uses "bottalk-data", others use "feishu-data" etc.
# Actually the claimName logic: bottalk-app -> bottalk-data, bottalk-feishu -> feishu-data, etc.
# Let me fix the deploy function's PVC mapping

deploy_app() {
  local name=$1
  local nodeport=$2
  local pvc=$3
  cat <<EOF | kubectl apply -n "$NAMESPACE" -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $name
  labels:
    app.kubernetes.io/name: $name
    app.kubernetes.io/part-of: bottalk
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: $name
  template:
    metadata:
      labels:
        app.kubernetes.io/name: $name
        app.kubernetes.io/part-of: bottalk
    spec:
      containers:
        - name: $name
          image: ${name}:latest
          imagePullPolicy: Never
          ports:
            - containerPort: 3000
          envFrom:
            - configMapRef:
                name: bottalk-config
            - secretRef:
                name: bottalk-secret
          env:
            - name: PORT
              value: "3000"
          volumeMounts:
            - name: data
              mountPath: /app/data
          resources:
            requests:
              memory: "128Mi"
              cpu: "50m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          readinessProbe:
            httpGet:
              path: /api/config
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /api/config
              port: 3000
            initialDelaySeconds: 30
            periodSeconds: 30
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: $pvc
      restartPolicy: Always
---
apiVersion: v1
kind: Service
metadata:
  name: $name
  labels:
    app.kubernetes.io/name: $name
spec:
  type: NodePort
  ports:
    - port: 3000
      targetPort: 3000
      nodePort: $nodeport
      name: http
  selector:
    app.kubernetes.io/name: $name
EOF
}

deploy_app "bottalk-app"    "$NODEPORT_APP"    "bottalk-data"
deploy_app "bottalk-feishu" "$NODEPORT_FEISHU" "feishu-data"
deploy_app "bottalk-wecom"  "$NODEPORT_WECOM"  "wecom-data"
deploy_app "bottalk-portal" "$NODEPORT_PORTAL" "portal-data"

# Wait for rollout
echo ""
echo "Waiting for pods to be ready..."
kubectl rollout status deployment/bottalk-app -n "$NAMESPACE" --timeout=120s
kubectl rollout status deployment/bottalk-feishu -n "$NAMESPACE" --timeout=120s
kubectl rollout status deployment/bottalk-wecom -n "$NAMESPACE" --timeout=120s
kubectl rollout status deployment/bottalk-portal -n "$NAMESPACE" --timeout=120s

echo ""
echo "=== Pods ==="
kubectl get pods -n "$NAMESPACE" -o wide
echo ""
echo "=== Services ==="
kubectl get svc -n "$NAMESPACE"
echo ""
echo "========================================"
echo " Deploy complete to $ENV!"
echo "========================================"
