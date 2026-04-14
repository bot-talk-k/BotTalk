// 延时重试队列（持久化）
//
// 触发场景：notify handlePush 首次失败 + 5s 快速重试仍失败（通常是 ret:-2 或 ret:-14 半死态）
// 重试节奏（attempt 编号从 1 开始，指"即将执行第几次重试"）：
//   attempt 1 → 首失败后 2 分钟
//   attempt 2 → +5 分钟（累计 7 分钟）
//   attempt 3 → +15 分钟（累计 22 分钟）
//   attempt 4 → +60 分钟（累计 82 分钟）
//   之后 → 放弃，status = 'exhausted'
//
// 恢复路径：
//   - 重试成功 → recovered_by = 'retry', final_status = 'success'
//   - 用户回复刷新 context_token 后重试成功 → 同上（无法严格区分，但 failure_history 里能看到先-2后ok）
//   - scanner 跑下一次之前用户扫码重绑 → 由 channels.js 标记 recovered_by='rescan'（可选, 后续实现）
//
// 所有重试走 push-queue 保留 10s 间隔限流

const db = require('../db');
const ilink = require('../ilink');
const { enqueueSend } = require('./push-queue');
const { markSendResult } = require('./channel-health');

// 退避计划：分钟
const BACKOFF_MINUTES = [2, 5, 15, 60];

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
         next_try_at, failure_history, status)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 0, ?, ?, ?, 'pending')
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
async function processRetries() {
  const due = db.prepare(`
    SELECT r.*, c.bot_token, c.wechat_openid, c.context_token, c.send_disabled, c.status AS channel_status
    FROM push_retry_queue r
    JOIN channels c ON c.id = r.channel_id
    WHERE r.status = 'pending' AND r.next_try_at <= CURRENT_TIMESTAMP
    ORDER BY r.next_try_at ASC
    LIMIT 20
  `).all();

  for (const item of due) {
    await processOne(item);
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
  const retryMessage = `ℹ️ 以下消息原本于 ${originTime} 推送（因微信官方通道临时不稳定延迟 ${delayText} 送达，第 ${attemptNo} 次重试）。一天内与 ClawBot 互动一两次任意信息，能避免这类延迟。\n\n${rawBody}`;

  try {
    const r = await enqueueSend(item.channel_id,
      () => ilink.sendMessage(item.bot_token, item.wechat_openid, retryMessage, item.context_token),
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

    if (attemptNo >= item.max_attempts) {
      // 用尽
      db.prepare(`
        UPDATE push_retry_queue
        SET status = 'exhausted', attempts = ?, last_try_at = CURRENT_TIMESTAMP,
            final_attempt_count = ?
        WHERE id = ?
      `).run(attemptNo, attemptNo, item.id);
      console.log(`❌ retry-queue id=${item.id} 用尽 ${attemptNo} 次重试，放弃`);

      // 首错为 ret:-2 → 转入 neg2-probe 持续低频探测
      if (item.first_error_code === -2) {
        try {
          require('./neg2-probe').enqueueProbe(item.channel_id, item.id);
        } catch (e) { console.error('转入 neg2-probe 失败:', e.message); }
      }
    } else {
      const nextBackoff = BACKOFF_MINUTES[attemptNo] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1];
      db.prepare(`
        UPDATE push_retry_queue
        SET attempts = ?, last_try_at = CURRENT_TIMESTAMP, next_try_at = ?
        WHERE id = ?
      `).run(attemptNo, minutesFromNow(nextBackoff), item.id);
      console.log(`⏳ retry-queue id=${item.id} 第 ${attemptNo} 次失败（code=${code}），下次 +${nextBackoff}min`);
    }
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

module.exports = {
  enqueueRetry,
  processRetries,
  markRecoveredByRescan,
  getStats,
  BACKOFF_MINUTES,
};
