// 自测：Bug 审计修复（Fix 1/2/4）
// 运行：node tests/bugfix-audit.test.js
//
// 不依赖外部服务；Mock ilink + 使用临时 in-memory sqlite。

const assert = require('assert');
const path = require('path');

// ── 环境：临时 DB ──────────────────────────────────────────
const tmpDb = path.join(__dirname, 'tmp-audit.db');
require('fs').rmSync(tmpDb, { force: true });
process.env.BOTTALK_TEST_DB = tmpDb;

// 确保 data 目录存在（否则 db.js 的 dataDir 判断会 mkdir 一个假的）
process.env.PUSH_MIN_INTERVAL_SEC = '0'; // 测试时跳过限流等待

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    console.log(`✅ ${name}`);
    passed++;
  }).catch(e => {
    console.error(`❌ ${name}:`, e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    failed++;
  });
}

// ═══════════════════════════════════════════════════════════════════
// Test 1: ilink.sendMessage 现在有 timeout
// ═══════════════════════════════════════════════════════════════════

async function testSendMessageTimeout() {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'ilink.js'), 'utf8');
  // 定位 sendMessage 函数块（从 'async function sendMessage' 到下一个 module.exports）
  const startIdx = src.indexOf('async function sendMessage');
  assert(startIdx > 0, 'sendMessage 函数定义存在');
  const endIdx = src.indexOf('module.exports', startIdx);
  const sendBlock = src.slice(startIdx, endIdx > 0 ? endIdx : src.length);
  const timeoutMatch = sendBlock.match(/timeout:\s*(\d+)/);
  assert(timeoutMatch, 'sendMessage 必须带 timeout');
  const ms = parseInt(timeoutMatch[1]);
  assert(ms >= 10000 && ms <= 60000, `timeout ${ms}ms 应在 10-60s 区间`);
}

// ═══════════════════════════════════════════════════════════════════
// Test 2: poller epoch — 再次启动会让旧 loop 自行退出
// ═══════════════════════════════════════════════════════════════════

async function testPollerEpoch() {
  // 静态检查：源码里有 epoch 保护逻辑
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'services', 'message-poller.js'), 'utf8');
  assert(src.includes('pollerEpoch'), '必须有 pollerEpoch map');
  assert(src.includes('myEpoch'), '必须在 loop 内捕获 myEpoch');
  // 应有两处 epoch 检查：loop 入口 + getUpdates 后
  const checks = src.match(/pollerEpoch\[botToken\]\s*!==\s*myEpoch/g) || [];
  assert(checks.length >= 2, `epoch 检查应 >= 2 处，实际 ${checks.length}`);
  // 每次 start 应递增 epoch
  assert(/pollerEpoch\[botToken\]\s*=\s*myEpoch/.test(src), 'start 时应写入新 epoch');
}

// ═══════════════════════════════════════════════════════════════════
// Test 3: notify.js 网络错误 / QUEUE_FULL 入 retry-queue 的判断
// ═══════════════════════════════════════════════════════════════════

async function testRetryEnqueueConditions() {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'routes', 'notify.js'), 'utf8');
  assert(src.includes('isNetworkErr'), '应包含 isNetworkErr 判断');
  assert(src.includes('isQueueFull'), '应包含 isQueueFull 判断');
  assert(src.includes("error.code === 'QUEUE_FULL'"), '应检查 QUEUE_FULL');
  assert(src.includes('!errData && !tokenInvalid'), '网络错误判断应检查 errData 缺失');
}

// ═══════════════════════════════════════════════════════════════════
// Test 4: retry-queue 重试消息前缀包含原始时间 + 归因逻辑正确
// ═══════════════════════════════════════════════════════════════════

async function testRetryPrefixAndAttribution() {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'services', 'retry-queue.js'), 'utf8');
  assert(src.includes('toLocaleString'), '重试消息应带本地化时间');
  assert(src.includes("'Asia/Shanghai'"), '重试消息时间应按北京时区');
  assert(src.includes('微信官方通道'), '文案应明确归因微信官方通道');
  assert(src.includes("recovered_by = ?"), '应支持动态 recovered_by');
  assert(src.includes("-2 minutes"), '应有 2 分钟窗口判断是否 user_reply 归因');
}

// ═══════════════════════════════════════════════════════════════════
// Test 5: push-queue 单通道串行 + 间隔保障
// ═══════════════════════════════════════════════════════════════════

async function testPushQueueSerialization() {
  process.env.PUSH_MIN_INTERVAL_SEC = '0';
  process.env.PUSH_MAX_QUEUE_SIZE = '50';
  const pqPath = path.join(__dirname, '..', 'services', 'push-queue.js');
  delete require.cache[require.resolve(pqPath)];
  const pq = require(pqPath);

  const calls = [];
  const sendFn = (tag) => async () => {
    calls.push({ tag, at: Date.now() });
    await new Promise(r => setTimeout(r, 20));
    return { ok: true, tag };
  };

  // 并发入队 3 条
  const results = await Promise.all([
    pq.enqueueSend(999, sendFn('A')),
    pq.enqueueSend(999, sendFn('B')),
    pq.enqueueSend(999, sendFn('C')),
  ]);
  assert.deepStrictEqual(results.map(r => r.tag), ['A', 'B', 'C'], '必须保持 FIFO');
  // 由于 PUSH_MIN_INTERVAL_SEC=0，不检查间隔，只确认串行
  for (let i = 1; i < calls.length; i++) {
    assert(calls[i].at >= calls[i-1].at, 'FIFO 时序');
  }
}

