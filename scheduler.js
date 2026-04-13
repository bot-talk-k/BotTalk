const db = require('./db');
const ilink = require('./ilink');
const { getContextToken } = require('./services/message-poller');
const { alertAdminsOnFailure } = require('./routes/notify');
const { markSendResult } = require('./services/channel-health');
const { enqueueSend } = require('./services/push-queue');
const { appendTip } = require('./services/keepalive-tip');

async function checkReminders() {
  const now = new Date();
  // 支持两种 time 格式：HH:MM 或 YYYY-MM-DDTHH:MM
  const timeHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const currentMinute = now.getMinutes();

  // 普通提醒：匹配 HH:MM（兼容 time 字段含日期前缀的情况）
  const normalReminders = db.prepare(`
    SELECT r.*, r.user_id as reminder_user_id,
           u.id as db_user_id, c.bot_token, c.wechat_openid, c.context_token as channel_context_token
    FROM reminders r
    JOIN users u ON r.user_id = u.wechat_openid OR CAST(r.user_id AS INTEGER) = u.id
    JOIN channels c ON c.user_id = u.id AND c.is_default = 1 AND c.context_token IS NOT NULL
    WHERE r.enabled = 1 AND r.type != 'every2min'
      AND (r.time = ? OR r.time LIKE ?)
  `).all(timeHHMM, '%T' + timeHHMM);

  // 每2分钟体验提醒：偶数分钟触发
  const every2minReminders = currentMinute % 2 === 0 ? db.prepare(`
    SELECT r.*, r.user_id as reminder_user_id,
           u.id as db_user_id, c.bot_token, c.wechat_openid, c.context_token as channel_context_token
    FROM reminders r
    JOIN users u ON r.user_id = u.wechat_openid OR CAST(r.user_id AS INTEGER) = u.id
    JOIN channels c ON c.user_id = u.id AND c.is_default = 1 AND c.context_token IS NOT NULL
    WHERE r.enabled = 1 AND r.type = 'every2min'
  `).all() : [];

  const allReminders = [...normalReminders, ...every2minReminders];

  for (const r of allReminders) {
    try {
      const contextToken = r.channel_context_token || getContextToken(r.wechat_openid);

      if (!contextToken) {
        console.log(`⚠️ ${r.wechat_openid} 无 context_token，跳过`);
        continue;
      }

      const sendCount = (r.send_count || 0) + 1;
      const maxCount = r.max_count || 0; // 0 = 无限制

      // 构造消息
      let message = r.title;
      if (r.type === 'every2min') {
        message += '\n\n' + (r.message || '');
        if (maxCount > 0) {
          message += '\n📊 第 ' + sendCount + ' 次 / 共 ' + maxCount + ' 次';
        }
        message += '\n⏰ ' + now.toLocaleString('zh-CN');
      } else if (r.message) {
        message += '\n\n' + r.message;
      }

      // 先找 channel_id 供队列使用
      const channelRowForQueue = db.prepare("SELECT * FROM channels WHERE bot_token = ? AND wechat_openid = ? LIMIT 1").get(r.bot_token, r.wechat_openid);
      const queueChId = channelRowForQueue?.id;
      // 追加保活尾巴
      const finalMessage = appendTip(message, channelRowForQueue);
      let ilinkRes;
      const startedAt = Date.now();
      try {
        ilinkRes = await enqueueSend(queueChId,
          () => ilink.sendMessage(r.bot_token, r.wechat_openid, finalMessage, contextToken),
          { title: r.title, source: 'scheduler' });
      } catch (retryErr) {
        if (retryErr.response?.data?.ret === -2) {
          console.log(`⏳ 提醒 ${r.wechat_openid} ret:-2，5秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          const delaySec = Math.round((Date.now() - startedAt) / 1000);
          const retryMessage = `ℹ️ 本消息因通道临时不稳定延迟 ${delaySec} 秒送达\n\n${finalMessage}`;
          ilinkRes = await enqueueSend(queueChId,
            () => ilink.sendMessage(r.bot_token, r.wechat_openid, retryMessage, contextToken),
            { title: r.title, source: 'scheduler-retry' });
        } else {
          throw retryErr;
        }
      }

      // 更新发送次数
      db.prepare('UPDATE reminders SET send_count = ? WHERE id = ?').run(sendCount, r.id);

      db.prepare(`
        INSERT INTO logs (user_id, reminder_id, status)
        VALUES (?, ?, 'sent')
      `).run(r.db_user_id, r.id);

      // 同步记录到推送日志
      const channelRow = db.prepare("SELECT id FROM channels WHERE bot_token = ? AND wechat_openid = ? LIMIT 1").get(r.bot_token, r.wechat_openid);
      db.prepare(`
        INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response)
        VALUES (?, ?, ?, 'success', 'scheduler', ?, ?)
      `).run(r.db_user_id, r.title, r.message || '', channelRow?.id || null, JSON.stringify(ilinkRes));
      markSendResult(channelRow?.id, ilinkRes, true);

      // 一次性提醒发送后自动禁用
      if (r.type === 'once') {
        db.prepare('UPDATE reminders SET enabled = 0 WHERE id = ?').run(r.id);
        console.log(`📌 一次性提醒 ${r.id} 已自动禁用`);
      }

      // 体验提醒达到次数上限后自动删除
      if (maxCount > 0 && sendCount >= maxCount) {
        db.prepare('DELETE FROM logs WHERE reminder_id = ?').run(r.id);
        db.prepare('DELETE FROM reminders WHERE id = ?').run(r.id);
        console.log(`🗑️ 体验提醒 ${r.id} 已发送 ${maxCount} 次，自动删除`);
      }

      console.log(`✅ 提醒发送成功：${r.wechat_openid} - ${r.title} (${sendCount}/${maxCount || '∞'})`);
    } catch (error) {
      const errData = error.response?.data;
      const errStatus = error.response?.status;
      console.error(`❌ 提醒发送失败：${r.wechat_openid}`, errData || error.message);
      const channelRow = db.prepare("SELECT id FROM channels WHERE bot_token = ? AND wechat_openid = ? LIMIT 1").get(r.bot_token, r.wechat_openid);

      // token 失效检测
      const tokenInvalid = errStatus === 401 || errStatus === 403 || (errData && errData.ret === -14);
      if (tokenInvalid && channelRow) {
        db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channelRow.id);
        console.error(`⚠️ 提醒通道 ${channelRow.id} 已标记为 inactive（token 失效）`);
      }

      try {
        db.prepare(`
          INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response)
          VALUES (?, ?, ?, 'failed', 'scheduler', ?, ?)
        `).run(r.db_user_id, r.title, r.message || '', channelRow?.id || null, JSON.stringify(errData || { error: error.message }));
      } catch (e) {}
      markSendResult(channelRow?.id, error, false);

      // 通知 admin
      try {
        const u = db.prepare('SELECT nickname FROM users WHERE id = ?').get(r.db_user_id);
        alertAdminsOnFailure({
          userId: r.db_user_id,
          nickname: u?.nickname,
          channelId: channelRow?.id,
          title: '⏰ 定时提醒: ' + r.title,
          errData,
          errMsg: error.message,
        });
      } catch (e) {
        console.error('alert admin 失败:', e.message);
      }
    }
  }
}

setInterval(checkReminders, 60000);
console.log('⏰ 定时任务已启动');

// 注意：原先的 checkSessionExpiry（基于"bot_token 满 22-24h 硬过期需重扫"的假设）已移除。
// 实证发现 context_token 可被用户回复刷新，不需要重扫；且 checkKeepaliveReminders
// 基于 last_send_success_at + last_inbound_at 更精准，不会误伤刚回复过的用户。

// ═══════════════════════════════════════════════════════════════════
// 预防性保活提醒 — 在 context_token 还能用的"黄色警告"窗口主动提醒用户回复
//
// 触发条件（同时满足）：
//   1. 有 context_token（能发送）
//   2. consecutive_neg2_count = 0（尚未 ret:-2）
//   3. 过去 4 小时没有成功推送 或 从未有过成功推送且通道超过 4h
//   4. 用户从未回复过 或 最近 20 小时未回复
//   5. 最近 4 小时内没发过保活提醒（去重）
//
// 目的：在通道衰退到 ret:-2 之前，主动让用户发一条消息刷新 context_token
// ═══════════════════════════════════════════════════════════════════

const lastKeepaliveReminderAt = {}; // channel_id → epoch ms

async function checkKeepaliveReminders() {
  try {
    const channels = db.prepare(`
      SELECT c.id, c.user_id, c.bot_token, c.wechat_openid, c.context_token,
             c.consecutive_neg2_count, c.last_send_success_at, c.last_inbound_at,
             c.created_at, c.send_disabled, u.nickname
      FROM channels c JOIN users u ON u.id = c.user_id
      WHERE c.context_token IS NOT NULL
        AND (c.consecutive_neg2_count IS NULL OR c.consecutive_neg2_count = 0)
        AND (c.send_disabled IS NULL OR c.send_disabled = 0)
    `).all();

    const now = Date.now();
    for (const ch of channels) {
      // 去重：4 小时内已发过就跳过
      const lastSent = lastKeepaliveReminderAt[ch.id];
      if (lastSent && now - lastSent < 4 * 60 * 60 * 1000) continue;

      const lastOkAge = ch.last_send_success_at
        ? now - new Date(ch.last_send_success_at + 'Z').getTime()
        : now - new Date(ch.created_at + 'Z').getTime();
      const lastInboundAge = ch.last_inbound_at
        ? now - new Date(ch.last_inbound_at + 'Z').getTime()
        : Infinity;

      // 需要保活提醒的条件
      const needsReminder =
        lastOkAge > 4 * 60 * 60 * 1000 &&         // 超过 4 小时没成功推送
        lastInboundAge > 20 * 60 * 60 * 1000;     // 超过 20 小时没回复（或从未）

      if (!needsReminder) continue;

      const okHours = Math.round(lastOkAge / 3600000);
      const inboundDesc = ch.last_inbound_at
        ? `已 ${Math.round(lastInboundAge / 3600000)} 小时未回复 Bot`
        : '从未回复过 Bot';
      const msg = '🔔 通道保活提醒\n\n' +
        `你的 BotTalk 通道距今已 ${okHours} 小时没有成功推送，${inboundDesc}。\n\n` +
        '由于腾讯微信 ClawBot 平台目前仍处于测试阶段，需要用户每 24 小时内与通道有互动才能保持活跃。\n\n' +
        '✅ 保活方法：\n' +
        '现在给我（Bot）回复任意一字（如"好""1""收到"）即可刷新通道，续命 24 小时。无需重新扫码。\n\n' +
        '本提醒 4 小时内不会重复发送。';

      try {
        const r = await enqueueSend(ch.id,
          () => ilink.sendMessage(ch.bot_token, ch.wechat_openid, msg, ch.context_token),
          { title: '🔔 保活提醒', source: 'keepalive-reminder' });
        db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'success', ?, ?, ?)")
          .run(ch.user_id, '🔔 通道保活提醒', msg, 'keepalive-reminder', ch.id, JSON.stringify(r));
        markSendResult(ch.id, r, true);
        lastKeepaliveReminderAt[ch.id] = now;
        console.log(`🔔 保活提醒已发送: channel=${ch.id} user=${ch.nickname} (${okHours}h 无成功推送)`);
      } catch (e) {
        const errData = e.response?.data;
        db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'failed', ?, ?, ?)")
          .run(ch.user_id, '🔔 通道保活提醒', msg, 'keepalive-reminder', ch.id, JSON.stringify(errData || { error: e.message }));
        markSendResult(ch.id, e, false);
        console.error(`❌ 保活提醒失败 channel=${ch.id}:`, JSON.stringify(errData));
        // 即使失败也记录"已尝试"，避免无效重试（会记在内存 dedup 里）
        lastKeepaliveReminderAt[ch.id] = now;
      }
    }
  } catch (e) {
    console.error('checkKeepaliveReminders 错误:', e.message);
  }
}

// 每 30 分钟扫一次
setInterval(checkKeepaliveReminders, 30 * 60 * 1000);

// 延时重试队列：每 30 秒扫描到期任务
const { processRetries } = require('./services/retry-queue');
setInterval(() => {
  processRetries().catch(e => console.error('processRetries 错误:', e.message));
}, 30000);
setTimeout(() => {
  processRetries().catch(e => console.error('processRetries 错误:', e.message));
}, 45000);

// Poller 监控：每 2 分钟扫描心跳，挂掉自动重启
const { superviseOnce } = require('./services/poller-supervisor');
setInterval(() => {
  superviseOnce().catch(e => console.error('supervisor 错误:', e.message));
}, 2 * 60 * 1000);
setTimeout(() => {
  superviseOnce().catch(e => console.error('supervisor 错误:', e.message));
}, 90 * 1000);

// neg2-probe 持续探测：每 60 分钟扫一次到期任务（每个通道实际节奏也是 60min）
const { processProbes } = require('./services/neg2-probe');
setInterval(() => {
  processProbes().catch(e => console.error('processProbes 错误:', e.message));
}, 60 * 60 * 1000);
setTimeout(() => {
  processProbes().catch(e => console.error('processProbes 错误:', e.message));
}, 3 * 60 * 1000);
// 启动 60 秒后先跑一次
setTimeout(checkKeepaliveReminders, 60000);
console.log('🔔 预防性保活提醒任务已启动');

module.exports = { checkReminders, checkKeepaliveReminders };
