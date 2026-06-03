// 飞书站加载冒烟 + 纯逻辑单测。
//
// 本地 Windows 编译不出 native better-sqlite3,所以 mock 掉它(只验证模块能 require、
// 路由能挂载、纯函数正确)。真实 DB/SQL 行为在 Docker/staging 验证。
// mock 手法同微信站 tests/channel-health.test.js。

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// ── mock better-sqlite3:链式 stub,够 db.js / routes 加载即可 ──
function makeStmt() {
  return { get: () => null, all: () => [], run: () => ({ lastInsertRowid: 1, changes: 0 }) };
}
function FakeDatabase() {
  return {
    pragma: () => {},
    exec: () => {},
    prepare: () => makeStmt(),
    close: () => {},
  };
}
const fakeSessionStore = function () { return function Store() {}; };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'better-sqlite3') return FakeDatabase;
  if (request === 'better-sqlite3-session-store') return () => fakeSessionStore;
  return originalLoad.call(this, request, parent, isMain);
};

// ── 模块加载冒烟:任何顶层抛错都会让 require 失败 ──
test('db.js 加载并导出 generateSendKey', () => {
  const db = require('../db');
  assert.strictEqual(typeof db.generateSendKey, 'function');
  assert.ok(db.generateSendKey().startsWith('fs_'), 'SendKey 应有 fs_ 前缀');
});

test('所有 route 模块加载为 express router', () => {
  for (const r of ['../routes/auth', '../routes/channels', '../routes/notify', '../routes/push-logs', '../routes/admin']) {
    const router = require(r);
    assert.strictEqual(typeof router, 'function', `${r} 应导出 router(函数)`);
  }
});

test('notify 导出 handlePush', () => {
  const notify = require('../routes/notify');
  assert.strictEqual(typeof notify.handlePush, 'function');
});

test('services 加载', () => {
  const client = require('../services/feishu-client');
  const auth = require('../services/feishu-auth');
  assert.strictEqual(typeof client.sendText, 'function');
  assert.strictEqual(typeof auth.startQrcode, 'function');
});

// ── 纯逻辑:凭证死码分类(发送失败 → 是否需重扫的核心判定)──
test('isDeadCredentialCode: 凭证死码判定', () => {
  const { isDeadCredentialCode } = require('../services/feishu-client');
  assert.strictEqual(isDeadCredentialCode(10003), true, '10003 invalid app_id → 死');
  assert.strictEqual(isDeadCredentialCode(10014), true, '10014 invalid app_secret → 死');
  assert.strictEqual(isDeadCredentialCode(99991663), true, 'app 不存在 → 死');
  assert.strictEqual(isDeadCredentialCode(0), false, '0 成功 → 非死');
  assert.strictEqual(isDeadCredentialCode(230002), false, '接收方异常 → 非死(瞬时)');
  assert.strictEqual(isDeadCredentialCode(undefined), false, 'undefined → 非死');
});

// ── handlePush:SendKey 无效 / 空内容 的纯分支(db.get 返回 null)──
test('handlePush: 无效 SendKey 返回 40001', async () => {
  const { handlePush } = require('../routes/notify');
  const r = await handlePush('bogus', 'title', 'content', '127.0.0.1', 'default', null);
  assert.strictEqual(r.code, 40001);
});

test.after(() => { Module._load = originalLoad; });
