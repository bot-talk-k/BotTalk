const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const originalLoad = Module._load;
const dbState = {
  user: { id: 1, send_key: 'b_test', nickname: 'test' },
  channel: {
    id: 11,
    user_id: 1,
    is_default: 1,
    context_token: 'ctx',
    bot_token: 'bot',
    wechat_openid: 'openid',
    disconnected_at: null,
    send_disabled: 0,
    status: 'active',
  },
};

function fakeStatement(sql) {
  return {
    get: (...args) => {
      if (sql.includes('FROM users WHERE send_key')) return args[0] === 'b_test' ? dbState.user : null;
      if (sql.includes('FROM channels WHERE user_id')) return dbState.channel;
      return null;
    },
    all: () => [],
    run: () => ({ lastInsertRowid: 99, changes: 1 }),
  };
}

Module._load = function (request, parent, isMain) {
  if (request === 'express') {
    return { Router: () => ({ all: () => {}, post: () => {} }) };
  }
  if (request === 'axios') return async () => ({ status: 200, data: {} });
  if (request === '../db' && parent?.filename?.includes(`${require('path').sep}routes${require('path').sep}`)) {
    return { prepare: fakeStatement };
  }
  if (request === '../ilink') return { sendMessage: async () => { throw Object.assign(new Error('ret -2'), { response: { data: { ret: -2 } } }); } };
  if (request === '../services/push-queue') return { enqueueSend: async (_id, fn) => fn() };
  if (request === '../services/retry-queue') return { enqueueRetry: () => {} };
  if (request === '../services/channel-health') return {
    isChannelDisconnected: () => null,
    markSendResult: () => {},
    classifyAndMarkRet14: async () => ({ tokenInvalid: false, sendDisabled: false }),
  };
  if (request === '../services/keepalive-tip') return { appendTip: value => value };
  if (request === '../services/logger') return { logActivity: () => {}, error: () => {} };
  return originalLoad.call(this, request, parent, isMain);
};

const { handlePush } = require('../routes/notify');

test('ret:-2 failed push returns documented structured reason without throwing', async () => {
  const result = await handlePush('b_test', 'title', 'body', '127.0.0.1', 'default', null);
  assert.strictEqual(result.code, 50001);
  assert.strictEqual(result.data.reason, 'context_expired');
  assert.strictEqual(result.data.results[0].status, 'failed');
});
