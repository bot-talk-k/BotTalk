const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db' && parent?.filename?.endsWith('logger.js')) {
    return { prepare: () => ({ run: () => ({ changes: 0 }) }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const logger = require('../services/logger');

test('LOG_LEVEL defaults to info and suppresses debug heartbeat', () => {
  const previous = process.env.LOG_LEVEL;
  delete process.env.LOG_LEVEL;
  const originalInfo = console.info;
  const originalLog = console.log;
  const lines = [];
  console.info = (...args) => lines.push(['info', ...args]);
  console.log = (...args) => lines.push(['log', ...args]);
  try {
    logger.debug('🔄 getUpdates 请求');
    logger.debug('💓 user poller 存活 0.0h，已轮询 100 次');
    logger.info('🩺 supervisor: 共 260 通道，健康 260，重启 0，报警 0');
  } finally {
    console.info = originalInfo;
    console.log = originalLog;
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
  assert.deepStrictEqual(lines, [['info', '🩺 supervisor: 共 260 通道，健康 260，重启 0，报警 0']]);
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
