// BotTalk 企业微信站独立数据库 — 与微信站/飞书站完全不相干的 SQLite。
//
// 关键差异(对照 feishu/db.js):企业微信是 WS 长连接,且扫码只返回 botid/secret、
// 不返回发送目标 userid —— userid 要从 WS 的 enter_chat 事件/用户首条消息里捕获后回填。
// 所以 channels 表多了 captured_userid / captured_at / ws_state,status 有 pending_userid 态。
//
// 迁移用 hasRun(N)/markRun(N) 模式,递增 N。

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const dataDir = process.env.DATABASE_DIR
  ? path.resolve(process.env.DATABASE_DIR)
  : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'bottalk-wecom.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function hasRun(version) {
  return !!db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(version);
}
function markRun(version) {
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
}

// ── Migration 1: 基础表 ──────────────────────────────────────────────
//   users    — 身份锚点 id;send_key(ww_ 前缀)登录/推送凭证
//   channels — 每行一个企业微信智能机器人(= 一个通道),存 botid/secret + 捕获的 userid
//              status: pending_userid(已绑未捕获 userid,不能推) → active(可推) → inactive(软删/凭证死)
//              ws_state: 运行态镜像(诊断用),事实源是内存连接池

if (!hasRun(1)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wecom_userid TEXT,
      email TEXT UNIQUE,
      send_key TEXT UNIQUE NOT NULL,
      nickname TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      is_disabled INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT,
      wecom_bot_id TEXT NOT NULL,
      wecom_secret TEXT NOT NULL,
      captured_userid TEXT,
      captured_at DATETIME,
      status TEXT NOT NULL DEFAULT 'pending_userid',
      ws_state TEXT DEFAULT 'disconnected',
      last_error TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);

    CREATE TABLE IF NOT EXISTS push_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      channel_id INTEGER,
      title TEXT,
      content TEXT,
      status TEXT DEFAULT 'pending',
      ip TEXT,
      response TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_push_logs_user ON push_logs(user_id, id DESC);

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expire INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);

    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      detail TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id);
  `);
  markRun(1);
}

// ── Helpers ──────────────────────────────────────────────────────────

function generateSendKey() {
  return 'ww_' + crypto.randomBytes(16).toString('hex');
}

module.exports = db;
module.exports.generateSendKey = generateSendKey;
