const test = require('node:test');
const assert = require('node:assert');
const logger = require('../services/logger');

test('LOG_LEVEL defaults to info and suppresses debug', () => {
  const previous = process.env.LOG_LEVEL;
  delete process.env.LOG_LEVEL;
  const original = console.info;
  const lines = [];
  console.info = (...args) => lines.push(args);
  try {
    logger.debug('🔄 getUpdates 请求');
    logger.info('💓 user poller 存活 0.0h，已轮询 100 次');
  } finally {
    console.info = original;
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0][0], '💓 user poller 存活 0.0h，已轮询 100 次');
});

test('LOG_LEVEL=debug enables debug detail', () => {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'debug';
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args);
  try {
    logger.debug('🔄 getUpdates 请求');
  } finally {
    console.log = original;
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
  assert.deepStrictEqual(lines, [['🔄 getUpdates 请求']]);
});
