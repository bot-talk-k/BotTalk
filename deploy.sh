#!/usr/bin/env bash
# DEPRECATED: legacy Docker Compose production deployment was retired.
#
# BotTalk production runs on k8s2. Use scripts/release-k8s2.sh and read
# docs/production-k8s2-release.md. This stub intentionally never deploys.

set -euo pipefail

echo "deploy.sh is retired: legacy Docker Compose is not BotTalk production." >&2
echo "Use scripts/release-k8s2.sh --preflight <sha7>; see docs/production-k8s2-release.md." >&2
exit 2
