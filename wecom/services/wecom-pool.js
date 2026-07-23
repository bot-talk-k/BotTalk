// 企业微信 WS 常驻连接池 — 每个 active/pending_userid channel 一条 WS。
//
// 事实源 = 内存 pool(Map);DB 的 ws_state/captured_userid 是镜像/持久化。
// 关键职责:
//   - init():进程启动时按库恢复所有 channel 的 WS(无需用户再互动)。
//   - ensure(channel):建/重连一条 WS。
//   - send(channelId, md):主动推送(无 userid → 抛 pending_userid;未就绪 → 抛 ws_not_ready)。
//   - userid 捕获 → 落库 + pending_userid 转 active + 首次补发欢迎消息(含 SendKey)。

const db = require('../db');
const { createConnection } = require('./wecom-client');

const pool = new Map(); // channelId -> entry

function nowISO() { return new Date().toISOString(); }

// userid 捕获 → 落库 → 激活 → 首次补欢迎
function applyCapture(channelId, userid) {
  if (!userid) return;
  const entry = pool.get(channelId);
  if (entry) entry.capturedUserId = userid;
  const row = db.prepare('SELECT status, captured_userid, user_id FROM channels WHERE id = ?').get(channelId);
  if (!row) return;
  if (row.captured_userid === userid && row.status === 'active') return; // 无变化
  const firstTime = row.status === 'pending_userid' || !row.captured_userid;
  db.prepare(
    "UPDATE channels SET captured_userid = ?, captured_at = CURRENT_TIMESTAMP, status = CASE WHEN status = 'inactive' THEN status ELSE 'active' END WHERE id = ?"
  ).run(userid, channelId);
  if (firstTime) sendWelcome(channelId, userid);
}

// 建/重连一条 WS
function ensure(channel) {
  const existing = pool.get(channel.id);
  if (existing && existing.client && existing.client.isConnected) return existing;
  if (existing && existing.client) existing.client.disconnect();

  const entry = {
    channelId: channel.id,
    botId: channel.wecom_bot_id,
    authenticated: false,
    capturedUserId: channel.captured_userid || null,
    lastError: null,
    startedAt: nowISO(),
    client: null,
  };

  entry.client = createConnection({
    botId: channel.wecom_bot_id,
    secret: channel.wecom_secret,
    onAuthenticated: () => {
      entry.authenticated = true;
      entry.lastError = null;
      db.prepare("UPDATE channels SET ws_state = 'authenticated', last_error = NULL WHERE id = ?").run(channel.id);
    },
    onDisconnected: () => {
      entry.authenticated = false;
      db.prepare("UPDATE channels SET ws_state = 'disconnected' WHERE id = ?").run(channel.id);
    },
    onError: (err) => {
      entry.lastError = err;
      db.prepare('UPDATE channels SET last_error = ? WHERE id = ?').run(String(err).slice(0, 200), channel.id);
    },
    onCapture: (userid) => applyCapture(channel.id, userid),
  });

  pool.set(channel.id, entry);
  return entry;
}

// 主动推送 markdown
async function send(channelId, content) {
  const entry = pool.get(channelId);
  if (!entry || !entry.client) {
    // 池里没有(可能进程刚起还没 ensure)→ 尝试现拉起
    const ch = db.prepare("SELECT * FROM channels WHERE id = ? AND status != 'inactive'").get(channelId);
    if (ch) ensure(ch);
    const e = new Error('ws_not_ready'); e.code = 'ws_not_ready'; throw e;
  }
  if (!entry.client.isConnected || !entry.authenticated) {
    const e = new Error('ws_not_ready'); e.code = 'ws_not_ready'; throw e;
  }
  const userid = entry.capturedUserId
    || (db.prepare('SELECT captured_userid FROM channels WHERE id = ?').get(channelId) || {}).captured_userid;
  if (!userid) { const e = new Error('pending_userid'); e.code = 'pending_userid'; throw e; }
  return entry.client.sendMarkdown(userid, content); // → { headers, errcode, errmsg }
}

function remove(channelId) {
  const entry = pool.get(channelId);
  if (entry && entry.client) entry.client.disconnect();
  pool.delete(channelId);
}

function getState(channelId) {
  const entry = pool.get(channelId);
  if (!entry) return { connected: false, authenticated: false, capturedUserId: null, lastError: null };
  return {
    connected: entry.client ? entry.client.isConnected : false,
    authenticated: entry.authenticated,
    capturedUserId: entry.capturedUserId,
    lastError: entry.lastError,
  };
}

// 全局运行态(internal stats 用)
function poolStats() {
  let authed = 0;
  for (const e of pool.values()) if (e.authenticated) authed++;
  return { ws_total: pool.size, ws_authenticated: authed };
}

// 启动恢复:按库拉起所有 active/pending_userid 通道(串行 + 节流)
async function init() {
  const channels = db.prepare("SELECT * FROM channels WHERE status IN ('active','pending_userid')").all();
  for (const ch of channels) {
    try { ensure(ch); } catch (e) { console.error('wecom-pool ensure failed', ch.id, e.message); }
    await new Promise((r) => setTimeout(r, 200)); // 节流,避免瞬时大量连企业微信被限连
  }
  console.log(`🔌 wecom-pool 启动恢复: ${channels.length} 条 WS`);
}

// 首次捕获 userid 时补发欢迎消息(含 SendKey)
function sendWelcome(channelId, userid) {
  const ch = db.prepare('SELECT user_id FROM channels WHERE id = ?').get(channelId);
  if (!ch) return;
  const user = db.prepare('SELECT send_key FROM users WHERE id = ?').get(ch.user_id);
  if (!user) return;
  const base = process.env.BASE_URL || 'https://bot-talk.com';
  const md = `**🎉 企业微信通道已激活!**\n\n你的 SendKey:\n\`${user.send_key}\`\n\n请保存。推送示例:\n\`curl "${base}/${user.send_key}.send?title=测试&desp=hello"\`\n\n激活后无需再回复,可无限接收推送。`;
  const entry = pool.get(channelId);
  if (entry && entry.client) entry.client.sendMarkdown(userid, md).catch((e) => console.error('welcome failed', e.message));
}

module.exports = { init, ensure, send, remove, getState, poolStats };
