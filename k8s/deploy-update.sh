#!/usr/bin/env bash
# DEPRECATED: targeted retired k8slab nodes and deleted all Bottalk Pods.
# Production releases must never use broad Pod deletion. Use release-k8s2.sh.

set -euo pipefail

echo "k8s/deploy-update.sh is retired. See docs/production-k8s2-release.md." >&2
exit 2
