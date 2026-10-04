#!/usr/bin/env bash
# DEPRECATED: CI/CD deployment to dev/prod is intentionally disabled.
# CI validates code only; k8s2 production releases are manual and SHA-gated.

set -euo pipefail

echo "deploy-k3s-ci.sh is retired. See docs/production-k8s2-release.md." >&2
exit 2
