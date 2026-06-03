const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const db = require('./db');
const { reportError } = require('./services/error-reporter');

// 进程级未捕获异常上报到管理员微信（限流 30 分钟/同样错误）
// uncaughtException：保留 stderr 打印 + 上报，但不退出进程（保持服务运行）
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  reportError(err, { phase: 'uncaughtException' });
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  reportError(reason instanceof Error ? reason : new Error(String(reason)), {
    phase: 'unhandledRejection',
  });
});

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

// 首页路由：已登录 → 功能页，未登录 → intro
function serveByAuth(req, res) {
  if (req.session && req.session.userId) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'intro.html'));
  }
}
app.get('/', serveByAuth);
app.get('/index.html', serveByAuth);

// intro 的"开始使用"入口 — 标记来源后进入功能页
app.get('/app', (req, res) => {
  if (req.session && req.session.userId) {
    // 已登录直接进
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  if (req.query.from === 'intro') {
    // 从 intro 点过来，允许进入（扫码登录）
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  // 其他情况跳回 intro
  res.redirect('/');
});

// intro 页面始终可访问（已登录用户也能看）
app.get('/intro', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'intro.html'));
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

// 飞书 MVP 原型(默认关闭,生产部署不挂载;ENABLE_FEISHU_PROTO=1 启用)
if (process.env.ENABLE_FEISHU_PROTO === '1') {
  try {
    app.use('/api/feishu-proto', require('./experiments/feishu/routes'));
    console.log('🧪 飞书 MVP 原型已挂载: /api/feishu-proto/* + /feishu-proto.html (admin only)');
  } catch (e) {
    console.error('🧪 飞书原型挂载失败:', e.message);
  }
}

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
        `SELECT c.id, c.bot_token, c.wechat_openid, c.context_token
         FROM channels c
         WHERE c.id IN (
           SELECT MAX(id) FROM channels
           WHERE context_token IS NOT NULL AND bot_token IS NOT NULL
           GROUP BY wechat_openid
         )`
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
