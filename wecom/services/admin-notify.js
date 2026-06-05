// 超管通知 — 把关键事件推到所有 admin 用户的企业微信通道(经 WS 连接池)
// fire-and-forget,不阻塞调用方,失败只记 console。
// 同类事件 1 小时内只推一次(避免失败风暴刷屏)。

const db = require('../db');

const _dedup = new Map();
function dedup(key) {
  const hour = Math.floor(Date.now() / 3600000);
  const k = `${key}:${hour}`;
  if (_dedup.has(k)) return true;
  _dedup.set(k, 1);
  for (const [ek] of _dedup) { if (!ek.endsWith(`:${hour}`)) _dedup.delete(ek); }
  return false;
}

function getAdminChannels() {
  return db.prepare(`
    SELECT c.id
    FROM channels c
    JOIN users u ON u.id = c.user_id
    WHERE u.role = 'admin' AND c.status = 'active' AND c.captured_userid IS NOT NULL
    ORDER BY c.id DESC
  `).all();
}

function send(msg, dedupKey) {
  if (dedupKey && dedup(dedupKey)) return;
  const pool = require('./wecom-pool'); // 懒加载避免循环依赖
  for (const ch of getAdminChannels()) {
    pool.send(ch.id, msg).catch((e) => console.error('admin-notify failed:', e.message));
  }
}

module.exports = { send };
