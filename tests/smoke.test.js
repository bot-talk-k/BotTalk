// Smoke test — 验证 app 启动 + 关键 endpoint
// 用 Node 22+ 内置 node:test，无需额外依赖

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PROJECT_ROOT = path.join(__dirname, '..');
const TEST_DATA_DIR = path.join(__dirname, 'tmp-data');
const TEST_PORT = parseInt(process.env.PORT, 10) || 3099;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let serverProcess = null;

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${url} did not respond in ${timeoutMs}ms`);
}

test.before(async () => {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  serverProcess = spawn('node', ['app.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATABASE_DIR: TEST_DATA_DIR,
      BASE_URL: BASE,
      SESSION_SECRET: 'test-secret-do-not-use-in-prod',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
  serverProcess.stderr.on('data', (d) => process.stderr.write(`[srv-err] ${d}`));

  await waitForServer(`${BASE}/api/config`);
});

test.after(() => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
  }
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

test('GET /api/config returns base_url', async () => {
  const r = await fetch(`${BASE}/api/config`);
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.ok(typeof body.base_url === 'string', 'base_url should be a string');
});

test('GET / returns intro page when not logged in', async () => {
  const r = await fetch(`${BASE}/`);
  assert.strictEqual(r.status, 200);
  const text = await r.text();
  assert.ok(text.length > 100, 'response should be a non-trivial HTML page');
});

test('GET /b<unknown-key>.send does not 5xx (Server酱-style returns 200+error in body)', async () => {
  const r = await fetch(`${BASE}/bdeadbeef00000000000000000000000000.send?title=test`);
  assert.ok(r.status < 500, `unknown key should not produce 5xx, got ${r.status}`);
  const body = await r.json();
  // 业务错误码：handlePush 找不到 user 时应返回非 0 code
  assert.ok(body.code !== 0 && body.code !== 200, `expected error code in body, got ${JSON.stringify(body)}`);
});

test('database migrations applied (schema_version >= 22)', { skip: 'requires native better-sqlite3 — runs on CI Linux only' }, () => {
  // 此测试仅在 CI Linux 跑（本地 Windows 编译 better-sqlite3 困难）
  // 在 CI 中通过 unskip env 启用：UNSKIP_DB_TEST=1 npm test
  // 实际逻辑见下方的 dbMigrationTest
});

if (process.env.UNSKIP_DB_TEST === '1') {
  test('database migrations applied (schema_version >= 23)', () => {
    const Database = require('better-sqlite3');
    const dbPath = path.join(TEST_DATA_DIR, 'bottalk.db');
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
    db.close();
    assert.ok(row.v >= 23, `expected schema_version >= 23, got ${row.v}`);
  });
}

