// BotTalk 飞书独立推送站 — Express 启动入口。
// 极简:无 scheduler、无 poller、无重试队列(飞书不需要)。
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const db = require('./db');

// 持久化 session secret:env 优先,否则在 data 目录生成并复用,避免每次重启登录失效
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
// 微信现站地址(intro 页「微信通道」入口指向它)
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

// 已知爬虫/扫描器 UA(明牌搜索/AI 爬虫 + 常见 CLI/库);命中则不计入访问统计
const BOT_UA = /bingbot|googlebot|gptbot|claudebot|ccbot|petalbot|dotbot|mj12bot|semrushbot|ahrefsbot|bytespider|baiduspider|yandex|duckduckbot|applebot|perplexity|amazonbot|crawler|crawl|spider|slurp|scanner|zgrab|masscan|censys|shodan|expanse|facebookexternalhit|curl\/|wget|python-requests|python-urllib|go-http-client|java\/|libwww|okhttp|headless|phantomjs|node-fetch|axios\/|dataforseo|\bbot\b/i;

// 页面访问日志(记到 activity_logs,供超管仪表盘统计;排除超管自己 + 爬虫)
function logPageView(page) {
  return (req, res, next) => {
    try {
      const ua = req.headers['user-agent'] || '';
      if (!ua || BOT_UA.test(ua)) { next(); return; } // 空 UA / 爬虫 不记
      // 超管自己的访问不记录,保持统计数据真实
      if (req.session?.userId) {
        const u = db.prepare('SELECT role FROM users WHERE id=?').get(req.session.userId);
        if (u?.role === 'admin') { next(); return; }
      }
      const ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      db.prepare('INSERT INTO activity_logs (user_id, action, detail, ip, user_agent) VALUES (?,?,?,?,?)')
        .run(req.session?.userId || null, 'page_view', page, ip || null, req.headers['user-agent'] || null);
    } catch (e) { /* 不阻塞请求 */ }
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

// 前端配置
app.get('/api/config', (req, res) => {
  res.json({ base_url: BASE_URL, wechat_site_url: WECHAT_SITE_URL });
});

app.listen(PORT, () => {
  console.log(`🪶 BotTalk 飞书站运行在 http://localhost:${PORT}`);
  console.log(`📡 API: ${BASE_URL}`);
});
