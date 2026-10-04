// guard-bash hook behavior tests for k8s2 production safety.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '.claude', 'hooks', 'guard-bash.js');

function runGuard(command) {
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  });
  if (!result.stdout || result.stdout.trim() === '') return { allow: true, reason: null };
  const out = JSON.parse(result.stdout);
  return {
    allow: out.hookSpecificOutput?.permissionDecision !== 'deny',
    reason: out.hookSpecificOutput?.permissionDecisionReason || null,
  };
}

test('block: scp source file', () => {
  assert.equal(runGuard('scp app.js homevps:/tmp/').allow, false);
});

test('block: remote source editor', () => {
  assert.equal(runGuard('ssh homevps "vim app.js"').allow, false);
});

test('block: git commit --no-verify', () => {
  assert.equal(runGuard('git commit --no-verify -m "x"').allow, false);
});

test('block: force push main', () => {
  assert.equal(runGuard('git push --force origin main').allow, false);
});

test('block: direct k8s2 SQL delete', () => {
  assert.equal(
    runGuard('ssh homevps ssh um880pro DELETE FROM users').allow,
    false,
  );
});

test('block: direct k8s2 db run call', () => {
  assert.equal(
    runGuard('ssh homevps ssh um880pro db.prepare(DELETE).run()').allow,
    false,
  );
});

test('block: broad Kubernetes Pod delete', () => {
  assert.equal(runGuard('kubectl delete pods --all -n bottalk').allow, false);
});

test('block: k8s2 PVC mutation', () => {
  assert.equal(
    runGuard('ssh homevps "ssh um880pro \'sudo -n k3s kubectl apply -f pvc.yaml\'"').allow,
    false,
  );
});

test('allow: read-only k8s2 inspection', () => {
  assert.equal(
    runGuard('ssh homevps "ssh um880pro \'sudo -n k3s kubectl -n bottalk get pods\'"').allow,
    true,
  );
});

test('allow: SHA release helper entry point', () => {
  assert.equal(runGuard('./scripts/release-k8s2.sh --preflight abc1234').allow, true);
});

test('allow: local Git commit and push', () => {
  assert.equal(runGuard('git commit -m "msg"').allow, true);
  assert.equal(runGuard('git push github main').allow, true);
});
