// ret:-2 持续低频恢复探测
//
// 触发：push_retry_queue 中状态变为 exhausted 且首错为 ret:-2 → 入此表
// 节奏：每 60 分钟一次低扰动探测
// 恢复路径：
//   - 探测发送成功 → recovered_by='auto_probe'，向用户发"✅ 通道已恢复"
//   - 重绑触发 → recovered_by='rescan'（由 channels.js 调用 markRecoveredByRescan）
// 上限：probe_count ≥ 48（约 48 小时）→ gave_up_at = now，停止探测，admin 报警

const db = require('../db');
const ilink = require('../ilink');
const { enqueueSend } = require('./push-queue');
const { markSendResult } = require('./channel-health');

const PROBE_INTERVAL_MIN = 60;
const MAX_PROBE_COUNT = 48;

function nextProbeIso(min) {
  return new Date(Date.now() + min * 60000).toISOString().replace('T', ' ').slice(0, 19);
}

// 入表（由 retry-queue.processOne 在 exhausted 且首错=-2 时调用）
function enqueueProbe(channelId, retryQueueId) {
  try {
    const exists = db.prepare('SELECT channel_id, recovered_at, gave_up_at FROM neg2_recovery_probe WHERE channel_id = ?').get(channelId);
    if (exists && !exists.recovered_at && !exists.gave_up_at) return;
    db.prepare(`
      INSERT INTO neg2_recovery_probe (channel_id, retry_queue_id, started_at, next_probe_at, probe_count)
      VALUES (?, ?, CURRENT_TIMESTAMP, ?, 0)
      ON CONFLICT(channel_id) DO UPDATE SET
        retry_queue_id = excluded.retry_queue_id,
        started_at = CURRENT_TIMESTAMP,
        next_probe_at = excluded.next_probe_at,
        probe_count = 0,
        recovered_at = NULL, recovered_by = NULL, gave_up_at = NULL
    `).run(channelId, retryQueueId || null, nextProbeIso(PROBE_INTERVAL_MIN));
    console.log(`🔍 neg2-probe 入表 channel=${channelId}，每 ${PROBE_INTERVAL_MIN} 分钟探测`);
  } catch (e) {
    console.error('enqueueProbe 错误:', e.message);
  }
}

async function processProbes() {
  const due = db.prepare(`
    SELECT p.channel_id, p.probe_count, p.started_at,
           c.bot_token, c.wechat_openid, c.context_token, c.send_disabled, c.status, c.user_id
    FROM neg2_recovery_probe p
    JOIN channels c ON c.id = p.channel_id
    WHERE p.recovered_at IS NULL AND p.gave_up_at IS NULL
      AND p.next_probe_at <= CURRENT_TIMESTAMP
    LIMIT 10
  `).all();

  for (const item of due) {
    await probeOne(item);
  }
}

