#!/usr/bin/env bash
# DEPRECATED: targeted retired k8slab nodes and fixed image archives.
# Use scripts/release-k8s2.sh, which imports SHA-tagged images into k8s2 nodes.

set -euo pipefail

echo "k8s/import-images.sh is retired. See docs/production-k8s2-release.md." >&2
exit 2
