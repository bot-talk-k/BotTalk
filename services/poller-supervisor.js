// Poller Supervisor — 监控所有 channel 的 poller 心跳，发现挂死就重启
//
// 运行节奏：每 2 分钟扫一次 channels 表
// 规则：
//   - 心跳 < 120s：健康，跳过
//   - 心跳 120s–10min：poller 被认为挂死，尝试重启（startMessagePoller）
//   - 心跳 > 10min：升级报警给 admin（1 小时内同一通道只报一次）
//   - 无心跳记录但 channel 有 bot_token：poller 没起，启动之
//
// 冷却：同一 channel 2 分钟内只尝试重启一次（避免反复 start）

const db = require('../db');
const { startMessagePoller, _heartbeat } = require('./message-poller');

const RESTART_THRESHOLD_MS = 120 * 1000;
const ALERT_THRESHOLD_MS = 10 * 60 * 1000;
const RESTART_COOLDOWN_MS = 2 * 60 * 1000;
const ALERT_DEDUP_MS = 60 * 60 * 1000;

const lastRestartAt = {}; // botToken -> timestamp
const lastAlertAt = {};   // channelId -> timestamp

async function superviseOnce() {
  try {
    const channels = db.prepare(`
      SELECT id, user_id, bot_token, wechat_openid, context_token, status
      FROM channels
      WHERE bot_token IS NOT NULL AND status != 'inactive'
    `).all();

    const now = Date.now();
    let restarted = 0, alerted = 0;

    for (const ch of channels) {
      const hb = _heartbeat[ch.bot_token];
      const lastOkMs = hb?.lastOk ? now - hb.lastOk : null;

      // 完全没心跳记录 → poller 没起过（可能服务重启后没进入恢复逻辑）
      if (!hb) {
        if ((lastRestartAt[ch.bot_token] || 0) > now - RESTART_COOLDOWN_MS) continue;
        console.log(`🩺 supervisor: channel=${ch.id} 无 poller 心跳，启动`);
        lastRestartAt[ch.bot_token] = now;
        startPollerSafely(ch);
        restarted++;
        continue;
      }

      if (lastOkMs === null) continue;

      // 10 分钟以上 → 报警
      if (lastOkMs > ALERT_THRESHOLD_MS) {
        if ((lastAlertAt[ch.id] || 0) < now - ALERT_DEDUP_MS) {
          lastAlertAt[ch.id] = now;
          alertAdmin(ch, lastOkMs);
          alerted++;
        }
      }

      // 120s 到 10min → 尝试重启
      if (lastOkMs > RESTART_THRESHOLD_MS) {
        if ((lastRestartAt[ch.bot_token] || 0) > now - RESTART_COOLDOWN_MS) continue;
        console.log(`🩺 supervisor: channel=${ch.id} 心跳 ${Math.round(lastOkMs/1000)}s 无更新，重启 poller`);
        lastRestartAt[ch.bot_token] = now;
        startPollerSafely(ch);
        restarted++;
      }
    }

    const healthy = channels.length - restarted - alerted;
    console.log(`🩺 supervisor: 共 ${channels.length} 通道，健康 ${healthy}，重启 ${restarted}，报警 ${alerted}`);
  } catch (e) {
    console.error('supervisor 错误:', e.message);
  }
}

function startPollerSafely(ch) {
  try {
    startMessagePoller(ch.bot_token, ch.wechat_openid, (newToken) => {
      db.prepare("UPDATE channels SET context_token = ?, status = 'active' WHERE id = ?")
        .run(newToken, ch.id);
      console.log(`🩺 supervisor 重启后收到首条消息，channel=${ch.id}`);
    });
  } catch (e) {
    console.error(`supervisor startMessagePoller 失败 channel=${ch.id}:`, e.message);
  }
}

function alertAdmin(ch, lastOkMs) {
  try {
    const { alertAdminsOnFailure } = require('../routes/notify');
    alertAdminsOnFailure({
      userId: ch.user_id,
      nickname: null,
      channelId: ch.id,
      title: '⚠️ Poller 长时间无心跳',
      errData: {
        ret: null,
        errmsg: `poller 已 ${Math.round(lastOkMs / 60000)} 分钟无心跳，重启尝试无效`
      },
      errMsg: 'poller heartbeat stale',
    });
  } catch (e) {
    console.error('supervisor alertAdmin 失败:', e.message);
  }
}

module.exports = { superviseOnce };
