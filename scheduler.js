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
    // 提到 try 外面,catch 块也要用它做"达 max 就删"判定
    const sendCount = (r.send_count || 0) + 1;
    const maxCount = r.max_count || 0; // 0 = 无限制
    try {
      const contextToken = r.channel_context_token || getContextToken(r.wechat_openid);

      if (!contextToken) {
        console.log(`⚠️ ${r.wechat_openid} 无 context_token，跳过`);
        continue;
      }

      // 立即递增 send_count(无论后续成功/失败都算用掉一次配额)
      // 历史教训(2026-05-21): 旧逻辑只在 success 才递增,导致 every2min reminder
      // 通道 ret:-2 时永远 send_count=0 < max_count,12 天无限轰炸用户
      db.prepare('UPDATE reminders SET send_count = ? WHERE id = ?').run(sendCount, r.id);

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

      // send_count 已在 try 块前递增,这里不再重复
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

      // 体验提醒(every2min)失败也算尝试次数;达到 max_count 也要删除
      // 防止 ret:-2 状态下无限重试轰炸用户
      if (maxCount > 0 && sendCount >= maxCount) {
        try {
          db.prepare('DELETE FROM logs WHERE reminder_id = ?').run(r.id);
          db.prepare('DELETE FROM reminders WHERE id = ?').run(r.id);
          console.log(`🗑️ 体验提醒 ${r.id} 失败次数已达上限 ${maxCount},自动删除`);
        } catch (e) {
          console.error('清理失败提醒错误:', e.message);
        }
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
// 预防性保活提醒 — 已废弃移除 (2026-07-19)
// 原因：用户已迁移至企业微信/飞书通道，不再需要微信 24h 保活机制。
// 如未来需要恢复，见 git history: feat(wecom) commit 之前的版本。
// ═══════════════════════════════════════════════════════════════════

// 每 30 分钟扫一次
// setInterval(checkKeepaliveReminders, 30 * 60 * 1000);  // 已移除：保活提醒废弃

// 延时重试队列：每 30 秒扫描到期任务
const { processRetries, cleanupStalePaused } = require('./services/retry-queue');
setInterval(() => {
  processRetries().catch(e => console.error('processRetries 错误:', e.message));
}, 30000);
setTimeout(() => {
  processRetries().catch(e => console.error('processRetries 错误:', e.message));
}, 45000);

// 每 6 小时清理一次 24h+ 未触发的 paused record(用户始终没回复 = abandoned)
setInterval(cleanupStalePaused, 6 * 60 * 60 * 1000);
setTimeout(cleanupStalePaused, 60 * 1000); // 启动 60s 后跑一次,避免每次重启都立刻清

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
// setTimeout(checkKeepaliveReminders, 60000);  // 已移除
// console.log('🔔 预防性保活提醒任务已启动');  // 已移除

module.exports = { checkReminders };
