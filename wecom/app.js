// BotTalk 企业微信独立推送站 — Express 启动入口。
// 与微信站/飞书站完全独立。唯一后台:WS 连接池(常驻长连接 + 启动恢复)。
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const db = require('./db');
const pool = require('./services/wecom-pool');

function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const dir = process.env.DATABASE_DIR ? path.resolve(process.env.DATABASE_DIR) : path.join(__dirname, 'data');
  const secretPath = path.join(dir, '.session_secret');
  try {
    if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
    const s = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(secretPath, s, { mode: 0o600 });
    return s;
  } catch (e) {
    console.error('session secret 持久化失败,退回随机:', e.message);
    return crypto.randomBytes(32).toString('hex');
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const WECHAT_SITE_URL = process.env.WECHAT_SITE_URL || 'https://bot-talk.com';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SESSION_SECRET = resolveSessionSecret();
app.use(session({
  store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 900000 } }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true },
}));

// 页面访问日志(记 activity_logs,供超管仪表盘统计;排除超管自己)
function logPageView(page) {
  return (req, res, next) => {
    try {
      if (req.session?.userId) {
        const u = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
        if (u?.role === 'admin') { next(); return; }
      }
      const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      db.prepare('INSERT INTO activity_logs (user_id, action, detail, ip, user_agent) VALUES (?,?,?,?,?)')
        .run(req.session?.userId || null, 'page_view', page, ip || null, req.headers['user-agent'] || null);
    } catch (e) { /* 不阻塞 */ }
    next();
  };
}

app.get('/', logPageView('intro'), (req, res) => res.sendFile(path.join(__dirname, 'public', 'intro.html')));
app.get('/app', logPageView('app'), (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// 路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/push-logs', require('./routes/push-logs'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/internal', require('./routes/internal'));
app.use('/', require('./routes/notify')); // 推送 API:/notify + /:key.send

app.get('/api/config', (req, res) => {
  res.json({ base_url: BASE_URL, wechat_site_url: WECHAT_SITE_URL, channel: 'wecom' });
});

app.listen(PORT, () => {
  console.log(`🏢 BotTalk 企业微信站运行在 http://localhost:${PORT}`);
  console.log(`📡 API: ${BASE_URL}`);
  // 启动恢复 WS 连接池(常驻长连接)
  pool.init().catch(e => console.error('wecom-pool init 失败:', e.message));
});
