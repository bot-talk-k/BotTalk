const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db' && parent?.filename?.endsWith('message-poller.js')) {
    return { prepare: () => ({ get: () => null, all: () => [], run: () => ({ changes: 0 }) }) };
  }
  if (request === '../ilink' && parent?.filename?.endsWith('message-poller.js')) return {};
  return originalLoad.call(this, request, parent, isMain);
};

const { runPollingLoop, idleDelay, errorDelay } = require('../services/message-poller');
const { schedulePollerRestores } = require('../services/poller-startup');

function fakeClock(controller, limitMs = 60000) {
  let time = 0;
  const waits = [];
  return {
    now: () => time,
    waits,
    sleep: async (ms) => {
      waits.push(ms);
      time += ms;
      if (time >= limitMs) controller.abort();
    },
  };
}

test('empty results use 1/2/4/5-second backoff and stay within 14 requests per 60s', async () => {
  const controller = new AbortController();
  const clock = fakeClock(controller);
  let calls = 0;
  await runPollingLoop({
    botToken: 'empty', userId: 'u', signal: controller.signal,
    now: clock.now, wait: clock.sleep,
    getUpdates: async () => { calls++; return { msgs: [], get_updates_buf: '' }; },
  });

  assert.deepStrictEqual(clock.waits.slice(0, 5), [1000, 2000, 4000, 5000, 5000]);
  assert.ok(calls <= 14, `60s continuous empty polling made ${calls} requests`);
  assert.strictEqual(calls, 14);
  assert.strictEqual(idleDelay(1), 1000);
  assert.strictEqual(idleDelay(4), 5000);
});

test('message resets backoff and starts the next request with zero interval', async () => {
  const controller = new AbortController();
  let now = 0;
  const timestamps = [];
  let call = 0;
  await runPollingLoop({
    botToken: 'message', userId: 'u', signal: controller.signal,
    now: () => now,
    wait: async (ms) => { now += ms; },
    getUpdates: async () => {
      timestamps.push(now);
      call++;
      if (call === 1) return { msgs: [] };
      if (call === 2) return { msgs: [{ context_token: 'ctx' }] };
      controller.abort();
      return { msgs: [] };
    },
  });

  assert.deepStrictEqual(timestamps, [0, 1000, 1000]);
  assert.strictEqual(timestamps[2] - timestamps[1], 0);
});

test('request failures use capped exponential backoff and reset after success', async () => {
  const controller = new AbortController();
  const clock = fakeClock(controller, 999999);
  let call = 0;
  const warnings = [];
  await runPollingLoop({
    botToken: 'errors', userId: 'u', signal: controller.signal,
    now: clock.now, wait: async (ms) => {
      clock.waits.push(ms);
      if (call > 6) controller.abort();
    },
    onError: line => warnings.push(line),
    getUpdates: async () => {
      call++;
      if (call <= 6) throw new Error('timeout');
      return { msgs: [] };
    },
  });

  assert.deepStrictEqual(clock.waits.slice(0, 6), [1000, 2000, 4000, 8000, 16000, 30000]);
  assert.strictEqual(warnings.length, 6);
  assert.strictEqual(errorDelay(7), 30000);
});

test('85 empty pollers emit no default-info request or response lines in 60s', async () => {
  let totalRequests = 0;
  let totalWarnings = 0;
  await Promise.all(Array.from({ length: 85 }, async (_, index) => {
    const controller = new AbortController();
    const clock = fakeClock(controller);
    await runPollingLoop({
      botToken: `bot-${index}`, userId: `user-${index}`, signal: controller.signal,
      now: clock.now, wait: clock.sleep,
      onError: () => { totalWarnings++; },
      getUpdates: async () => { totalRequests++; return { msgs: [] }; },
    });
  }));

  // Default info emits no per-request or per-empty-response lines.
  const logLines = totalWarnings;
  assert.strictEqual(logLines, 0);
  assert.ok(logLines <= 200);
  assert.strictEqual(totalRequests, 85 * 14);
});

test('single-flight duplicate start is represented by one held request', async () => {
  let concurrent = 0;
  let maximumConcurrent = 0;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const getUpdates = async () => {
    concurrent++;
    maximumConcurrent = Math.max(maximumConcurrent, concurrent);
    await held;
    concurrent--;
    return { msgs: [] };
  };
  const controller = new AbortController();
  const run = runPollingLoop({
    botToken: 'held', userId: 'u', signal: controller.signal,
    getUpdates,
    wait: async () => controller.abort(),
  });
  await Promise.resolve();
  assert.strictEqual(maximumConcurrent, 1);
  release();
  await run;
  assert.strictEqual(maximumConcurrent, 1);
});

test('startup restoration is staggered by 100ms', () => {
  const scheduled = [];
  schedulePollerRestores([{ id: 1 }, { id: 2 }, { id: 3 }], () => {}, (fn, ms) => {
    scheduled.push(ms);
    return { fn, ms };
  });
  assert.deepStrictEqual(scheduled, [0, 100, 200]);
});
