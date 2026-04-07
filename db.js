const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// 确保 data 目录存在
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'bottalk.db');
const db = new Database(dbPath);

// 启用 WAL 模式（更好的并发性能）
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
  const row = db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(version);
  return !!row;
}

function markRun(version) {
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
}

// ── Migration 1: Base tables (users, reminders, push_logs, logs) ─────

if (!hasRun(1)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wechat_openid TEXT UNIQUE,
      send_key TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      time TEXT NOT NULL,
      type TEXT DEFAULT 'once',
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS push_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT,
      content TEXT,
      status TEXT DEFAULT 'pending',
      ip TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      reminder_id INTEGER,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (reminder_id) REFERENCES reminders(id)
    );
  `);
  markRun(1);
}

// ── Migration 2: Channels table ──────────────────────────────────────

if (!hasRun(2)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT,
      channel_type TEXT NOT NULL DEFAULT 'wechat_ilink',
      wechat_openid TEXT,
      bot_token TEXT,
      context_token TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
  markRun(2);
}

// ── Migration 3: Migrate legacy user data into channels ──────────────

if (!hasRun(3)) {
  // Check if old users table has bot_token column (legacy schema)
  const cols = db.pragma('table_info(users)');
  const hasBotToken = cols.some(c => c.name === 'bot_token');

  if (hasBotToken) {
    const legacyUsers = db.prepare(
      'SELECT id, wechat_openid, bot_token, context_token FROM users WHERE bot_token IS NOT NULL'
    ).all();

    const insertChannel = db.prepare(`
      INSERT INTO channels (user_id, name, channel_type, wechat_openid, bot_token, context_token, status, is_default)
      VALUES (?, ?, 'wechat_ilink', ?, ?, ?, 'active', 1)
    `);

    const ensureSendKey = db.prepare('UPDATE users SET send_key = ? WHERE id = ? AND send_key IS NULL');

    const migrate = db.transaction(() => {
      for (const u of legacyUsers) {
        // Check if channel already exists for this user (idempotency)
        const exists = db.prepare('SELECT 1 FROM channels WHERE user_id = ? AND bot_token = ?').get(u.id, u.bot_token);
        if (!exists) {
          insertChannel.run(u.id, 'Default', u.wechat_openid, u.bot_token, u.context_token);
        }
        ensureSendKey.run(generateSendKey(), u.id);
      }
    });
    migrate();

    // Drop legacy columns by recreating the table
    // SQLite doesn't support DROP COLUMN before 3.35, so we keep them but they are unused.
    // The new code only reads/writes the new schema columns on users.
  }
  markRun(3);
}

// ── Migration 4: Sessions table ──────────────────────────────────────

if (!hasRun(4)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expire INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
  `);
  markRun(4);
}

// ── Migration 5: Activity logs table ─────────────────────────────────

if (!hasRun(5)) {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON activity_logs(action);
  `);
  markRun(5);
}

// ── Migration 6: Add channel_id to push_logs ─────────────────────────

if (!hasRun(6)) {
  const pushCols = db.pragma('table_info(push_logs)');
  const hasChannelId = pushCols.some(c => c.name === 'channel_id');
  if (!hasChannelId) {
    try {
      db.exec('ALTER TABLE push_logs ADD COLUMN channel_id INTEGER REFERENCES channels(id)');
    } catch (e) {
      // Column may already exist
    }
  }
  markRun(6);
}

// ── Migration 7: Add email column to users ──────────────────────────

if (!hasRun(7)) {
  const userCols = db.pragma('table_info(users)');
  const hasEmail = userCols.some(c => c.name === 'email');
  if (!hasEmail) {
    try {
      db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    } catch (e) {
      // Column may already exist
    }
  }
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)');
  } catch (e) {
    // Index may already exist
  }
  markRun(7);
}

// ── Migration 8: Add response column to push_logs ──────────────────

if (!hasRun(8)) {
  const pushCols = db.pragma('table_info(push_logs)');
  if (!pushCols.some(c => c.name === 'response')) {
    try {
      db.exec('ALTER TABLE push_logs ADD COLUMN response TEXT');
    } catch (e) {}
  }
  markRun(8);
}

// ── Migration 9: Add send_count and max_count to reminders ──────────

if (!hasRun(9)) {
  const remCols = db.pragma('table_info(reminders)');
  if (!remCols.some(c => c.name === 'send_count')) {
    try { db.exec('ALTER TABLE reminders ADD COLUMN send_count INTEGER DEFAULT 0'); } catch (e) {}
  }
  if (!remCols.some(c => c.name === 'max_count')) {
    try { db.exec('ALTER TABLE reminders ADD COLUMN max_count INTEGER DEFAULT 0'); } catch (e) {}
  }
  markRun(9);
}

// ── Migration 10: Add admin fields to users ─────────────────────────

if (!hasRun(10)) {
  const userCols = db.pragma('table_info(users)');
  if (!userCols.some(c => c.name === 'role')) {
    try { db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'"); } catch (e) {}
  }
  if (!userCols.some(c => c.name === 'is_disabled')) {
    try { db.exec('ALTER TABLE users ADD COLUMN is_disabled INTEGER DEFAULT 0'); } catch (e) {}
  }
  if (!userCols.some(c => c.name === 'rate_limit')) {
    try { db.exec('ALTER TABLE users ADD COLUMN rate_limit INTEGER DEFAULT 100'); } catch (e) {}
  }
  markRun(10);
}

// ── Migration 11: Page views table ──────────────────────────────────

if (!hasRun(11)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS page_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page TEXT NOT NULL,
      tab TEXT,
      user_id INTEGER,
      ip TEXT,
      user_agent TEXT,
      referer TEXT,
      country TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_page_views_page ON page_views(page);
    CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views(created_at);
  `);
  markRun(11);
}

// Migration 12: nickname 字段
if (!hasRun(12)) {
  const userCols = db.pragma('table_info(users)');
  if (!userCols.some(c => c.name === 'nickname')) {
    try { db.exec('ALTER TABLE users ADD COLUMN nickname TEXT'); } catch (e) {}
  }
  markRun(12);
}

// Migration 13: push_logs.read_state 位掩码（bit 0=用户已读，bit 1=admin 已读）
if (!hasRun(13)) {
  const plCols = db.pragma('table_info(push_logs)');
  if (!plCols.some(c => c.name === 'read_state')) {
    try { db.exec('ALTER TABLE push_logs ADD COLUMN read_state INTEGER DEFAULT 0'); } catch (e) {}
  }
  markRun(13);
}

// ── Helpers ──────────────────────────────────────────────────────────

function generateSendKey() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = db;
module.exports.generateSendKey = generateSendKey;
