#!/usr/bin/env bash
# Manual k8s2 production release helper.
#
# Usage:
#   ./scripts/release-k8s2.sh --preflight <sha7>
#   ./scripts/release-k8s2.sh --release <sha7>
#
# Only the four bottalk Deployments can change. Namespace, PVC, Service,
# Ingress, ConfigMap, Secret, RBAC, and node configuration are out of scope.

set -euo pipefail

MODE="${1:-}"
SHA="${2:-}"
SERVICES=(bottalk-app bottalk-feishu bottalk-wecom bottalk-portal)
MANIFESTS=(
  k8s/app-deployment.yaml
  k8s/feishu-deployment.yaml
  k8s/wecom-deployment.yaml
  k8s/portal-deployment.yaml
)

usage() {
  echo "Usage: $0 --preflight|--release <7-character git SHA>" >&2
  exit 2
}

[[ "$MODE" == "--preflight" || "$MODE" == "--release" ]] || usage
[[ "$SHA" =~ ^[0-9a-f]{7}$ ]] || {
  echo "Release SHA must be exactly seven lowercase hexadecimal characters." >&2
  exit 2
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git diff --quiet HEAD || {
  echo "Refusing release: tracked files have uncommitted changes." >&2
  exit 1
}

untracked="$(git ls-files --others --exclude-standard)"
if [[ -n "$untracked" ]]; then
  echo "Warning: untracked files are not part of this release:" >&2
  printf '%s\n' "$untracked" >&2
  if grep -E '^(k8s/|scripts/|.*\.js$)' <<< "$untracked" >/dev/null; then
    echo "Refusing release: untracked release-sensitive source file detected." >&2
    exit 1
  fi
fi

FULL_SHA="$(git rev-parse "$SHA^{commit}")"
SHORT_SHA="$(git rev-parse --short=7 "$FULL_SHA")"
HEAD_SHA="$(git rev-parse HEAD)"
[[ "$SHORT_SHA" == "$SHA" && "$HEAD_SHA" == "$FULL_SHA" ]] || {
  echo "Refusing release: SHA must be the current clean HEAD's canonical seven-character prefix." >&2
  exit 1
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Sends a pure-ASCII command script with the mandated base64-envelope protocol:
# fragments → remote .b64 → base64 decode → bash -n → execute → marker.
prod() {
  local script="$1"
  local encoded b64_file sh_file chunk
  local -a commands

  encoded="$(printf '%s\n' "$script" | base64 | tr -d '\n')"
  b64_file="/tmp/bottalk-k8s2-command.$$.b64"
  sh_file="/tmp/bottalk-k8s2-command.$$.sh"
  commands=(
    "rm -f '$b64_file' '$sh_file'"
    "touch '$b64_file'"
  )

  while [[ -n "$encoded" ]]; do
    chunk="${encoded:0:3072}"
    encoded="${encoded:3072}"
    commands+=("printf '%s' '$chunk' >> '$b64_file'")
  done

  commands+=(
    "base64 -d '$b64_file' > '$sh_file'"
    "bash -n '$sh_file'"
    "bash '$sh_file'"
    "echo K8S2_COMMAND_MARKER >&2"
    "rm -f '$b64_file' '$sh_file'"
  )

  printf '%s\n' "${commands[@]}" | ssh -o BatchMode=yes -o ConnectTimeout=15 homevps \
    "ssh -o BatchMode=yes -o ConnectTimeout=15 um880pro 'bash -s'"
}

node_import() {
  local node="$1"
  local image="$2"
  local command="sudo -n k3s ctr -n k8s.io images import -"
  [[ "$node" == "k8s-n3" ]] && command="k3s ctr -n k8s.io images import -"
  docker save "$image:$SHA" | ssh -o BatchMode=yes -o ConnectTimeout=15 homevps \
    "ssh -o BatchMode=yes -o ConnectTimeout=15 $node '$command'"
}

node_has_image() {
  local node="$1"
  local image="$2"
  local command="sudo -n k3s ctr -n k8s.io images ls -q"
  [[ "$node" == "k8s-n3" ]] && command="k3s ctr -n k8s.io images ls -q"
  ssh -o BatchMode=yes -o ConnectTimeout=15 homevps \
    "ssh -o BatchMode=yes -o ConnectTimeout=15 $node '$command | grep -Fx docker.io/library/$image:$SHA'" >/dev/null
}

render_deployments() {
  local index=0
  for manifest in "${MANIFESTS[@]}"; do
    local rendered="$TMP_DIR/${SERVICES[$index]}.yaml"
    # Deployment is the first document; intentionally exclude checked-in Service.
    awk '/^---$/ { exit } { print }' "$manifest" | sed "s/__RELEASE_SHA__/$SHA/g" > "$rendered"
    grep -q '__RELEASE_SHA__' "$rendered" && {
      echo "Unrendered release placeholder in $manifest." >&2
      exit 1
    }
    grep -q "image: ${SERVICES[$index]}:$SHA" "$rendered" || {
      echo "Rendered image tag missing from $manifest." >&2
      exit 1
    }
    index=$((index + 1))
  done
}

preflight_cluster() {
  echo "== k8s2 production preflight =="
  prod 'sudo -n k3s kubectl -n bottalk get deploy,pod,pvc -o wide'
  prod 'sudo -n k3s kubectl get nodes -o wide'
  for deployment in "${SERVICES[@]}"; do
    prod "sudo -n k3s kubectl -n bottalk get deployment/$deployment >/dev/null"
  done
}

build_images() {
  echo "== Build immutable images: $SHA =="
  docker build -t "bottalk-app:$SHA" .
  docker build -t "bottalk-feishu:$SHA" ./feishu
  docker build -t "bottalk-wecom:$SHA" ./wecom
  docker build -t "bottalk-portal:$SHA" ./portal
}

import_images() {
  echo "== Import all images before any rollout =="
  for node in um880pro k8s-n3; do
    for image in "${SERVICES[@]}"; do
      echo "Importing $image:$SHA into $node"
      node_import "$node" "$image"
      node_has_image "$node" "$image" || {
        echo "Image verification failed: $image:$SHA is absent on $node." >&2
        exit 1
      }
    done
  done
}

remote_manifest_command() {
  local manifest="$1"
  local verb="$2"
  local encoded
  encoded="$(base64 "$manifest" | tr -d '\n')"
  printf "printf '%%s' '%s' | base64 -d | sudo -n k3s kubectl -n bottalk %s -f -" "$encoded" "$verb"
}

show_diff() {
  echo "== Deployment-only server-side diff =="
  for deployment in "${SERVICES[@]}"; do
    set +e
    prod "$(remote_manifest_command "$TMP_DIR/$deployment.yaml" diff)"
    status=$?
    set -e
    # kubectl diff returns 1 when intended differences exist.
    [[ "$status" -eq 0 || "$status" -eq 1 ]] || exit "$status"
  done
}

record_last_good_tags() {
  for deployment in "${SERVICES[@]}"; do
    local current
    current="$(prod "sudo -n k3s kubectl -n bottalk get deployment/$deployment -o jsonpath='{.spec.template.spec.containers[0].image}'")"
    [[ "$current" != *:latest && "$current" != *'__RELEASE_SHA__'* ]] || {
      echo "Refusing release: $deployment has no immutable rollback tag ($current)." >&2
      exit 1
    }
    prod "sudo -n k3s kubectl -n bottalk annotate deployment/$deployment last-good-tag=$current --overwrite"
    echo "Recorded $deployment last-good-tag=$current"
  done
}

rollout_diagnostics() {
  local deployment="$1"
  echo "== ROLLOUT_DIAGNOSTICS deployment=$deployment ==" >&2
  prod 'sudo -n k3s kubectl -n bottalk get deploy,pod -o wide' || true
  prod "sudo -n k3s kubectl -n bottalk describe deployment/$deployment" || true
  prod "pod=\$(sudo -n k3s kubectl -n bottalk get pods -l app.kubernetes.io/name=$deployment -o jsonpath='{.items[0].metadata.name}'); [ -n \"\$pod\" ] && sudo -n k3s kubectl -n bottalk describe pod/\$pod" || true
  prod "pod=\$(sudo -n k3s kubectl -n bottalk get pods -l app.kubernetes.io/name=$deployment -o jsonpath='{.items[0].metadata.name}'); [ -n \"\$pod\" ] && sudo -n k3s kubectl -n bottalk logs \$pod --tail=20" || true
  prod 'sudo -n k3s kubectl -n bottalk get events --sort-by=.lastTimestamp | tail -20' || true
}

print_rollback_commands() {
  local deployment="${1:-all}"
  echo "== ROLLBACK_COMMANDS deployment=$deployment ==" >&2
  if [[ "$deployment" == "all" ]]; then
    for item in "${SERVICES[@]}"; do
      echo "sudo -n k3s kubectl -n bottalk set image deployment/$item $item=\$(sudo -n k3s kubectl -n bottalk get deployment/$item -o jsonpath='{.metadata.annotations.last-good-tag}')" >&2
    done
  else
    echo "sudo -n k3s kubectl -n bottalk set image deployment/$deployment $deployment=\$(sudo -n k3s kubectl -n bottalk get deployment/$deployment -o jsonpath='{.metadata.annotations.last-good-tag}')" >&2
  fi
}

apply_and_wait() {
  for deployment in "${SERVICES[@]}"; do
    echo "== Recreate rollout: $deployment =="
    prod "$(remote_manifest_command "$TMP_DIR/$deployment.yaml" apply)"
    if ! prod "sudo -n k3s kubectl -n bottalk rollout status deployment/$deployment --timeout=300s"; then
      rollout_diagnostics "$deployment"
      print_rollback_commands "$deployment"
      exit 1
    fi
  done
}

verify_public_health() {
  echo "== Public health checks =="
  curl --fail --silent --show-error https://bot-talk.com/healthz | grep -Fx 'ok' >/dev/null
  curl --fail --silent --show-error https://feishu.bot-talk.com/healthz | grep -Fx 'ok' >/dev/null
  curl --fail --silent --show-error https://wecom.bot-talk.com/healthz | grep -Fx 'ok' >/dev/null
  curl --fail --silent --show-error https://portal.bot-talk.com/healthz | grep -Fx 'ok' >/dev/null
  prod 'sudo -n k3s kubectl -n bottalk get deploy,pod,svc -o wide'
  echo "POST_RELEASE_MARKER sha=$SHA"
}

verify_log_volume() {
  echo "== 60-second bottalk-app log-volume gate =="
  sleep 60
  local lines
  lines="$(prod "pod=\$(sudo -n k3s kubectl -n bottalk get pods -l app.kubernetes.io/name=bottalk-app -o jsonpath='{.items[0].metadata.name}'); sudo -n k3s kubectl -n bottalk logs \$pod --since=60s | wc -l" 2>/dev/null)"
  lines="${lines//[[:space:]]/}"
  if [[ ! "$lines" =~ ^[0-9]+$ || "$lines" -gt 200 ]]; then
    echo "RELEASE_DEGRADED app_log_lines=${lines:-unknown}" >&2
    rollout_diagnostics bottalk-app
    print_rollback_commands all
    exit 1
  fi
  echo "APP_LOG_LINES_60S=$lines"
}

render_deployments
preflight_cluster
build_images
import_images
show_diff

if [[ "$MODE" == "--preflight" ]]; then
  echo "PREFLIGHT_OK sha=$SHA full_sha=$FULL_SHA"
  echo "Run --release $SHA only after Home-Lab backup reports fails=0 and the user explicitly approves rollout."
  exit 0
fi

echo "This will Recreate four production Deployments in namespace bottalk using SHA $SHA."
read -r -p "Type RELEASE $SHA to continue: " confirmation
[[ "$confirmation" == "RELEASE $SHA" ]] || {
  echo "Release cancelled."
  exit 1
}

record_last_good_tags
apply_and_wait
verify_public_health
verify_log_volume

echo "RELEASE_OK sha=$SHA full_sha=$FULL_SHA"
echo "Perform one real Feishu push and one real WeCom push, then inspect relevant Pod logs before declaring the release complete."