async function probeOne(item) {
  const probeNo = item.probe_count + 1;

  if (item.status === 'inactive' || item.send_disabled || !item.context_token) {
    db.prepare(`UPDATE neg2_recovery_probe SET gave_up_at = CURRENT_TIMESTAMP, last_probe_at = CURRENT_TIMESTAMP WHERE channel_id = ?`)
      .run(item.channel_id);
    console.log(`🔍 neg2-probe channel=${item.channel_id} 已死/无 token，放弃`);
    return;
  }

  const probeMsg = `🔍 通道恢复检测（系统定期测试，可忽略）\n\n本通道之前因 iLink 平台限制连续推送失败，系统每小时自动检测一次。\n如收到此消息，说明通道已恢复，您也会立即收到一条恢复确认。\n\n探测序号 #${probeNo}`;

  try {
    const r = await enqueueSend(item.channel_id,
      () => ilink.sendMessage(item.bot_token, item.wechat_openid, probeMsg, item.context_token),
      { title: '🔍 恢复检测', source: 'neg2-probe' });

    markSendResult(item.channel_id, r, true);
    db.prepare(`
      INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response)
      VALUES (?, ?, ?, 'success', 'neg2-probe', ?, ?)
    `).run(item.user_id, '🔍 恢复检测', probeMsg, item.channel_id, JSON.stringify(r));
    db.prepare(`
      UPDATE neg2_recovery_probe
      SET recovered_at = CURRENT_TIMESTAMP, recovered_by = 'auto_probe',
          probe_count = ?, last_probe_at = CURRENT_TIMESTAMP, last_probe_code = 0
      WHERE channel_id = ?
    `).run(probeNo, item.channel_id);

    const startedDays = ((Date.now() - new Date(item.started_at + 'Z').getTime()) / 86400000).toFixed(1);
    console.log(`✅ neg2-probe 通道 ${item.channel_id} 第 ${probeNo} 次探测成功，自然恢复（耗时 ${startedDays} 天）`);

    // 通知用户
    const goodNews = `✅ 通道已恢复\n\n你的 BotTalk 通道刚刚自动恢复正常。期间累积的失败消息（如有）会陆续补发。\n如希望降低失联频率，请保持每天给 Bot 回复任意一字。`;
    enqueueSend(item.channel_id,
      () => ilink.sendMessage(item.bot_token, item.wechat_openid, goodNews, item.context_token),
      { title: '✅ 通道已恢复', source: 'neg2-probe-recovered' })
      .catch(e => console.error('恢复通知失败:', e.message));
  } catch (err) {
    markSendResult(item.channel_id, err, false);
    const code = err.response?.data?.ret ?? err.response?.data?.errcode ?? null;

    if (probeNo >= MAX_PROBE_COUNT) {
      db.prepare(`
        UPDATE neg2_recovery_probe
        SET gave_up_at = CURRENT_TIMESTAMP, probe_count = ?,
            last_probe_at = CURRENT_TIMESTAMP, last_probe_code = ?
        WHERE channel_id = ?
      `).run(probeNo, code, item.channel_id);
      console.log(`❌ neg2-probe 通道 ${item.channel_id} 探测 ${probeNo} 次仍未恢复，放弃`);
      try {
        const { alertAdminsOnFailure } = require('../routes/notify');
        alertAdminsOnFailure({
          userId: item.user_id, nickname: null, channelId: item.channel_id,
          title: '⚠️ ret:-2 长期未恢复',
          errData: { ret: code, errmsg: `neg2-probe 探测 ${probeNo} 次（${MAX_PROBE_COUNT}小时）仍失败，建议联系用户重扫` },
          errMsg: 'neg2 probe gave up',
        });
      } catch (e) {}
    } else {
      db.prepare(`
        UPDATE neg2_recovery_probe
        SET probe_count = ?, last_probe_at = CURRENT_TIMESTAMP,
            last_probe_code = ?, next_probe_at = ?
        WHERE channel_id = ?
      `).run(probeNo, code, nextProbeIso(PROBE_INTERVAL_MIN), item.channel_id);
    }
  }
}

// 重绑触发恢复（由 channels.js 在重绑成功时调用）
function markRecoveredByRescan(channelId) {
  try {
    const info = db.prepare(`
      UPDATE neg2_recovery_probe
      SET recovered_at = CURRENT_TIMESTAMP, recovered_by = 'rescan'
      WHERE channel_id = ? AND recovered_at IS NULL AND gave_up_at IS NULL
    `).run(channelId);
    if (info.changes > 0) console.log(`♻️ neg2-probe channel=${channelId} 用户重扫恢复`);
  } catch (e) {
    console.error('neg2-probe markRecoveredByRescan 错误:', e.message);
  }
}

function getStats() {
  try {
    const active = db.prepare(`SELECT COUNT(*) AS cnt FROM neg2_recovery_probe WHERE recovered_at IS NULL AND gave_up_at IS NULL`).get().cnt;
    const recovered = db.prepare(`SELECT recovered_by, COUNT(*) AS cnt FROM neg2_recovery_probe WHERE recovered_at IS NOT NULL GROUP BY recovered_by`).all();
    const gaveUp = db.prepare(`SELECT COUNT(*) AS cnt FROM neg2_recovery_probe WHERE gave_up_at IS NOT NULL`).get().cnt;
    return { active, recovered, gave_up: gaveUp };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { enqueueProbe, processProbes, markRecoveredByRescan, getStats };
