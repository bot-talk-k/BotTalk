// 客户端限流队列：对每个 channel 强制最小发送间隔（默认 10 秒），
// 防止 burst 触发 iLink 服务端限流导致 ret:-2。
//
// 使用方式：所有 ilink.sendMessage 调用用 enqueueSend 包起来
//   const result = await enqueueSend(channelId, () => ilink.sendMessage(...));
//
// 队列实现：
// - 每 channel 一个 FIFO 队列
// - drain 循环保证相邻两次 send 之间 >= MIN_INTERVAL_MS
// - 队列满时拒绝入队（防止雪崩）
// - 异常会原样抛给 caller

// 使用 Number.isFinite + ?? 避免 0 被 || 兜底掉
const _minSec = parseInt(process.env.PUSH_MIN_INTERVAL_SEC);
const MIN_INTERVAL_MS = (Number.isFinite(_minSec) ? _minSec : 10) * 1000;
const _maxQ = parseInt(process.env.PUSH_MAX_QUEUE_SIZE);
const MAX_QUEUE_SIZE = Number.isFinite(_maxQ) ? _maxQ : 50;

const queues = new Map();      // channel_id → { items: [], draining: boolean }
const lastSendAt = new Map();  // channel_id → epoch ms

function getQueue(channelId) {
  if (!queues.has(channelId)) {
    queues.set(channelId, { items: [], draining: false });
  }
  return queues.get(channelId);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 主入口：包装 send 函数让它排队执行并遵守最小间隔
async function enqueueSend(channelId, sendFn, meta = {}) {
  if (!channelId) {
    // 没有 channel_id 的调用（比如 supervisor 用），直接发不走队列
    return sendFn();
  }
  const q = getQueue(channelId);
  if (q.items.length >= MAX_QUEUE_SIZE) {
    const err = new Error(`push queue full for channel ${channelId} (size=${q.items.length})`);
    err.code = 'QUEUE_FULL';
    throw err;
  }
  return new Promise((resolve, reject) => {
    q.items.push({ sendFn, meta, resolve, reject, enqueuedAt: Date.now() });
    // 触发 drain（若已在 drain 则立即返回不重复）
    drainLoop(channelId).catch(e => console.error('drainLoop error:', e.message));
  });
}

async function drainLoop(channelId) {
  const q = getQueue(channelId);
  if (q.draining || q.items.length === 0) return;
  q.draining = true;
  try {
    while (q.items.length > 0) {
      const since = Date.now() - (lastSendAt.get(channelId) || 0);
      if (since < MIN_INTERVAL_MS) {
        await sleep(MIN_INTERVAL_MS - since);
      }
      const task = q.items.shift();
      const waitMs = Date.now() - task.enqueuedAt;
      if (waitMs > 2000) {
        console.log(`🚦 channel ${channelId} 排队 ${waitMs}ms 后发送 (title=${task.meta.title || '?'})`);
      }
      try {
        const result = await task.sendFn();
        lastSendAt.set(channelId, Date.now());
        task.resolve(result);
      } catch (e) {
        // 失败也算一次 API 调用消耗，更新最后时间
        lastSendAt.set(channelId, Date.now());
        task.reject(e);
      }
    }
  } finally {
    q.draining = false;
  }
}

// 调试：获取所有队列当前状态
function getQueueStats() {
  const stats = {};
  for (const [channelId, q] of queues.entries()) {
    stats[channelId] = {
      pending: q.items.length,
      draining: q.draining,
      last_send_ms_ago: lastSendAt.has(channelId) ? Date.now() - lastSendAt.get(channelId) : null,
    };
  }
  return stats;
}

module.exports = { enqueueSend, getQueueStats, MIN_INTERVAL_MS, MAX_QUEUE_SIZE };