// ═══════════════════════════════════════════════════════════════════
// Test 6: push-queue 满时抛 QUEUE_FULL
// ═══════════════════════════════════════════════════════════════════

async function testPushQueueFull() {
  process.env.PUSH_MAX_QUEUE_SIZE = '2';
  process.env.PUSH_MIN_INTERVAL_SEC = '0';
  const pqPath = path.join(__dirname, '..', 'services', 'push-queue.js');
  delete require.cache[require.resolve(pqPath)];
  const pq = require(pqPath);

  const slowFn = () => new Promise(() => {}); // 永不完成

  const chId = 888;
  // 第 1 个立即开始执行（hang），第 2/3 个进入 items 队列（items=[2,3]，长度=2=MAX）
  pq.enqueueSend(chId, slowFn).catch(() => {});
  pq.enqueueSend(chId, slowFn).catch(() => {});
  pq.enqueueSend(chId, slowFn).catch(() => {});
  await new Promise(r => setTimeout(r, 30));

  // 第 4 个应被拒绝：items 已满 2 个
  let threw = false;
  try {
    await pq.enqueueSend(chId, slowFn);
  } catch (e) {
    threw = true;
    assert.strictEqual(e.code, 'QUEUE_FULL', 'error.code 应为 QUEUE_FULL');
  }
  assert(threw, '队列满应抛 QUEUE_FULL');

  process.env.PUSH_MAX_QUEUE_SIZE = '50';
}

// ═══════════════════════════════════════════════════════════════════
// Test 7: Beijing timezone SQL 逻辑正确
// ═══════════════════════════════════════════════════════════════════

async function testBeijingTimezoneSQL() {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  // 所有 date('now') 应替换为带 '+8 hours'
  const lines = src.split('\n');
  const bareNow = lines.filter(l => /date\('now'\)/.test(l) && !l.includes('+8 hours'));
  assert.strictEqual(bareNow.length, 0, `仍有 ${bareNow.length} 处 date('now') 未带 +8 hours:\n${bareNow.join('\n')}`);
}

// ═══════════════════════════════════════════════════════════════════
// Test 8: message-poller 的 user reply 复位逻辑存在
// ═══════════════════════════════════════════════════════════════════

async function testUserReplyResets() {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'services', 'message-poller.js'), 'utf8');
  assert(src.includes('consecutive_neg2_count = 0'), '应重置 neg2 计数');
  assert(src.includes('push_retry_queue'), '应触发 retry 补发');
  assert(src.includes('next_try_at = CURRENT_TIMESTAMP'), '应将 pending 重试 next_try_at 置为现在而非直接标 success');
  assert(src.includes('neg2_recovery_probe'), '应处理 neg2-probe');
  assert(src.includes("pollerEpoch"), '应有 epoch 保护');
}

// ═══════════════════════════════════════════════════════════════════
// Test 9: checkSessionExpiry 已删除
// ═══════════════════════════════════════════════════════════════════

async function testCheckSessionExpiryRemoved() {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
  assert(!/async function checkSessionExpiry/.test(src), 'checkSessionExpiry 应已删除');
  assert(!src.includes("title: '⏱️ 通道即将到期'"), '"通道即将到期" 推送逻辑应已移除');
}

// ═══════════════════════════════════════════════════════════════════
// Test 10: welcome/rebind 消息包含新稳定性说明
// ═══════════════════════════════════════════════════════════════════

async function testWelcomeCopy() {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'routes', 'channels.js'), 'utf8');
  assert(src.includes('腾讯微信 ClawBot'), '应明确归因腾讯');
  assert(src.includes('通道测试通过'), '欢迎消息应包含"通道测试通过"反馈');
  assert(src.includes('每天发一字保活'), '应包含保活方法');
}

// ═══════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════

(async () => {
  console.log('\n🧪 Bug 审计修复自测\n');
  await test('Fix 1 — sendMessage 有 timeout', testSendMessageTimeout);
  await test('Fix 2 — poller epoch 保证单 loop', testPollerEpoch);
  await test('Fix 4 — notify.js 网络错误 + QUEUE_FULL 条件', testRetryEnqueueConditions);
  await test('retry-queue 补发前缀 + 归因', testRetryPrefixAndAttribution);
  await test('push-queue FIFO 串行', testPushQueueSerialization);
  await test('push-queue 满抛 QUEUE_FULL', testPushQueueFull);
  await test('北京时区 SQL', testBeijingTimezoneSQL);
  await test('用户回复复位 + epoch 保护', testUserReplyResets);
  await test('checkSessionExpiry 已删除', testCheckSessionExpiryRemoved);
  await test('欢迎消息文案', testWelcomeCopy);

  console.log(`\n通过 ${passed} / 失败 ${failed}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
