// BotTalk 官网门户 + 全站综合看板 — 独立容器,与各渠道零运行时耦合。
// /        官网 landing(公开):列出多渠道,用户选一个跳过去
// /board   综合看板(超管):聚合各渠道 internal 只读统计 + 深链各渠道 admin
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const db = require('./db');

function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const dir = process.env.DATABASE_DIR ? path.resolve(process.env.DATABASE_DIR) : path.join(__dirname, 'data');
  const p = path.join(dir, '.session_secret');
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
    const s = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, s, { mode: 0o600 });
    return s;
  } catch (e) { return crypto.randomBytes(32).toString('hex'); }
}

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 900000 } }),
  secret: resolveSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true },
}));

// portal 只做综合看板;官网 landing 是 bot-talk.com(裸域名),根路径直接跳看板
app.get('/', (req, res) => res.redirect('/board'));
app.get('/board', (req, res) => res.sendFile(path.join(__dirname, 'public', 'board.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/board', require('./routes/board'));

app.get('/api/config', (req, res) => res.json({ base_url: BASE_URL }));

app.listen(PORT, () => {
  console.log(`🌐 BotTalk 门户运行在 http://localhost:${PORT}`);
  console.log(`📡 ${BASE_URL}`);
});
