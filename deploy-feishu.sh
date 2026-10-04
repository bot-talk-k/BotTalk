#!/usr/bin/env bash
# DEPRECATED: legacy Docker Compose deployment was retired.
# Production releases use scripts/release-k8s2.sh; this script never deploys.

set -euo pipefail

echo "deploy-feishu.sh is retired. See docs/production-k8s2-release.md." >&2
exit 2
