const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// 确保 data 目录存在（DATABASE_DIR 环境变量覆盖默认路径，用于测试隔离）
const dataDir = process.env.DATABASE_DIR
  ? path.resolve(process.env.DATABASE_DIR)
  : path.join(__dirname, 'data');
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

// Migration 14: channels.bot_token_updated_at — 追踪 bot_token 刷新时间，用于 iLink 24h session 预警
if (!hasRun(14)) {
  const chCols = db.pragma('table_info(channels)');
  if (!chCols.some(c => c.name === 'bot_token_updated_at')) {
    try { db.exec('ALTER TABLE channels ADD COLUMN bot_token_updated_at DATETIME'); } catch (e) {}
    // 已有数据的 bot_token_updated_at 用 created_at 作初始值（估算）
    try { db.exec('UPDATE channels SET bot_token_updated_at = created_at WHERE bot_token_updated_at IS NULL'); } catch (e) {}
  }
  markRun(14);
}

// Migration 17: channels.last_inbound_at + inbound_events 表
// 记录用户 → bot 消息活动，用于精准保活触发和数据分析
if (!hasRun(17)) {
  const chCols = db.pragma('table_info(channels)');
  if (!chCols.some(c => c.name === 'last_inbound_at')) {
    try { db.exec('ALTER TABLE channels ADD COLUMN last_inbound_at DATETIME'); } catch (e) {}
  }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS inbound_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER REFERENCES channels(id),
      wechat_openid TEXT,
      from_user_id TEXT,
      message_type INTEGER,
      has_text INTEGER DEFAULT 0,
      text_preview TEXT,
      context_token_prefix TEXT,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_inbound_events_channel_time ON inbound_events(channel_id, received_at DESC)');
  } catch (e) { console.error('migration 17 table error:', e.message); }
  markRun(17);
}

// Migration 16: channels 加 send_disabled — 表示 "iLink 拒绝发送但允许接收" 的半死态
//   （典型场景：账号未实名认证被风控，getUpdates ok 但 sendMessage 返回 ret:-14）
if (!hasRun(16)) {
  const chCols = db.pragma('table_info(channels)');
  if (!chCols.some(c => c.name === 'send_disabled')) {
    try { db.exec('ALTER TABLE channels ADD COLUMN send_disabled INTEGER DEFAULT 0'); } catch (e) {}
  }
  if (!chCols.some(c => c.name === 'send_disabled_reason')) {
    try { db.exec('ALTER TABLE channels ADD COLUMN send_disabled_reason TEXT'); } catch (e) {}
  }
  if (!chCols.some(c => c.name === 'send_disabled_at')) {
    try { db.exec('ALTER TABLE channels ADD COLUMN send_disabled_at DATETIME'); } catch (e) {}
  }
  markRun(16);
}

// Migration 15: channels 加 last_send_success_at / consecutive_neg2_count / last_neg2_at
// 用于通道健康度三色展示和 ret:-2 衰退观测
if (!hasRun(15)) {
  const chCols = db.pragma('table_info(channels)');
  if (!chCols.some(c => c.name === 'last_send_success_at')) {
    try { db.exec('ALTER TABLE channels ADD COLUMN last_send_success_at DATETIME'); } catch (e) {}
  }
  if (!chCols.some(c => c.name === 'consecutive_neg2_count')) {
    try { db.exec('ALTER TABLE channels ADD COLUMN consecutive_neg2_count INTEGER DEFAULT 0'); } catch (e) {}
  }
  if (!chCols.some(c => c.name === 'last_neg2_at')) {
    try { db.exec('ALTER TABLE channels ADD COLUMN last_neg2_at DATETIME'); } catch (e) {}
  }
  // 回填 last_send_success_at：从 push_logs 里取每个 channel 最近一次 success 的时间
  try {
    db.exec(`
      UPDATE channels SET last_send_success_at = (
        SELECT MAX(p.created_at) FROM push_logs p
        WHERE p.channel_id = channels.id AND p.status = 'success'
      )
      WHERE last_send_success_at IS NULL
    `);
  } catch (e) {}
  markRun(15);
}

// Migration 18: push_retry_queue — 延时重试队列（持久化 + 丰富元数据）
// 数据价值：后期可 SQL 分析"第 N 次重试成功率 / 自然恢复 vs 重试成功比例 / 错误码 × 重试间隔"
if (!hasRun(18)) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_retry_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        channel_id INTEGER,
        title TEXT,
        content TEXT,
        source TEXT,
        original_push_log_id INTEGER,
        first_failed_at DATETIME NOT NULL,
        first_error_code INTEGER,
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 4,
        next_try_at DATETIME NOT NULL,
        last_try_at DATETIME,
        failure_history TEXT DEFAULT '[]',
        status TEXT DEFAULT 'pending',
        recovered_by TEXT,
        recovered_at DATETIME,
        final_attempt_count INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_retry_queue_status_next ON push_retry_queue(status, next_try_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_retry_queue_channel ON push_retry_queue(channel_id)');
  } catch (e) {
    console.error('migration 18 error:', e.message);
  }
  markRun(18);
}

