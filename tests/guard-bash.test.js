// guard-bash hook 行为测试
// 验证 .claude/hooks/guard-bash.js 的 8 条规则在「应拦」与「应放」上的边界正确

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
  if (!result.stdout || result.stdout.trim() === '') {
    return { allow: true, reason: null };
  }
  try {
    const out = JSON.parse(result.stdout);
    const decision = out.hookSpecificOutput?.permissionDecision;
    return {
      allow: decision !== 'deny',
      reason: out.hookSpecificOutput?.permissionDecisionReason || null,
    };
  } catch {
    return { allow: true, reason: null };
  }
}

// ── 应拦截 ─────────────────────────────────────────────────────

test('block: scp to rn:/opt/bottalk', () => {
  assert.equal(runGuard('scp app.js rn:/opt/bottalk/').allow, false);
});

test('block: ssh rn vi /opt/bottalk', () => {
  assert.equal(runGuard('ssh rn "vi /opt/bottalk/app.js"').allow, false);
});

test('block: ssh rn redirect into /opt/bottalk', () => {
  assert.equal(
    runGuard(`ssh rn "echo 'x' > /opt/bottalk/app.js"`).allow,
    false,
  );
});

test('block: git commit --no-verify', () => {
  assert.equal(runGuard('git commit --no-verify -m "x"').allow, false);
});

test('block: git push --force main', () => {
  assert.equal(runGuard('git push --force origin main').allow, false);
});

test('block: ssh rn DELETE FROM', () => {
  assert.equal(
    runGuard(
      `ssh rn "docker exec bottalk node -e 'db.prepare(\\"DELETE FROM users WHERE id=1\\").run()'"`,
    ).allow,
    false,
  );
});

test('block: ssh rn ALTER TABLE', () => {
  assert.equal(
    runGuard(
      `ssh rn "docker exec bottalk node -e 'db.exec(\\"ALTER TABLE channels ADD COLUMN x INTEGER\\")'"`,
    ).allow,
    false,
  );
});

test('block: ssh rn CREATE TABLE', () => {
  assert.equal(
    runGuard(
      `ssh rn "docker exec bottalk node -e 'db.exec(\\"CREATE TABLE foo (id INTEGER)\\")'"`,
    ).allow,
    false,
  );
});

test('block: ssh rn UPDATE ... SET', () => {
  assert.equal(
    runGuard(
      `ssh rn "docker exec bottalk node -e 'db.prepare(\\"UPDATE channels SET status=NULL\\").run()'"`,
    ).allow,
    false,
  );
});

test('block: ssh rn INSERT INTO', () => {
  assert.equal(
    runGuard(
      `ssh rn "docker exec bottalk sqlite3 /opt/bottalk/data/db.sqlite 'INSERT INTO foo VALUES(1)'"`,
    ).allow,
    false,
  );
});

test('block: ssh rn db.exec(...)', () => {
  assert.equal(
    runGuard(
      `ssh rn "docker exec bottalk node -e \\"db.exec('whatever')\\""`,
    ).allow,
    false,
  );
});

test('block: ssh rn .prepare(...).run() on any name', () => {
  assert.equal(
    runGuard(
      `ssh rn "docker exec bottalk node -e \\"const x=require('./db');x.prepare('x').run()\\""`,
    ).allow,
    false,
  );
});

test('block: ssh rn docker compose down', () => {
  assert.equal(
    runGuard('ssh rn "cd /opt/bottalk && docker compose down"').allow,
    false,
  );
});

test('block: ssh rn docker compose restart', () => {
  assert.equal(runGuard('ssh rn "docker compose restart"').allow, false);
});

test('block: ssh rn docker compose stop', () => {
  assert.equal(runGuard('ssh rn "docker compose stop bottalk"').allow, false);
});

test('block: ssh rn rm -rf /opt/bottalk/data', () => {
  assert.equal(runGuard('ssh rn "rm -rf /opt/bottalk/data"').allow, false);
});

test('block: ssh rn rm -fr /opt/bottalk/...', () => {
  assert.equal(
    runGuard('ssh rn "rm -fr /opt/bottalk/some-dir"').allow,
    false,
  );
});

// ── 应放行（核心:不要误伤只读调试 + 正常本地操作）──────────

test('allow: ssh rn SELECT via prepare.all()', () => {
  assert.equal(
    runGuard(
      `ssh rn "docker exec bottalk node -e 'console.log(db.prepare(\\"SELECT * FROM channels\\").all())'"`,
    ).allow,
    true,
  );
});

test('allow: ssh rn SELECT via prepare.get()', () => {
  assert.equal(
    runGuard(
      `ssh rn "docker exec bottalk node -e 'console.log(db.prepare(\\"SELECT 1\\").get())'"`,
    ).allow,
    true,
  );
});

test('allow: ssh rn sqlite3 SELECT', () => {
  assert.equal(
    runGuard(
      `ssh rn "docker exec bottalk sqlite3 /opt/bottalk/data/db.sqlite 'SELECT * FROM users LIMIT 5'"`,
    ).allow,
    true,
  );
});

test('allow: ssh rn docker logs', () => {
  assert.equal(
    runGuard('ssh rn "docker logs bottalk --tail 20"').allow,
    true,
  );
});

test('allow: ssh rn docker ps', () => {
  assert.equal(runGuard('ssh rn "docker ps"').allow, true);
});

test('allow: ssh rn docker compose ps', () => {
  assert.equal(runGuard('ssh rn "docker compose ps"').allow, true);
});

test('allow: ssh rn docker compose logs', () => {
  assert.equal(runGuard('ssh rn "docker compose logs --tail 20"').allow, true);
});

test('allow: ./deploy.sh', () => {
  assert.equal(runGuard('./deploy.sh "fix: x"').allow, true);
});

test('allow: local rm -rf /tmp/foo', () => {
  assert.equal(runGuard('rm -rf /tmp/foo').allow, true);
});

test('allow: normal git commit', () => {
  assert.equal(runGuard('git commit -m "msg"').allow, true);
});

test('allow: normal git push', () => {
  assert.equal(runGuard('git push origin main').allow, true);
});

test('allow: ssh rn cat /opt/bottalk/data/foo.log (read)', () => {
  assert.equal(
    runGuard('ssh rn "cat /opt/bottalk/data/some.log"').allow,
    true,
  );
});

test('allow: ssh rn ls /opt/bottalk', () => {
  assert.equal(runGuard('ssh rn "ls -la /opt/bottalk/data"').allow, true);
});
