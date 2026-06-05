// Portal 极简 DB —— 只为 express-session 的 SQLite store 提供 sessions 表。
// portal 本身无业务数据(看板数据实时从各渠道 internal API 拉)。
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATABASE_DIR ? path.resolve(process.env.DATABASE_DIR) : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'portal.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
`);

module.exports = db;
