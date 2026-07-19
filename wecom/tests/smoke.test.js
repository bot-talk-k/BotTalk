// 企业微信站加载冒烟 + 纯逻辑单测。
//
// 本地 Windows 编译不出 native better-sqlite3，所以 mock 掉它（只验证模块能 require、
// 路由能挂载、纯函数正确）。真实 DB/SQL 行为在 Docker/staging 验证。
// mock 手法同飞书站 feishu/tests/smoke.test.js。

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// ── mock better-sqlite3：链式 stub，够 db.js / routes 加载即可 ──
// prepare(sql) 返回的 stmt 能区分 SQL，让不同查询返回不同结果
let dbGetImpl = (/* sql, ...args */) => null;
let dbAllImpl = (/* sql, ...args */) => [];
function makeStmt(sql) {
  return {
    get: (...a) => dbGetImpl(sql, ...a),
    all: (...a) => dbAllImpl(sql, ...a),
    run: () => ({ lastInsertRowid: 1, changes: 0 }),
  };
}
function FakeDatabase() {
  return {
    pragma: () => {},
    exec: () => {},
    prepare: (sql) => makeStmt(sql),
    close: () => {},
  };
}
const fakeSessionStore = function () { return function Store() {}; };

// ── mock @wecom/aibot-node-sdk：WSClient stub ──
class FakeWSClient {
  constructor() { this._connected = false; }
  get isConnected() { return this._connected; }
  on() { /* noop */ }
  connect() { /* noop */ }
  disconnect() { /* noop */ }
  sendMessage() { return Promise.resolve({ errcode: 0, errmsg: 'ok' }); }
}
const fakeSdk = { WSClient: FakeWSClient };

// ── mock axios：admin-notify 用 ──
const fakeAxios = {
  post: async () => ({ status: 200, data: { code: 0 } }),
  get: async () => ({ status: 200, data: {} }),
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'better-sqlite3') return FakeDatabase;
  if (request === 'better-sqlite3-session-store') return () => fakeSessionStore;
  if (request === '@wecom/aibot-node-sdk') return fakeSdk;
  if (request === 'axios') return fakeAxios;
  return originalLoad.call(this, request, parent, isMain);
};

// ── 模块加载冒烟 ──
test('db.js 加载并导出 generateSendKey', () => {
  const db = require('../db');
  assert.strictEqual(typeof db.generateSendKey, 'function');
  const key = db.generateSendKey();
  assert.ok(key.startsWith('ww_'), `SendKey 应有 ww_ 前缀，实际: ${key}`);
  assert.strictEqual(key.length, 3 + 32, 'ww_ + 32 hex chars = 35 chars');
});

test('所有 route 模块加载为 express router', () => {
  for (const r of ['../routes/auth', '../routes/channels', '../routes/notify', '../routes/push-logs', '../routes/admin', '../routes/internal']) {
    const router = require(r);
    assert.strictEqual(typeof router, 'function', `${r} 应导出 router(函数)`);
  }
});

test('notify 导出 handlePush', () => {
  const notify = require('../routes/notify');
  assert.strictEqual(typeof notify.handlePush, 'function');
});

test('services 加载', () => {
  const pool = require('../services/wecom-pool');
  assert.strictEqual(typeof pool.send, 'function');
  assert.strictEqual(typeof pool.init, 'function');
  assert.strictEqual(typeof pool.ensure, 'function');
  assert.strictEqual(typeof pool.getState, 'function');
  assert.strictEqual(typeof pool.poolStats, 'function');
});

test('wecom-client 加载并导出 createConnection', () => {
  const client = require('../services/wecom-client');
  assert.strictEqual(typeof client.createConnection, 'function');
});

test('admin-notify 加载', () => {
  const adminNotify = require('../services/admin-notify');
  assert.strictEqual(typeof adminNotify.send, 'function');
});

// ── handlePush：SendKey 无效 ──
test('handlePush: 无效 SendKey 返回 40001', async () => {
  const { handlePush } = require('../routes/notify');
  dbGetImpl = () => null;
  const r = await handlePush('ww_bogus', 'title', 'content', '127.0.0.1', 'default', null);
  assert.strictEqual(r.code, 40001);
  assert.match(r.message, /SendKey/);
});

