const db = require('./db');
const ilink = require('./ilink');
const { getContextToken } = require('./services/message-poller');

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
    JOIN channels c ON c.user_id = u.id AND c.is_default = 1 AND c.status = 'active'
    WHERE r.enabled = 1 AND r.type != 'every2min'
      AND (r.time = ? OR r.time LIKE ?)
  `).all(timeHHMM, '%T' + timeHHMM);

  // 每2分钟体验提醒：偶数分钟触发
  const every2minReminders = currentMinute % 2 === 0 ? db.prepare(`
    SELECT r.*, r.user_id as reminder_user_id,
           u.id as db_user_id, c.bot_token, c.wechat_openid, c.context_token as channel_context_token
    FROM reminders r
    JOIN users u ON r.user_id = u.wechat_openid OR CAST(r.user_id AS INTEGER) = u.id
    JOIN channels c ON c.user_id = u.id AND c.is_default = 1 AND c.status = 'active'
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

      await ilink.sendMessage(r.bot_token, r.wechat_openid, message, contextToken);

      // 更新发送次数
      db.prepare('UPDATE reminders SET send_count = ? WHERE id = ?').run(sendCount, r.id);

      db.prepare(`
        INSERT INTO logs (user_id, reminder_id, status)
        VALUES (?, ?, 'sent')
      `).run(r.db_user_id, r.id);

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
      console.error(`❌ 提醒发送失败：${r.wechat_openid}`, error.response?.data || error.message);
    }
  }
}

setInterval(checkReminders, 60000);
console.log('⏰ 定时任务已启动');

module.exports = { checkReminders };
