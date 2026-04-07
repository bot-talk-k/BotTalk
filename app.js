const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Middleware ────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session (30-day cookie, SQLite-backed)
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.use(
  session({
    store: new SqliteStore({
      client: db,
      expired: {
        clear: true,
        intervalMs: 900000, // clean up expired sessions every 15 min
      },
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
    },
  })
);

// 未登录 → intro，已登录 → 功能页（/ 和 /index.html 都走这个逻辑）
function serveByAuth(req, res) {
  if (req.session && req.session.userId) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'intro.html'));
  }
}
app.get('/', serveByAuth);
app.get('/index.html', serveByAuth);

// intro 页面的"开始使用"入口 — 始终返回功能页（让用户扫码登录）
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 静态文件（排除 index.html，强制通过首页路由判断登录状态）
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── Routes ───────────────────────────────────────────────────────────

// New Phase-1 route mounts (files to be created in later phases)
try { app.use('/api/auth', require('./routes/auth')); } catch (e) { /* route not yet created */ }
try { app.use('/api/channels', require('./routes/channels')); } catch (e) { /* route not yet created */ }
try { app.use('/api/key', require('./routes/key')); } catch (e) { /* route not yet created */ }
try { app.use('/api/push-logs', require('./routes/push-logs')); } catch (e) { /* route not yet created */ }
try { app.use('/api/admin', require('./routes/admin')); } catch (e) { /* route not yet created */ }
try { app.use('/api/track', require('./routes/track')); } catch (e) { /* route not yet created */ }

// Existing routes (login.js removed — replaced by routes/auth.js)
app.use('/api/reminders', require('./routes/reminders'));
app.use('/', require('./routes/notify'));

// 提供 BASE_URL 给前端
app.get('/api/config', (req, res) => {
  res.json({ base_url: BASE_URL });
});

// ── Startup ──────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 BotTalk 运行在 http://localhost:${PORT}`);
  console.log(`📡 API 地址: ${BASE_URL}`);

  // Start scheduler
  require('./scheduler');

  // Restore message pollers for all active channels with context_token
  try {
    const { startMessagePoller } = require('./services/message-poller');
    const activeChannels = db
      .prepare(
        "SELECT c.id, c.bot_token, c.wechat_openid, c.context_token FROM channels c WHERE c.status = 'active' AND c.context_token IS NOT NULL AND c.bot_token IS NOT NULL"
      )
      .all();

    for (const ch of activeChannels) {
      console.log(`🔄 恢复频道轮询: channel=${ch.id} openid=${ch.wechat_openid}`);
      startMessagePoller(ch.bot_token, ch.wechat_openid);
    }

    if (activeChannels.length > 0) {
      console.log(`✅ 已恢复 ${activeChannels.length} 个频道的消息轮询`);
    }
  } catch (e) {
    console.error('⚠️ 恢复频道轮询失败:', e.message);
  }
});
