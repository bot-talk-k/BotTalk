// 超管通知 — 把关键事件推到所有 admin 用户的飞书通道
// fire-and-forget,不阻塞调用方,失败只记 console

const db = require('../db');
const feishu = require('./feishu-client');

// 同类事件 1 小时内只推一次(避免失败风暴刷屏)
const _dedup = new Map();
function dedup(key) {
  const hour = Math.floor(Date.now() / 3600000);
  const k = `${key}:${hour}`;
  if (_dedup.has(k)) return true;
  _dedup.set(k, 1);
  // 清理旧 key
  for (const [ek] of _dedup) { if (!ek.endsWith(`:${hour}`)) _dedup.delete(ek); }
  return false;
}

function getAdminChannels() {
  return db.prepare(`
    SELECT c.feishu_app_id, c.feishu_app_secret, c.feishu_domain, c.feishu_open_id
    FROM channels c
    JOIN users u ON u.id = c.user_id
    WHERE u.role = 'admin' AND c.status = 'active' AND c.feishu_open_id IS NOT NULL
    ORDER BY c.id DESC
  `).all();
}

function send(msg, dedupKey) {
  if (dedupKey && dedup(dedupKey)) return;
  const admins = getAdminChannels();
  for (const ch of admins) {
    feishu.sendText({
      appId: ch.feishu_app_id, appSecret: ch.feishu_app_secret,
      domain: ch.feishu_domain, receiveId: ch.feishu_open_id,
      receiveIdType: 'open_id', text: msg,
    }).catch(e => console.error('admin-notify failed:', e.message));
  }
}

module.exports = { send };
