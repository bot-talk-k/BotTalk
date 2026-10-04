# k8s2 Production Release

This is the only BotTalk project production-release procedure. It releases directly to the `bottalk` namespace on k8s2; there is no project dev/UAT deployment.

> Do not use `deploy.sh`, `deploy-*.sh`, the retired `k8slab` manifests, GitHub/Gitea CD workflows, or bare `kubectl` on HomeVPS.

## Preconditions

- The working tree is clean and the chosen commit passed `npm ci`, `npm run lint`, and `npm test`.
- Any service changed by the release has passed a local container `GET /api/config` smoke check.
- The user explicitly approved this production release.
- Home-Lab has just run the approved backup gate on HomeVPS:

  ```text
  sudo systemctl start k8s2-backup.service
  sudo journalctl -u k8s2-backup.service -n 40 --no-pager
  ```

  Continue only when the final backup result reports `fails=0`.

## Cluster access

Windows has no production kubeconfig. The only supported control-plane route is:

```text
Windows → ssh homevps → ssh um880pro (tom) → sudo -n k3s kubectl
```

`kubectl` directly on HomeVPS controls the retired cluster. Do not use it. `k8s-n3` is accessed from HomeVPS as `ssh k8s-n3`; do not use `ssh -n` when streaming image input.

## Release identity

Use the same canonical 7-character SHA tag for all four images:

```text
bottalk-app:<sha7>
bottalk-feishu:<sha7>
bottalk-wecom:<sha7>
bottalk-portal:<sha7>
```

`latest` is prohibited. The release script rejects invalid, missing, unrendered, or mutable tags.

## Preflight and image distribution

From the project root:

```bash
./scripts/release-k8s2.sh --preflight <sha7>
```

This script:

1. Requires a clean tree and resolves the SHA to a commit.
2. Builds all four images with the immutable tag.
3. Imports each image to both `um880pro` and `k8s-n3` with `sudo -n k3s ctr -n k8s.io images import` before any workload change.
4. Verifies each exact tag exists on both nodes.
5. Shows a Deployment-only diff using rendered manifests.

No image archive may remain on a server. SSH streaming image artifacts is permitted; source-code SCP is not.

## Production rollout

After reviewing the preflight output and confirming the diff contains only the four Deployments, run:

```bash
./scripts/release-k8s2.sh --release <sha7>
```

The script requires an interactive typed confirmation. It records every existing image as `last-good-tag`, then updates these Deployments in order:

1. `bottalk-app`
2. `bottalk-feishu`
3. `bottalk-wecom`
4. `bottalk-portal`

All four use `Recreate` because they are singleton workloads backed by RWO local-path SQLite PVCs. Normal timing is 10–25 seconds each. The release helper allows Kubernetes up to 300 seconds, but treat a service exceeding 30 seconds or a sequential rollout exceeding three minutes as abnormal and use the printed `last-good-tag` rollback commands.

The release helper only changes the four Deployments. It must never modify Namespace, PVC, Service, Ingress, ConfigMap, Secret, RBAC, MetalLB, Nginx, Cloudflare Tunnel, or node configuration.

## Acceptance

The release is not complete until all of the following pass:

- The four Deployments are `1/1` and Pods are Ready.
- The resolved image tag is the selected SHA; no ImagePullBackOff, CrashLoopBackOff, probe, or PVC warning exists.
- `https://bot-talk.com/healthz`, `https://feishu.bot-talk.com/healthz`, and `https://wecom.bot-talk.com/healthz` return HTTP 200 with `ok`.
- Portal `/healthz` returns HTTP 200 with `ok`.
- `https://bot-talk.com/api/config`, `https://feishu.bot-talk.com/api/config`, and `https://wecom.bot-talk.com/api/config` return HTTP 200.
- Portal returns its expected 200/302 response.
- The helper waits 60 seconds after rollout and fails with `RELEASE_DEGRADED` if `bottalk-app` emits more than 200 log lines in that window; use its printed `last-good-tag` rollback sequence before continuing.
- One real Feishu push and one real WeCom push are delivered.
- The WeCom WebSocket connection pool is authenticated again.
- Relevant Pod logs contain no new errors.

Kubernetes and SQLite timestamps are UTC; report observed times to the user in Beijing time (UTC+8).

## Rollback

Never delete a PVC or manually edit a production SQLite database. To roll back, read the Deployment `last-good-tag`, make sure the former tag exists on both amd64 nodes, set the affected Deployment image back to that tag, wait for rollout, and repeat the complete acceptance check.

Database restoration, if ever needed, is a Home-Lab operation using the existing `k8s2-backup.service` archives and recovery runbook.