// Migration 19: neg2_recovery_probe — ret:-2 持续低频恢复探测
// 当 push_retry_queue 用尽（exhausted）且首错是 ret:-2 时写入此表
// 数据价值：统计"自然恢复时间分布" + "重扫 vs 自愈 比例"
if (!hasRun(19)) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS neg2_recovery_probe (
        channel_id INTEGER PRIMARY KEY REFERENCES channels(id),
        retry_queue_id INTEGER REFERENCES push_retry_queue(id),
        started_at DATETIME NOT NULL,
        last_probe_at DATETIME,
        probe_count INTEGER DEFAULT 0,
        next_probe_at DATETIME NOT NULL,
        recovered_at DATETIME,
        recovered_by TEXT,
        gave_up_at DATETIME,
        last_probe_code INTEGER
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_neg2_probe_pending ON neg2_recovery_probe(recovered_at, gave_up_at, next_probe_at)');
  } catch (e) {
    console.error('migration 19 error:', e.message);
  }
  markRun(19);
}

// Migration 20: 补发逐条确认 — paused + triggered_by_reply 列
// 用户回复只触发 1 条补发，其余保持 paused；每条补发带"回复 1 获取下一条"
if (!hasRun(20)) {
  try {
    db.exec('ALTER TABLE push_retry_queue ADD COLUMN paused INTEGER DEFAULT 0');
    db.exec('ALTER TABLE push_retry_queue ADD COLUMN triggered_by_reply INTEGER DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_retry_queue_paused ON push_retry_queue(paused, status, next_try_at)');
  } catch (e) {
    console.error('migration 20 error:', e.message);
  }
  markRun(20);
}

// Migration 21: 把已有 pending 项全部暂停（每通道保留最早的 1 条不暂停）
// 这是 migration 20 的后续数据修复，确保迁移跑过后已有项也进入逐条模式
if (!hasRun(21)) {
  try {
    const channels = db.prepare('SELECT DISTINCT channel_id FROM push_retry_queue WHERE status = \'pending\'').all();
    for (const ch of channels) {
      const oldest = db.prepare(
        'SELECT id FROM push_retry_queue WHERE channel_id = ? AND status = \'pending\' ORDER BY next_try_at ASC LIMIT 1'
      ).get(ch.channel_id);
      if (oldest) {
        db.prepare(
          'UPDATE push_retry_queue SET paused = 1 WHERE channel_id = ? AND status = \'pending\' AND id != ?'
        ).run(ch.channel_id, oldest.id);
      }
    }
    console.log(`📋 migration 21: 已为 ${channels.length} 个通道的 pending 项启用逐条模式`);
  } catch (e) {
    console.error('migration 21 error:', e.message);
  }
  markRun(21);
}

// Migration 22: 简化补发逻辑后，把现有 paused=1 的旧 pending 数据标记 abandoned
// 新逻辑下 paused 列默认 0，旧数据躺着不会被任何路径触发，明确标记便于审计
if (!hasRun(22)) {
  try {
    const r = db.prepare(
      "UPDATE push_retry_queue SET status='abandoned', recovered_by='cleanup-simplify-v22' WHERE status='pending' AND paused=1"
    ).run();
    if (r.changes > 0) {
      console.log(`📋 migration 22: 已清理 ${r.changes} 条旧 paused 数据为 abandoned`);
    }
  } catch (e) {
    console.error('migration 22 error:', e.message);
  }
  markRun(22);
}

// Migration 23: channels 加 last_long_tip_at —— 用于按"当天首条"判定是否附长尾巴
if (!hasRun(23)) {
  try {
    db.exec('ALTER TABLE channels ADD COLUMN last_long_tip_at DATETIME');
    console.log('📋 migration 23: channels.last_long_tip_at 已添加');
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) {
      console.error('migration 23 error:', e.message);
    }
  }
  markRun(23);
}

// Migration 24: 一次性清理 retry-queue 所有 pending 残留
// 背景:2026-05-21 发现 processRetries 存在 TOCTOU race condition,导致同一条
// pending record 在 push-queue 限流期间被并发处理多次,用户收到重复补发。
// race fix(retry-queue.js processingLock + inFlight Set)已在前序 commit 部署。
// 本 migration 把 fix 之前累积的所有 pending(包括 paused=0/1)统一标 abandoned,
// 让 scheduler 干净起步,不再追溯历史失败任务。
//
// 影响:用户不会再收到累积的延迟补发("因微信官方通道临时不稳定...")。
// 历史失败消息仍可在网页"推送历史"查询。
if (!hasRun(24)) {
  try {
    const r = db.prepare(
      "UPDATE push_retry_queue SET status='abandoned', recovered_by='race_fix_cleanup_2026-05-21', recovered_at=CURRENT_TIMESTAMP WHERE status='pending'"
    ).run();
    if (r.changes > 0) {
      console.log(`📋 migration 24: 已清理 ${r.changes} 条 pending retry 为 abandoned (race fix 现场止血)`);
    }
  } catch (e) {
    console.error('migration 24 error:', e.message);
  }
  markRun(24);
}

