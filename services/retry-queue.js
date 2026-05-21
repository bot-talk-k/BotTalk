// 延时重试队列（持久化）
//
// 2026-05-21 重构: 数据证明退避后 3 次几乎不救人(96% 成功在第 1 次重试),
// 改为单次 +2min 重试 + 用户回复立即触发"最近 1 条" paused 补发链路。
// 详细数据见记忆: architecture_retry_queue_data.md
//
// 触发场景: notify handlePush 首次失败 + 5s 快速重试仍失败(ret:-2/-14)
// 节奏:
//   attempt 1 → 首失败后 2 分钟自动重试一次
//   若仍失败 → paused=1,等待 message-poller 的 user_reply 链路触发再试 1 次
//   超过 24h 仍未触发 → 由 cleanup 自动 abandon
//
// 恢复路径(2026-05-21 prod 数据):
//   - +2min 第一次重试就成 → 占 96%,绝大多数是用户已在 2 分钟内回复刷新了 context_token
//   - 用户后续回复触发 unpause 再补发 → 占余下 4%
//   - 用户扫码重绑 → 由 channels.js 标记 recovered_by='rescan'
//
// 所有重试走 push-queue 保留 10s 间隔限流

const db = require('../db');
const ilink = require('../ilink');
const { enqueueSend } = require('./push-queue');
const { markSendResult } = require('./channel-health');

// 退避计划：只保留 +2min 一次自动重试,后续等用户回复触发(2026-05-21 数据驱动决策)
const BACKOFF_MINUTES = [2];

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60000).toISOString().replace('T', ' ').slice(0, 19);
}

// 入队
// firstError: { ret, errcode, message } 便于后期分析
function enqueueRetry({ userId, channelId, title, content, source, originalPushLogId, firstError }) {
  try {
    const errCode = firstError?.ret ?? firstError?.errcode ?? null;
    const historyEntry = {
      attempt: 0,
      at: new Date().toISOString(),
      phase: 'initial-fail',
      code: errCode,
      msg: firstError?.errmsg || firstError?.message || null,
    };
    const nextAt = minutesFromNow(BACKOFF_MINUTES[0]);
    const info = db.prepare(`
      INSERT INTO push_retry_queue
        (user_id, channel_id, title, content, source, original_push_log_id,
         first_failed_at, first_error_code, attempts, max_attempts,
         next_try_at, failure_history, status, paused)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 0, ?, ?, ?, 'pending', 0)
    `).run(
      userId, channelId, title, content, source || 'api', originalPushLogId || null,
      errCode, BACKOFF_MINUTES.length,
      nextAt, JSON.stringify([historyEntry])
    );
    console.log(`📥 retry-queue 入队 id=${info.lastInsertRowid} channel=${channelId} first_err=${errCode} next=+${BACKOFF_MINUTES[0]}min`);
    return info.lastInsertRowid;
  } catch (e) {
    console.error('enqueueRetry 错误:', e.message);
    return null;
  }
}

function appendHistory(id, entry) {
  const row = db.prepare('SELECT failure_history FROM push_retry_queue WHERE id = ?').get(id);
  if (!row) return;
  let arr = [];
  try { arr = JSON.parse(row.failure_history || '[]'); } catch {}
  arr.push(entry);
  db.prepare('UPDATE push_retry_queue SET failure_history = ? WHERE id = ?')
    .run(JSON.stringify(arr), id);
}

// 处理所有到期的 pending
//
// 并发安全:
//   1. processingLock — 全局 reentrant guard: 如果上一次 processRetries 还在跑
//      (一个 batch 串行处理 20 条,push-queue 同通道 10s 间隔 → 单 batch 最长
//      可能 200s+),scheduler 30s 又 fire 时直接跳过本次,避免拿到相同 pending
//      records 导致同一条被多次处理。
//   2. inFlight Set — 双重保险: 即使因任何原因 processRetries 重入,同一条
//      retry_queue.id 在处理完成前不会被新一轮捡走。
//
// 故障证据: 2026-05-21 retry-queue #7089 的 failure_history 显示同一条记录
// 在 4 分钟内被处理 6 次 retry-success,push_logs 多写 5 条重复 retry-1。
const inFlight = new Set();
let processingLock = false;

