// pickTipMode 纯函数单元测试 — 不依赖 db / 不启动 server，本地 Windows 也可跑

const test = require('node:test');
const assert = require('node:assert');
const { pickTipMode } = require('../services/keepalive-tip');

test('pickTipMode: off mode always none', () => {
  assert.strictEqual(
    pickTipMode({ now: new Date(), lastLongTipAt: null, mode: 'off' }),
    'none',
  );
});

test('pickTipMode: short mode always short', () => {
  assert.strictEqual(
    pickTipMode({ now: new Date(), lastLongTipAt: null, mode: 'short' }),
    'short',
  );
});

test('pickTipMode: long mode always long', () => {
  assert.strictEqual(
    pickTipMode({ now: new Date(), lastLongTipAt: null, mode: 'long' }),
    'long',
  );
});

test('pickTipMode: smart 夜间总是 short', () => {
  // 北京时间 23:00 = UTC 15:00
  const night = new Date('2026-04-30T15:00:00Z');
  assert.strictEqual(
    pickTipMode({ now: night, lastLongTipAt: null, mode: 'smart' }),
    'short',
  );
  // 北京时间 03:00 = UTC 19:00 前一天
  const earlyMorning = new Date('2026-04-30T19:00:00Z');
  assert.strictEqual(
    pickTipMode({ now: earlyMorning, lastLongTipAt: null, mode: 'smart' }),
    'short',
  );
});

test('pickTipMode: smart 白天首条 long', () => {
  // 北京时间 10:00 = UTC 02:00
  const morning = new Date('2026-04-30T02:00:00Z');
  assert.strictEqual(
    pickTipMode({ now: morning, lastLongTipAt: null, mode: 'smart' }),
    'long',
  );
});

test('pickTipMode: smart 白天同日已发过 long → short', () => {
  // 今天 10:00 北京 = UTC 02:00
  const now = new Date('2026-04-30T02:00:00Z');
  // 今天 9:00 北京 = UTC 01:00 已发过 long
  const earlier = new Date('2026-04-30T01:00:00Z');
  assert.strictEqual(
    pickTipMode({ now, lastLongTipAt: earlier, mode: 'smart' }),
    'short',
  );
});

test('pickTipMode: smart 跨日 → 重新 long', () => {
  // 今天 10:00 北京 = UTC 02:00
  const now = new Date('2026-04-30T02:00:00Z');
  // 昨天 21:00 北京 = UTC 13:00 of 2026-04-29
  const yesterday = new Date('2026-04-29T13:00:00Z');
  assert.strictEqual(
    pickTipMode({ now, lastLongTipAt: yesterday, mode: 'smart' }),
    'long',
  );
});

test('pickTipMode: smart 接受 SQLite 时间字符串作为 lastLongTipAt', () => {
  const now = new Date('2026-04-30T02:00:00Z');
  // SQLite CURRENT_TIMESTAMP 格式：'YYYY-MM-DD HH:MM:SS'（UTC 无 Z）
  const sqliteStr = '2026-04-30 01:00:00';
  assert.strictEqual(
    pickTipMode({ now, lastLongTipAt: sqliteStr, mode: 'smart' }),
    'short',
  );
});

test('pickTipMode: smart 边界 8:00 整 → long（>= 8）', () => {
  // 北京 8:00 整 = UTC 00:00
  const eightAm = new Date('2026-04-30T00:00:00Z');
  assert.strictEqual(
    pickTipMode({ now: eightAm, lastLongTipAt: null, mode: 'smart' }),
    'long',
  );
});

test('pickTipMode: smart 边界 22:00 整 → short（>= 22）', () => {
  // 北京 22:00 整 = UTC 14:00
  const tenPm = new Date('2026-04-30T14:00:00Z');
  assert.strictEqual(
    pickTipMode({ now: tenPm, lastLongTipAt: null, mode: 'smart' }),
    'short',
  );
});