// Migration 25: 一次性禁用所有 stuck every2min reminders
// 背景:2026-05-21 发现 scheduler.checkReminders 的 send_count 递增逻辑只在
// success 路径生效,导致 ret:-2 失败时 every2min reminder 永远 send_count=0,
// 无限轰炸用户(user 45 喝水提醒 12 天每 2 分钟一发)。代码已修(递增提前),
// 本 migration 清理存量。
//
// 安全规则: 只清"明显 stuck"的—— every2min 类型本设计是分钟级测试(max=5,
// 10 分钟跑完),创建超过 1 天还 enabled 的肯定是失败堆积导致的死循环。
if (!hasRun(25)) {
  try {
    const r = db.prepare(`
      UPDATE reminders SET enabled = 0
      WHERE type = 'every2min' AND enabled = 1 AND created_at < datetime('now', '-1 day')
    `).run();
    if (r.changes > 0) {
      console.log(`📋 migration 25: 禁用 ${r.changes} 条 stuck every2min reminders (失败堆积止血)`);
    }
  } catch (e) {
    console.error('migration 25 error:', e.message);
  }
  markRun(25);
}

// Migration 26: channels 加 disconnected_at —— X4 设计的失联状态机
// 语义: NULL = 通道正常; 非空 = 通道处于失联状态从该时间起
//   - retry-queue 补发失败时设置 disconnected_at = NOW
//   - handlePush 看到非空 → 直接拒绝 push,不入队不尝试(fail-fast)
//   - 用户在微信回复 / 重扫 → 清零 disconnected_at,通道恢复
if (!hasRun(26)) {
  try {
    db.exec('ALTER TABLE channels ADD COLUMN disconnected_at DATETIME');
    console.log('📋 migration 26: channels.disconnected_at 已添加(X4 失联状态机)');
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) {
      console.error('migration 26 error:', e.message);
    }
  }
  markRun(26);
}

// Migration 27: 一次性清理 retry-queue pending 积压,每 channel 只留最新 1 条
// 背景:2026-05-21 enqueueRetry 缺去重 + cleanupStalePaused 因 last_try_at=NULL
// 失效,导致几十个用户堆出 2331 条 pending。代码已修(enqueueRetry 入新前 abandon
// 旧 pending + cleanup 改 COALESCE)。本 migration 清存量:每 channel 留最新 1 条,
// 其余 abandon。
if (!hasRun(27)) {
  try {
    const r = db.prepare(`
      UPDATE push_retry_queue
      SET status = 'abandoned', recovered_by = 'dedup_cleanup_v27'
      WHERE status = 'pending' AND id NOT IN (
        SELECT MAX(id) FROM push_retry_queue WHERE status = 'pending' GROUP BY channel_id
      )
    `).run();
    if (r.changes > 0) {
      console.log(`📋 migration 27: 清理 ${r.changes} 条重复 pending,每通道只留最新 1 条`);
    }
  } catch (e) {
    console.error('migration 27 error:', e.message);
  }
  markRun(27);
}

// Migration 28: 存量持续失败的 channel 立即标 disconnected(X5 fail-fast 止血)
// 背景:X4 的 disconnected 只在"用户回复后补发也失败"时触发,但绝大多数失联用户
// 从不回复 → 永远不进 disconnected → 每条推送都真打 iLink 白白失败(channel 75
// consecutive_neg2_count 累积到 462)。X5 改为第一次 ret:-2 失败就 disconnect,
// 本 migration 把存量"连续失败 >= 3 且仍 active"的 channel 一次性标失联。
// (consecutive_neg2_count 在用户回复时清零,所以 count 高 = 确实当前持续失败中)
if (!hasRun(28)) {
  try {
    const r = db.prepare(`
      UPDATE channels SET disconnected_at = CURRENT_TIMESTAMP
      WHERE disconnected_at IS NULL
        AND status = 'active'
        AND COALESCE(consecutive_neg2_count, 0) >= 3
    `).run();
    if (r.changes > 0) {
      console.log(`📋 migration 28: ${r.changes} 个持续失败 channel 标 disconnected(X5 fail-fast)`);
    }
  } catch (e) {
    console.error('migration 28 error:', e.message);
  }
  markRun(28);
}

// ── Helpers ──────────────────────────────────────────────────────────

function generateSendKey() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = db;
module.exports.generateSendKey = generateSendKey;