async function processRetries() {
  if (processingLock) {
    return; // 上一轮还在跑,跳过本次 tick
  }
  processingLock = true;
  try {
    const due = db.prepare(`
      SELECT r.*, c.bot_token, c.wechat_openid, c.context_token, c.send_disabled, c.status AS channel_status
      FROM push_retry_queue r
      JOIN channels c ON c.id = r.channel_id
      WHERE r.status = 'pending' AND r.next_try_at <= CURRENT_TIMESTAMP AND r.paused = 0
      ORDER BY r.next_try_at ASC
      LIMIT 20
    `).all();

    for (const item of due) {
      if (inFlight.has(item.id)) continue; // 已在处理(理论上 processingLock 已挡住,这是冗余保险)
      inFlight.add(item.id);
      try {
        await processOne(item);
      } finally {
        inFlight.delete(item.id);
      }
    }
  } finally {
    processingLock = false;
  }
}

async function processOne(item) {
  const attemptNo = item.attempts + 1;
  const startedAt = Date.now();

  // 通道已 inactive 或 send_disabled，直接放弃
  if (item.channel_status === 'inactive' || item.send_disabled) {
    db.prepare(`
      UPDATE push_retry_queue
      SET status = 'abandoned', recovered_by = 'channel_dead',
          last_try_at = CURRENT_TIMESTAMP, final_attempt_count = ?
      WHERE id = ?
    `).run(item.attempts, item.id);
    appendHistory(item.id, {
      attempt: attemptNo,
      at: new Date().toISOString(),
      phase: 'skip',
      reason: item.send_disabled ? 'send_disabled' : 'channel_inactive',
    });
    return;
  }

  if (!item.context_token) {
    db.prepare(`
      UPDATE push_retry_queue
      SET status = 'abandoned', recovered_by = 'no_context_token',
          last_try_at = CURRENT_TIMESTAMP, final_attempt_count = ?
      WHERE id = ?
    `).run(item.attempts, item.id);
    return;
  }

  // 重试消息加延迟前缀：原始时间（北京时区）+ 友好延迟显示
  const firstFailedAt = new Date(item.first_failed_at + 'Z');
  const delayMin = Math.round((Date.now() - firstFailedAt.getTime()) / 60000);
  const delayText = delayMin < 60
    ? `${delayMin} 分钟`
    : delayMin < 1440
      ? `${Math.floor(delayMin/60)} 小时 ${delayMin % 60} 分`
      : `${Math.floor(delayMin/1440)} 天 ${Math.floor((delayMin % 1440) / 60)} 小时`;
  const originTime = firstFailedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const title = item.title || '';
  const rawBody = title + (item.content ? '\n\n' + item.content : '');
  const finalMessage = `ℹ️ 以下消息原本于 ${originTime} 推送（因微信官方通道临时不稳定延迟 ${delayText} 送达，第 ${attemptNo} 次重试）。一天内与 ClawBot 互动一两次任意信息，能避免这类延迟。\n\n${rawBody}`;

  try {
    const r = await enqueueSend(item.channel_id,
      () => ilink.sendMessage(item.bot_token, item.wechat_openid, finalMessage, item.context_token),
      { title, source: `retry-${attemptNo}` });

    // 成功
    markSendResult(item.channel_id, r, true);
    db.prepare(`
      INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response)
      VALUES (?, ?, ?, 'success', ?, ?, ?)
    `).run(item.user_id, title, item.content, `retry-${attemptNo}`, item.channel_id, JSON.stringify(r));

    // 归因：若 2 分钟内有用户回复，视为 user_reply 触发的恢复
    const recentReply = db.prepare(`
      SELECT 1 FROM inbound_events
      WHERE channel_id = ? AND received_at >= datetime('now', '-2 minutes')
      LIMIT 1
    `).get(item.channel_id);
    const recoveredBy = recentReply ? 'user_reply' : 'retry';

    appendHistory(item.id, {
      attempt: attemptNo,
      at: new Date().toISOString(),
      phase: 'retry-success',
      recovered_by: recoveredBy,
      elapsed_ms: Date.now() - startedAt,
      total_delay_min: delayMin,
    });
    db.prepare(`
      UPDATE push_retry_queue
      SET status = 'success', recovered_by = ?, recovered_at = CURRENT_TIMESTAMP,
          attempts = ?, last_try_at = CURRENT_TIMESTAMP, final_attempt_count = ?
      WHERE id = ?
    `).run(recoveredBy, attemptNo, attemptNo, item.id);
    console.log(`✅ retry-queue id=${item.id} 第 ${attemptNo} 次重试成功（${recoveredBy}，累计延迟 ${delayMin}min）`);
  } catch (err) {
    markSendResult(item.channel_id, err, false);
    const errData = err.response?.data;
    const code = errData?.ret ?? errData?.errcode ?? null;

    appendHistory(item.id, {
      attempt: attemptNo,
      at: new Date().toISOString(),
      phase: 'retry-fail',
      code,
      msg: errData?.errmsg || err.message,
      elapsed_ms: Date.now() - startedAt,
    });

    // 新逻辑(2026-05-21): 任何失败都 paused=1 等用户回复触发,不再 +5/+15/+60 退避
    // (数据证明那些退避只救 4% 且全是 user_reply 命中而非真自愈)
    // paused=1 record 由 message-poller 的 maybeFlushOldestPausedRetry 在用户回复时触发,
    // 或 24h 后由 cleanup 自动 abandon
    db.prepare(`
      UPDATE push_retry_queue
      SET attempts = ?, last_try_at = CURRENT_TIMESTAMP, paused = 1
      WHERE id = ?
    `).run(attemptNo, item.id);
    console.log(`⏳ retry-queue id=${item.id} 第 ${attemptNo} 次失败(code=${code}),paused=1 等用户回复触发`);
  }
}

