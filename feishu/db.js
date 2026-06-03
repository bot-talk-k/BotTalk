// BotTalk 飞书站独立数据库 — 与微信站完全不相干的 SQLite。
//
// 极简 schema:无任何 iLink 健康/重试/保活列(飞书无 10 条限流、无时间衰减、无需互动)。
// 迁移用 hasRun(N)/markRun(N) 模式,递增 N(照微信站 db.js 约定)。

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// DATABASE_DIR 覆盖默认路径(测试隔离 / 容器挂载)
const dataDir = process.env.DATABASE_DIR
  ? path.resolve(process.env.DATABASE_DIR)
  : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'bottalk-feishu.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema version tracking ──────────────────────────────────────────

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
//   users    — 身份锚点是 id;send_key 是登录/推送凭证;feishu_open_id 仅记录首次扫码身份
//   channels — 每行一个飞书 app(= 一个通道),存该 app 的凭证 + 发送目标 open_id
//   push_logs / sessions / activity_logs

if (!hasRun(1)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feishu_open_id TEXT,
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
      feishu_app_id TEXT NOT NULL,
      feishu_app_secret TEXT NOT NULL,
      feishu_domain TEXT NOT NULL DEFAULT 'feishu',
      feishu_open_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
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
  return 'fs_' + crypto.randomBytes(16).toString('hex');
}

module.exports = db;
module.exports.generateSendKey = generateSendKey;
