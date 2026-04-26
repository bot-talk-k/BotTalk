// 一次性：向 channel 8 用户解释保活提醒机制
const db = require('/app/db');
const ilink = require('/app/ilink');
const { enqueueSend } = require('/app/services/push-queue');
const { markSendResult } = require('/app/services/channel-health');

const CHANNEL_ID = 8;

const msg = [
  '👋 你好呀，看到你问"能不能给我设个提醒"——这个功能其实是内置的，在这里把工作方式说清楚给你：',
  '',
  '🔄 保活窗口',
  '• 你每次回复任意一个字，保活窗口就会刷新为 24 小时',
  '• 窗口内通道一直保持活跃，完全不用操心',
  '',
  '⏰ 自动提醒',
  '• 如果你连续不回复，系统会在"最后一次互动"之后的第 22 小时',
  '• 主动向你发一条提醒，请你回一个字（"好""在""1" 都行）',
  '• 回完就又是新的 24 小时',
  '',
  '✨ 也就是说：',
  '• 正常用完全无感',
  '• 快掉线前我们会先喊你一声，而不是事后让你发现通道没了',
  '',
  '💌 这条是管理员手动发送的回复；之后的 22 小时提醒由系统自动发出，不会打扰 🙏',
].join('\n');

(async () => {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(CHANNEL_ID);
  if (!ch) { console.error('channel not found'); process.exit(1); }
  if (!ch.context_token) { console.error('no context_token'); process.exit(1); }
  try {
    const r = await enqueueSend(ch.id,
      () => ilink.sendMessage(ch.bot_token, ch.wechat_openid, msg, ch.context_token),
      { title: '💬 管理员回复：保活提醒说明', source: 'admin-manual' });
    markSendResult(ch.id, r, true);
    db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'success', 'admin-manual', ?, ?)")
      .run(ch.user_id, '💬 管理员回复：保活提醒说明', msg, ch.id, JSON.stringify(r));
    console.log('✅ sent:', JSON.stringify(r));
  } catch (err) {
    markSendResult(ch.id, err, false);
    const errData = err.response?.data;
    db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'failed', 'admin-manual', ?, ?)")
      .run(ch.user_id, '💬 管理员回复：保活提醒说明', msg, ch.id, JSON.stringify(errData || { error: err.message }));
    console.error('❌ failed:', errData || err.message);
    process.exit(2);
  }
  process.exit(0);
})();
