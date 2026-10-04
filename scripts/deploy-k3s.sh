#!/usr/bin/env bash
# DEPRECATED: The former dev/prod deployment generator targeted retired clusters.
# Production releases are manual k8s2 SHA releases through release-k8s2.sh.

set -euo pipefail

echo "deploy-k3s.sh is retired. Use scripts/release-k8s2.sh; see docs/production-k8s2-release.md." >&2
exit 2
