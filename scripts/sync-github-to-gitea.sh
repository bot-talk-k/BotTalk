#!/bin/bash
# Sync GitHub -> Gitea, wait for CI, auto-deploy to dev
# Runs on homevps via cron every 5 minutes
#
# Flow: GitHub push → cron sync → Gitea CI → auto deploy to k3s

set -e

REPO_DIR="/home/liqiang/bottalk"
LOG_FILE="/home/liqiang/bottalk-sync.log"
STATE_FILE="/home/liqiang/.bottalk-last-deploy"
GITEA_API="http://192.168.3.22:18050/api/v1"
GITEA_TOKEN="d7a5cc54a4546d42ef5e4d9d73e202d0d3dcf459"
ENV="${1:-dev}"

log() {
  echo "[$(date)] $*" >> "$LOG_FILE"
}

log "=== Starting sync+deploy cycle ==="

cd "$REPO_DIR"

# Get current HEAD before sync
BEFORE_SHA=$(git rev-parse HEAD 2>/dev/null || echo "none")

# Fetch from GitHub
git fetch github --prune 2>&1 | tee -a "$LOG_FILE"

# Push to Gitea (origin)
git push origin --all --force 2>&1 | tee -a "$LOG_FILE"
git push origin --tags --force 2>&1 | tee -a "$LOG_FILE"

# Get new HEAD after sync
AFTER_SHA=$(git rev-parse HEAD)

log "Before: $BEFORE_SHA -> After: $AFTER_SHA"

# Check if there are new changes
if [ "$BEFORE_SHA" = "$AFTER_SHA" ]; then
  log "No new changes, skipping CI/deploy."
  exit 0
fi

# Check if already deployed this SHA
LAST_DEPLOYED=$(cat "$STATE_FILE" 2>/dev/null || echo "none")
if [ "$AFTER_SHA" = "$LAST_DEPLOYED" ]; then
  log "SHA $AFTER_SHA already deployed, skipping."
  exit 0
fi

log "New changes detected: $AFTER_SHA"
log "Waiting for CI to pass on Gitea..."

# Wait for CI to complete (poll every 30s, max 15 min)
MAX_WAIT=900
ELAPSED=0
INTERVAL=30

while [ $ELAPSED -lt $MAX_WAIT ]; do
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))

  # Get latest workflow run for this commit
  RUN_INFO=$(curl -s -H "Authorization: token $GITEA_TOKEN" \
    "$GITEA_API/repos/tom/bottalk/actions/runs?limit=1" 2>/dev/null)

  RUN_STATUS=$(echo "$RUN_INFO" | python3 -c "
import json,sys
d=json.load(sys.stdin)
runs=d.get('workflow_runs',[])
if runs:
    r=runs[0]
    print(f\"{r['status']}|{r.get('conclusion','')}\")
else:
    print('none|')
" 2>/dev/null || echo "error|")

  STATUS=$(echo "$RUN_INFO" | python3 -c "import json,sys; d=json.load(sys.stdin); runs=d.get('workflow_runs',[]); print(runs[0]['status'] if runs else 'none')" 2>/dev/null || echo "error")
  CONCLUSION=$(echo "$RUN_INFO" | python3 -c "import json,sys; d=json.load(sys.stdin); runs=d.get('workflow_runs',[]); print(runs[0].get('conclusion','') if runs else '')" 2>/dev/null || echo "")

  log "  [$ELAPSED s] CI status: $STATUS, conclusion: $CONCLUSION"

  if [ "$STATUS" = "completed" ]; then
    if [ "$CONCLUSION" = "success" ]; then
      log "CI passed! Starting deployment..."
      break
    else
      log "CI failed (conclusion: $CONCLUSION). Skipping deploy."
      exit 1
    fi
  fi
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  log "Timeout waiting for CI ($MAX_WAIT s). Skipping deploy."
  exit 1
fi

# Run deploy script (from synced repo)
log "Running deploy-k3s.sh $ENV ..."
bash "$REPO_DIR/scripts/deploy-k3s.sh" "$ENV" 2>&1 | tee -a "$LOG_FILE"

if [ $? -eq 0 ]; then
  echo "$AFTER_SHA" > "$STATE_FILE"
  log "Deploy successful! Recorded SHA: $AFTER_SHA"
else
  log "Deploy FAILED!"
  exit 1
fi

log "=== Sync+deploy cycle complete ==="
echo "" >> "$LOG_FILE"
