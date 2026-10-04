const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const routes = {};
const originalLoad = Module._load;
let activityCalls = 0;

Module._load = function (request, parent, isMain) {
  if (request === 'express') {
    return {
      Router: () => ({
        post: (path, handler) => { routes[`POST ${path}`] = handler; },
        get: () => {},
        patch: () => {},
      }),
    };
  }
  if (request === '../db') {
    return {
      generateSendKey: () => 'b_new',
      prepare: sql => ({
        get: (...args) => {
          if (sql.includes('FROM users WHERE send_key')) {
            return args[0] === 'b_good'
              ? { id: 7, send_key: 'b_good', email: 'user@example.com', nickname: null }
              : null;
          }
          if (sql.includes('COUNT(*) AS cnt FROM channels')) return { cnt: 1 };
          return null;
        },
        run: () => ({ lastInsertRowid: 7, changes: 1 }),
      }),
    };
  }
  if (request === '../middleware/auth') return { requireLogin: (_req, _res, next) => next() };
  if (request === '../services/logger') return { logActivity: () => { activityCalls++; } };
  return originalLoad.call(this, request, parent, isMain);
};

require('../routes/auth');

test('successful login still responds after logActivity', () => {
  const handler = routes['POST /login'];
  const req = { body: { send_key: 'b_good' }, session: {} };
  let payload;
  const res = { json: value => { payload = value; }, status: () => res };

  handler(req, res);

  assert.strictEqual(activityCalls, 1);
  assert.strictEqual(req.session.userId, 7);
  assert.strictEqual(payload.success, true);
  assert.strictEqual(payload.data.send_key, 'b_good');
});