// ── handlePush：账号已禁用 ──
test('handlePush: 禁用账号返回 40301', async () => {
  const { handlePush } = require('../routes/notify');
  dbGetImpl = () => ({ id: 1, send_key: 'ww_disabled', is_disabled: 1, nickname: 'disabled_user' });
  try {
    const r = await handlePush('ww_disabled', 'title', 'content', '127.0.0.1', 'default', null);
    assert.strictEqual(r.code, 40301);
    assert.match(r.message, /禁用/);
  } finally {
    dbGetImpl = () => null;
  }
});

// ── handlePush：title 和 content 同时为空 ──
test('handlePush: title 和 content 同时为空返回 40003', async () => {
  const { handlePush } = require('../routes/notify');
  dbGetImpl = () => ({ id: 2, send_key: 'ww_empty', is_disabled: 0, nickname: 'emptytest' });
  try {
    const r = await handlePush('ww_empty', '', '', '127.0.0.1', 'default', null);
    assert.strictEqual(r.code, 40003);
  } finally {
    dbGetImpl = () => null;
  }
});

// ── handlePush：没有可用通道 ──
test('handlePush: 无通道返回 40002', async () => {
  const { handlePush } = require('../routes/notify');
  dbGetImpl = (sql) => {
    if (sql.includes('FROM users')) return { id: 3, send_key: 'ww_noch', is_disabled: 0, nickname: 'nochannel' };
    if (sql.includes('COUNT')) return { c: 0 }; // 无 pending 通道
    return null;
  };
  dbAllImpl = () => [];
  try {
    const r = await handlePush('ww_noch', 'title', 'content', '127.0.0.1', 'all', null);
    assert.strictEqual(r.code, 40002);
  } finally {
    dbGetImpl = () => null;
    dbAllImpl = () => [];
  }
});

// ── handlePush：通道 pending_userid 状态 ──
test('handlePush: 通道 pending_userid 返回 40002 + hint', async () => {
  const { handlePush } = require('../routes/notify');
  dbGetImpl = (sql) => {
    if (sql.includes('FROM users')) return { id: 4, send_key: 'ww_pend', is_disabled: 0, nickname: 'pending' };
    // COUNT pending channels
    if (sql.includes('COUNT')) return { c: 1 };
    return null;
  };
  dbAllImpl = () => [];
  try {
    const r = await handlePush('ww_pend', 'title', 'content', '127.0.0.1', 'all', null);
    assert.strictEqual(r.code, 40002);
    assert.ok(r.data?.reason === 'pending_userid', '应指明 pending_userid 原因');
    assert.match(r.data?.hint, /激活/, 'hint 应提示激活');
  } finally {
    dbGetImpl = () => null;
    dbAllImpl = () => [];
  }
});

// ── 限流：每小时 200 条上限 ──
test('handlePush: 超过每小时 200 条上限返回 42901', async () => {
  const { handlePush } = require('../routes/notify');
  dbGetImpl = (sql) => {
    if (sql.includes('FROM users')) return { id: 5, send_key: 'ww_rate', is_disabled: 0, nickname: 'ratetest' };
    if (sql.includes('COUNT')) return { c: 0 };
    return null;
  };
  dbAllImpl = () => [];
  try {
    const key = `ww_rate_${Date.now()}`;
    // 前 200 条应放行（落到 40002 无通道），第 201 条被限流
    let lastCode = 0;
    for (let i = 0; i < 200; i++) {
      const r = await handlePush(key, `title ${i}`, 'body', '127.0.0.1', 'all', null);
      lastCode = r.code;
    }
    assert.strictEqual(lastCode, 40002, '第 200 条应放行（无通道 40002）');
    const r = await handlePush(key, 'title 201', 'body', '127.0.0.1', 'all', null);
    assert.strictEqual(r.code, 42901, '第 201 条应被限流');
    assert.match(r.message, /200/, '提示应指明 200 条上限');
  } finally {
    dbGetImpl = () => null;
    dbAllImpl = () => [];
  }
});

// ── poolStats：初始状态 ──
test('poolStats: 初始状态 ws_total=0', () => {
  const pool = require('../services/wecom-pool');
  const stats = pool.poolStats();
  assert.strictEqual(stats.ws_total, 0);
  assert.strictEqual(stats.ws_authenticated, 0);
});

// ── getState：未知 channel 返回 disconnected ──
test('getState: 未知 channelId 返回 disconnected', () => {
  const pool = require('../services/wecom-pool');
  const state = pool.getState(99999);
  assert.strictEqual(state.connected, false);
  assert.strictEqual(state.authenticated, false);
  assert.strictEqual(state.capturedUserId, null);
});

test.after(() => { Module._load = originalLoad; });
