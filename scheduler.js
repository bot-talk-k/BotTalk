const db = require('./db');
const ilink = require('./ilink');
const { getContextToken } = require('./services/message-poller');
const { alertAdminsOnFailure } = require('./routes/notify');
const { markSendResult } = require('./services/channel-health');
const { enqueueSend } = require('./services/push-queue');

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
      const channelRowForQueue = db.prepare("SELECT id FROM channels WHERE bot_token = ? AND wechat_openid = ? LIMIT 1").get(r.bot_token, r.wechat_openid);
      const queueChId = channelRowForQueue?.id;
      let ilinkRes;
      const startedAt = Date.now();
      try {
        ilinkRes = await enqueueSend(queueChId,
          () => ilink.sendMessage(r.bot_token, r.wechat_openid, message, contextToken),
          { title: r.title, source: 'scheduler' });
      } catch (retryErr) {
        if (retryErr.response?.data?.ret === -2) {
          console.log(`⏳ 提醒 ${r.wechat_openid} ret:-2，5秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          const delaySec = Math.round((Date.now() - startedAt) / 1000);
          const retryMessage = `ℹ️ 本消息因通道临时不稳定延迟 ${delaySec} 秒送达\n\n${message}`;
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

// ═══════════════════════════════════════════════════════════════════
// 24 小时会话到期预警 — iLink session 硬性 24h 限制
// 通道 bot_token 满 22h 未更新时，主动发消息提醒用户重新扫码
// ═══════════════════════════════════════════════════════════════════

// 内存去重：同一通道只发一次预警（直到 bot_token 刷新后才能再次发）
const sessionWarnedChannels = {};

async function checkSessionExpiry() {
  try {
    // 找所有接近 22h 但未满 24h 的通道（含 context_token 才能发消息提醒）
    const channels = db.prepare(`
      SELECT c.id, c.user_id, c.bot_token, c.wechat_openid, c.context_token, c.bot_token_updated_at,
             u.nickname,
             (strftime('%s', 'now') - strftime('%s', c.bot_token_updated_at)) AS age_seconds
      FROM channels c
      JOIN users u ON u.id = c.user_id
      WHERE c.context_token IS NOT NULL
        AND c.bot_token_updated_at IS NOT NULL
        AND (strftime('%s', 'now') - strftime('%s', c.bot_token_updated_at)) BETWEEN 79200 AND 86400
    `).all();

    for (const ch of channels) {
      // 用 bot_token_updated_at 做去重 key — 一旦重绑后 key 变化，可再次预警
      const dedupKey = `${ch.id}:${ch.bot_token_updated_at}`;
      if (sessionWarnedChannels[dedupKey]) continue;

      const hoursRemaining = Math.max(0, Math.round((86400 - ch.age_seconds) / 3600));
      const msg = `⏱️ BotTalk 通道保活提醒\n\n` +
        `你已经约 ${24 - hoursRemaining} 小时没有给 Bot 回复消息。微信 ClawBot 平台要求每 24 小时内至少有一次用户→Bot 的消息，否则通道会失联。\n\n` +
        `✅ 保活方法（只需 1 步）：\n` +
        `在微信里给我回复任意一个字（如"在" "收到" 等），即可续命 24 小时。无需重新扫码。\n\n` +
        `如果你已经错过或不确定是否失联，可访问：\n` +
        `https://bot-talk.com/app?rebind=1 重新扫码（SendKey 不变）。\n\n` +
        `这是微信 ClawBot 平台当前的限制，我们会持续跟进改进。`;

      try {
        const r = await enqueueSend(ch.id,
          () => ilink.sendMessage(ch.bot_token, ch.wechat_openid, msg, ch.context_token),
          { title: '⏱️ 通道即将到期', source: 'session-warning' });
        db.prepare(`
          INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response)
          VALUES (?, ?, ?, 'success', 'session-warning', ?, ?)
        `).run(ch.user_id, '⏱️ 通道即将到期', msg, ch.id, JSON.stringify(r));
        markSendResult(ch.id, r, true);
        console.log(`📢 已发送 24h 预警: channel=${ch.id} user=${ch.nickname || ch.user_id}`);
        sessionWarnedChannels[dedupKey] = Date.now();
      } catch (e) {
        console.error(`❌ 24h 预警发送失败 channel=${ch.id}:`, e.response?.data || e.message);
        markSendResult(ch.id, e, false);
      }
    }
  } catch (e) {
    console.error('checkSessionExpiry 错误:', e.message);
  }
}

// 每 15 分钟检查一次是否有通道接近过期
setInterval(checkSessionExpiry, 15 * 60 * 1000);
// 启动 30 秒后先跑一次
setTimeout(checkSessionExpiry, 30000);
console.log('⏱️ 24h 会话预警任务已启动');

module.exports = { checkReminders, checkSessionExpiry };
