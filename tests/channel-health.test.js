// channel-health.isChannelDisconnected — fail-fast 失联判定的单元测试
//
// 设计意图(2026-06-03 harness): 把 X5 fail-fast 的"哪些信号算失联"集中到一个
// 纯函数,易测试覆盖。下次新增信号(比如未来加 ret:-X 类型)只改这里 + 加一个 case,
// 不会再出现 notify.js 漏检某个信号导致 zombie 通道持续真打 iLink 的事故。
//
// 历史教训:
// - 2026-06-03: channel 55 send_disabled=1 但 disconnected_at=null,X5 fail-fast
//   漏拦,持续真打 iLink 7889 次返回 ret:-14。
// - 根因: notify.js 内联判定散落,只查了 1 个信号。
// - 修复: 抽 isChannelDisconnected 集中判定 + 本测试守护。

const test = require('node:test');
const assert = require('node:assert');

// 通过 mock require 避开 better-sqlite3(channel-health.js 依赖 db.js → better-sqlite3,
// Windows 上 native 编译困难)。我们只测纯函数,不需要真 db。
const Module = require('node:module');
const origResolve = Module._resolve_filename ? Module._resolve_filename.bind(Module) : null;
// 简单方式: 直接 require 时拦截 db 加载
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db' || request.endsWith('/db') || request.endsWith('/db.js')) {
    return new Proxy({}, { get: () => () => ({ run: () => ({}), get: () => null, all: () => [] }) });
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { isChannelDisconnected } = require('../services/channel-health');
Module._load = originalLoad;

test('isChannelDisconnected: null/undefined 返回 null', () => {
  assert.strictEqual(isChannelDisconnected(null), null);
  assert.strictEqual(isChannelDisconnected(undefined), null);
});

test('isChannelDisconnected: 健康通道返回 null', () => {
  assert.strictEqual(
    isChannelDisconnected({
      id: 1,
      status: 'active',
      disconnected_at: null,
      send_disabled: 0,
    }),
    null,
  );
});

test('isChannelDisconnected: disconnected_at 非空 → channel_disconnected', () => {
  assert.strictEqual(
    isChannelDisconnected({
      id: 1,
      status: 'active',
      disconnected_at: '2026-06-03 06:55:00',
      send_disabled: 0,
    }),
    'channel_disconnected',
  );
});

test('isChannelDisconnected: send_disabled=1 → account_restricted', () => {
  assert.strictEqual(
    isChannelDisconnected({
      id: 1,
      status: 'active',
      disconnected_at: null,
      send_disabled: 1,
    }),
    'account_restricted',
  );
});

test('isChannelDisconnected: status=inactive → channel_dead', () => {
  assert.strictEqual(
    isChannelDisconnected({
      id: 1,
      status: 'inactive',
      disconnected_at: null,
      send_disabled: 0,
    }),
    'channel_dead',
  );
});

test('isChannelDisconnected: 多信号叠加按优先级 disconnected_at 最先', () => {
  // 历史教训信号同步后,正常情况这 3 个会同时被设置。但 helper 必须按确定顺序
  // 返回单一 reason,避免歧义。disconnected_at 是 X5 统一标记,优先级最高。
  assert.strictEqual(
    isChannelDisconnected({
      id: 1,
      status: 'inactive',
      disconnected_at: '2026-06-03 06:55:00',
      send_disabled: 1,
    }),
    'channel_disconnected',
  );
});

test('isChannelDisconnected: send_disabled 优先于 inactive', () => {
  // 实际生产中,先标 send_disabled 再标 inactive 的边缘情况。
  assert.strictEqual(
    isChannelDisconnected({
      id: 1,
      status: 'inactive',
      disconnected_at: null,
      send_disabled: 1,
    }),
    'account_restricted',
  );
});

test('isChannelDisconnected: send_disabled 数值 0 不视为失联', () => {
  // SQLite 整数字段 0 是 falsy,JS truthy 检查正确处理
  assert.strictEqual(
    isChannelDisconnected({
      id: 1,
      status: 'active',
      disconnected_at: null,
      send_disabled: 0,
    }),
    null,
  );
});

test('isChannelDisconnected: send_disabled undefined 视为未设置', () => {
  // 老数据可能没有 send_disabled 字段
  assert.strictEqual(
    isChannelDisconnected({
      id: 1,
      status: 'active',
      disconnected_at: null,
    }),
    null,
  );
});