// 24 小时仍未触发(用户始终没回复)的 paused record 自动 abandon
// 由 scheduler 定期调用,避免 paused 表无限累积
function cleanupStalePaused() {
  try {
    const r = db.prepare(`
      UPDATE push_retry_queue
      SET status = 'abandoned', recovered_by = 'user_no_reply_24h'
      WHERE status = 'pending' AND paused = 1 AND last_try_at < datetime('now', '-24 hours')
    `).run();
    if (r.changes > 0) {
      console.log(`🧹 retry-queue cleanup: ${r.changes} 条 paused 超过 24h 未触发,标 abandoned`);
    }
  } catch (e) {
    console.error('cleanupStalePaused error:', e.message);
  }
}

// 当扫码重绑成功时可调用，标记该 channel 所有未完成任务为 rescan 恢复
function markRecoveredByRescan(channelId) {
  try {
    const info = db.prepare(`
      UPDATE push_retry_queue
      SET status = 'success', recovered_by = 'rescan', recovered_at = CURRENT_TIMESTAMP,
          final_attempt_count = attempts
      WHERE channel_id = ? AND status = 'pending'
    `).run(channelId);
    if (info.changes > 0) {
      console.log(`♻️ retry-queue: channel ${channelId} 重绑，标记 ${info.changes} 条为 rescan 恢复`);
    }
  } catch (e) {
    console.error('markRecoveredByRescan 错误:', e.message);
  }
}

function getStats() {
  try {
    const byStatus = db.prepare(`
      SELECT status, COUNT(*) AS cnt FROM push_retry_queue GROUP BY status
    `).all();
    const pending = db.prepare(`
      SELECT COUNT(*) AS cnt FROM push_retry_queue
      WHERE status = 'pending' AND next_try_at <= CURRENT_TIMESTAMP
    `).get().cnt;
    return { by_status: byStatus, due_now: pending };
  } catch (e) {
    return { error: e.message };
  }
}

// 用户回复时由 message-poller 调用: 解锁该 channel 最近 1 条 paused retry 立即处理
// 严格"只发最近 1 条"——遵循 commit 6684f51 的"防一股脑全发"原则
const lastUnpauseAt = new Map(); // channelId -> epoch ms
const UNPAUSE_COOLDOWN_MS = 30 * 1000;

function flushOldestPausedRetry(channelId) {
  if (!channelId) return;
  const now = Date.now();
  const last = lastUnpauseAt.get(channelId) || 0;
  if (now - last < UNPAUSE_COOLDOWN_MS) return; // 30s 内只触发一次,防止用户连发多句触发多条补发

  try {
    const oldest = db.prepare(`
      SELECT id FROM push_retry_queue
      WHERE channel_id = ? AND status = 'pending' AND paused = 1
      ORDER BY id DESC LIMIT 1
    `).get(channelId);
    if (!oldest) return;

    const r = db.prepare(`
      UPDATE push_retry_queue
      SET paused = 0, next_try_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending' AND paused = 1
    `).run(oldest.id);
    if (r.changes > 0) {
      lastUnpauseAt.set(channelId, now);
      console.log(`♻️ user_reply 触发 unpause: channel=${channelId} retry #${oldest.id} 解锁,scheduler 30s 内拾起`);
    }
  } catch (e) {
    console.error('flushOldestPausedRetry error:', e.message);
  }
}

module.exports = {
  enqueueRetry,
  processRetries,
  markRecoveredByRescan,
  cleanupStalePaused,
  flushOldestPausedRetry,
  getStats,
  BACKOFF_MINUTES,
};
