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

// ── mock axios:默认换 token/发消息都成功,单测内可换 impl 模拟飞书频控 ──
let axiosPostImpl = async () => ({ status: 200, data: { code: 0, tenant_access_token: 'tok', expire: 7200, data: {} } });
const fakeAxios = { post: (...args) => axiosPostImpl(...args) };
const isTokenUrl = (url) => url.includes('tenant_access_token');
const tokenOk = { status: 200, data: { code: 0, tenant_access_token: 'tok', expire: 7200 } };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'better-sqlite3') return FakeDatabase;
  if (request === 'better-sqlite3-session-store') return () => fakeSessionStore;
  if (request === 'axios') return fakeAxios;
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

// ── 纯逻辑:频控码判定(决定是否退避重试,而非当永久失败丢弃)──
test('isThrottleCode: 频控码判定', () => {
  const { isThrottleCode } = require('../services/feishu-client');
  assert.strictEqual(isThrottleCode(9499), true, '9499 too many request → 频控');
  assert.strictEqual(isThrottleCode(0), false, '0 成功 → 非频控');
  assert.strictEqual(isThrottleCode(10003), false, '凭证死 → 非频控(重试无意义)');
  assert.strictEqual(isThrottleCode(undefined), false, 'undefined → 非频控');
});

// ── 发送闸门:撞 9499 必须退避重试并恢复,不得静默丢消息(2026-07-16 血账)──
test('sendText: 9499 退避重试后成功', async () => {
  const client = require('../services/feishu-client');
  let msgCalls = 0;
  axiosPostImpl = async (url) => {
    if (isTokenUrl(url)) return tokenOk;
    msgCalls++;
    // 首次撞频控,重试后放行
    if (msgCalls === 1) return { status: 200, data: { code: 9499, msg: 'too many request' } };
    return { status: 200, data: { code: 0, msg: 'ok', data: { message_id: 'om_x' } } };
  };
  const r = await client.sendText({
    appId: 'cli_retry', appSecret: 's', domain: 'feishu', receiveId: 'ou_retry', text: 'hi',
  });
  assert.strictEqual(r.code, 0, '退避重试后应成功');
  assert.strictEqual(r.attempts, 2, '应恰好尝试 2 次');
  assert.strictEqual(msgCalls, 2);
});

test('sendText: 凭证死码不重试(重试无意义)', async () => {
  const client = require('../services/feishu-client');
  let msgCalls = 0;
  axiosPostImpl = async (url) => {
    if (isTokenUrl(url)) return tokenOk;
    msgCalls++;
    return { status: 200, data: { code: 10003, msg: 'invalid app_id' } };
  };
  const r = await client.sendText({
    appId: 'cli_dead', appSecret: 's', domain: 'feishu', receiveId: 'ou_dead', text: 'hi',
  });
  assert.strictEqual(r.deadCredential, true);
  assert.strictEqual(msgCalls, 1, '凭证死应只发一次,不退避');
});

// 整点齐发同一通道 = 本次事故的触发形态:并发发送必须被闸门摊开到飞书 5 QPS 线下
test('发送闸门: 同一接收者的并发发送被摊开(≥250ms 间隔)', async () => {
  const client = require('../services/feishu-client');
  const sentAt = [];
  axiosPostImpl = async (url) => {
    if (isTokenUrl(url)) return tokenOk;
    sentAt.push(Date.now());
    return { status: 200, data: { code: 0, data: { message_id: 'om_x' } } };
  };
  const send = (text) => client.sendText({
    appId: 'cli_gate', appSecret: 's', domain: 'feishu', receiveId: 'ou_same', text,
  });
  // 三条同时打同一 open_id(复刻通道 9 整点三任务齐发)
  const rs = await Promise.all([send('a'), send('b'), send('c')]);
  assert.ok(rs.every((r) => r.code === 0), '三条都应送达');
  assert.strictEqual(sentAt.length, 3);
  for (let i = 1; i < sentAt.length; i++) {
    const gap = sentAt[i] - sentAt[i - 1];
    assert.ok(gap >= 240, `第 ${i + 1} 条应与前一条间隔 ≥250ms,实际 ${gap}ms`);
  }
});

test('发送闸门: 不同接收者互不阻塞(各自独立频控额度)', async () => {
  const client = require('../services/feishu-client');
  axiosPostImpl = async (url) => {
    if (isTokenUrl(url)) return tokenOk;
    return { status: 200, data: { code: 0, data: { message_id: 'om_x' } } };
  };
  const start = Date.now();
  await Promise.all([
    client.sendText({ appId: 'cli_a', appSecret: 's', domain: 'feishu', receiveId: 'ou_a', text: 'a' }),
    client.sendText({ appId: 'cli_b', appSecret: 's', domain: 'feishu', receiveId: 'ou_b', text: 'b' }),
  ]);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 200, `不同接收者不应互相排队,实际耗时 ${elapsed}ms`);
});

// ── handlePush:SendKey 无效 / 空内容 的纯分支(db.get 返回 null)──
test('handlePush: 无效 SendKey 返回 40001', async () => {
  const { handlePush } = require('../routes/notify');
  const r = await handlePush('bogus', 'title', 'content', '127.0.0.1', 'default', null);
  assert.strictEqual(r.code, 40001);
});

test.after(() => { Module._load = originalLoad; });
