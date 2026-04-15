const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../middleware/requireAdmin');
const { logActivity } = require('../services/logger');

// All admin routes require admin role
router.use(requireAdmin);

// ═══════════════════════════════════════════════════════════════════
//  GET /api/admin/users — 用户列表（含通道数、推送数统计）
// ═══════════════════════════════════════════════════════════════════

router.get('/users', (req, res) => {
  try {
    const users = db.prepare(`
      SELECT
        u.id,
        u.email,
        u.wechat_openid,
        u.send_key,
        u.nickname,
        u.role,
        u.is_disabled,
        u.rate_limit,
        u.created_at,
        (SELECT COUNT(*) FROM channels c WHERE c.user_id = u.id) AS channel_count,
        (SELECT COUNT(*) FROM push_logs p WHERE p.user_id = u.id) AS push_count
      FROM users u
      ORDER BY u.created_at DESC
    `).all();

    res.json({ success: true, data: users });
  } catch (err) {
    console.error('Admin list users error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  PATCH /api/admin/users/:id — 修改用户（禁用/改限额/改角色）
// ═══════════════════════════════════════════════════════════════════

router.patch('/users/:id', (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.json({ success: false, error: 'Invalid user ID' });
    }

    // Admin cannot modify themselves
    if (targetId === req.session.userId) {
      return res.json({ success: false, error: '不能修改自己的账户' });
    }

    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!target) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const { role, is_disabled, rate_limit, nickname } = req.body;
    const updates = [];
    const params = [];

    // Whitelist validation for role
    if (role !== undefined) {
      if (!['user', 'admin'].includes(role)) {
        return res.json({ success: false, error: 'role 只能是 user 或 admin' });
      }
      updates.push('role = ?');
      params.push(role);
    }

    // Validate is_disabled
    if (is_disabled !== undefined) {
      const val = Number(is_disabled);
      if (![0, 1].includes(val)) {
        return res.json({ success: false, error: 'is_disabled 只能是 0 或 1' });
      }
      updates.push('is_disabled = ?');
      params.push(val);
    }

    // Validate rate_limit
    if (rate_limit !== undefined) {
      const val = Number(rate_limit);
      if (!Number.isInteger(val) || val < 0 || val > 100000) {
        return res.json({ success: false, error: 'rate_limit 必须是 0-100000 的整数' });
      }
      updates.push('rate_limit = ?');
      params.push(val);
    }

    // Validate nickname
    if (nickname !== undefined) {
      const val = String(nickname).trim().substring(0, 20) || null;
      updates.push('nickname = ?');
      params.push(val);
    }

    if (updates.length === 0) {
      return res.json({ success: false, error: '没有可更新的字段' });
    }

    params.push(targetId);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    logActivity(req.session.userId, 'admin_update_user', { targetId, changes: req.body }, req);

    const updated = db.prepare('SELECT id, email, role, is_disabled, rate_limit FROM users WHERE id = ?').get(targetId);
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('Admin update user error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  DELETE /api/admin/users/:id — 删除用户
// ═══════════════════════════════════════════════════════════════════

router.delete('/users/:id', (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.json({ success: false, error: 'Invalid user ID' });
    }

    // Admin cannot delete themselves
    if (targetId === req.session.userId) {
      return res.json({ success: false, error: '不能删除自己的账户' });
    }

    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!target) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Delete related data in a transaction
    const deleteUser = db.transaction(() => {
      db.prepare('DELETE FROM push_logs WHERE user_id = ?').run(targetId);
      db.prepare('DELETE FROM channels WHERE user_id = ?').run(targetId);
      db.prepare('DELETE FROM reminders WHERE user_id = ?').run(targetId);
      db.prepare('DELETE FROM logs WHERE user_id = ?').run(targetId);
      db.prepare('DELETE FROM activity_logs WHERE user_id = ?').run(targetId);
      db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
    });

    deleteUser();

    logActivity(req.session.userId, 'admin_delete_user', { targetId }, req);

    res.json({ success: true, data: { deleted: targetId } });
  } catch (err) {
    console.error('Admin delete user error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/admin/stats — 仪表盘统计
// ═══════════════════════════════════════════════════════════════════

router.get('/stats', (req, res) => {
  try {
    const totalUsers = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
    const todayPushes = db.prepare(
      "SELECT COUNT(*) AS cnt FROM push_logs WHERE datetime(created_at, '+8 hours') >= date('now', '+8 hours')"
    ).get().cnt;
    const activeChannels = db.prepare(
      "SELECT COUNT(*) AS cnt FROM channels WHERE status = 'active'"
    ).get().cnt;
    const disabledUsers = db.prepare(
      'SELECT COUNT(*) AS cnt FROM users WHERE is_disabled = 1'
    ).get().cnt;
    const adminCount = db.prepare(
      "SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin'"
    ).get().cnt;
    const todayNewUsers = db.prepare(
      "SELECT COUNT(*) AS cnt FROM users WHERE datetime(created_at, '+8 hours') >= date('now', '+8 hours')"
    ).get().cnt;
    const adminUnreadFailed = db.prepare(
      "SELECT COUNT(*) AS cnt FROM push_logs WHERE status = 'failed' AND (read_state & 2) = 0"
    ).get().cnt;

    res.json({
      success: true,
      data: {
        total_users: totalUsers,
        today_pushes: todayPushes,
        active_channels: activeChannels,
        disabled_users: disabledUsers,
        admin_count: adminCount,
        today_new_users: todayNewUsers,
        admin_unread_failed: adminUnreadFailed,
      },
    });
  } catch (err) {
    console.error('Admin stats error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/admin/channels — 通道健康状态
// ═══════════════════════════════════════════════════════════════════

router.get('/channels', (req, res) => {
  try {
    const { getChannelHealth } = require('../services/channel-health');
    const channels = db.prepare(`
      SELECT c.id, c.name, c.status, c.bot_token, c.wechat_openid, c.is_default, c.created_at,
             c.bot_token_updated_at, c.last_send_success_at, c.consecutive_neg2_count, c.last_neg2_at,
             c.send_disabled, c.send_disabled_reason, c.send_disabled_at,
             c.last_inbound_at,
             ie.max_created AS inbound_events_max,
             u.id AS user_id, u.nickname, u.role
      FROM channels c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN (
        SELECT channel_id, MAX(received_at) AS max_created
        FROM inbound_events
        WHERE channel_id IS NOT NULL
        GROUP BY channel_id
      ) ie ON ie.channel_id = c.id
      ORDER BY c.id
    `).all();

    const data = channels.map(ch => {
      // 取 channels.last_inbound_at 与 inbound_events 最大值的较大者，防止 poller
      // 漏写（无 context_token 的 msg、重启 cursor 重置）导致统计偏旧。
      const a = ch.last_inbound_at;
      const b = ch.inbound_events_max;
      const effectiveInbound = a && b ? (a > b ? a : b) : (a || b || null);
      ch.last_inbound_at = effectiveInbound;
      const h = getChannelHealth(ch);
      return {
        id: ch.id,
        name: ch.name,
        user_id: ch.user_id,
        nickname: ch.nickname || ch.wechat_openid?.slice(-6) || `User#${ch.user_id}`,
        role: ch.role,
        status: ch.status,
        is_default: ch.is_default,
        health: h.health,           // 'green' | 'yellow' | 'red'
        reason: h.reason,
        details: h.details,
        bot_token_updated_at: ch.bot_token_updated_at,
        last_send_success_at: ch.last_send_success_at,
        last_inbound_at: ch.last_inbound_at,
        consecutive_neg2_count: ch.consecutive_neg2_count,
        last_neg2_at: ch.last_neg2_at,
      };
    });

    const stats = {
      green: data.filter(d => d.health === 'green').length,
      yellow: data.filter(d => d.health === 'yellow').length,
      red: data.filter(d => d.health === 'red').length,
      disconnected: data.filter(d => d.health === 'red').length, // 兼容旧字段
    };

    res.json({ success: true, data: { channels: data, ...stats } });
  } catch (err) {
    console.error('Admin channels error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/admin/page-views — 页面访问统计
// ═══════════════════════════════════════════════════════════════════

router.get('/page-views', (req, res) => {
  try {
    const { period, page } = req.query;

    // Build date filter（全部按北京时区 UTC+8）
    let dateFilter = '';
    if (period === 'today') {
      dateFilter = "AND datetime(created_at, '+8 hours') >= date('now', '+8 hours')";
    } else if (period === '7d') {
      dateFilter = "AND datetime(created_at, '+8 hours') >= date('now', '+8 hours', '-7 days')";
    } else if (period === '30d') {
      dateFilter = "AND datetime(created_at, '+8 hours') >= date('now', '+8 hours', '-30 days')";
    }
    // 'all' or undefined = no date filter

    let pageFilter = '';
    const params = [];
    if (page) {
      pageFilter = 'AND page = ?';
      params.push(page);
    }

    // 排除 admin 用户的访问（他们刷后台不算真实流量）
    const excludeAdmin = `AND (user_id IS NULL OR user_id NOT IN (SELECT id FROM users WHERE role = 'admin'))`;
    const excludeAdminPv = `AND (pv.user_id IS NULL OR pv.user_id NOT IN (SELECT id FROM users WHERE role = 'admin'))`;

    const where = `WHERE 1=1 ${dateFilter} ${pageFilter} ${excludeAdmin}`;

    // Summary
    const total = db.prepare(
      `SELECT COUNT(*) AS cnt FROM page_views ${where}`
    ).get(...params).cnt;

    const today = db.prepare(
      `SELECT COUNT(*) AS cnt FROM page_views WHERE datetime(created_at, '+8 hours') >= date('now', '+8 hours') ${pageFilter} ${excludeAdmin}`
    ).get(...params).cnt;

    const uniqueIps = db.prepare(
      `SELECT COUNT(DISTINCT ip) AS cnt FROM page_views ${where}`
    ).get(...params).cnt;

    // By page
    const byPage = db.prepare(
      `SELECT page, COUNT(*) AS count, COUNT(DISTINCT ip) AS unique_ips
       FROM page_views ${where}
       GROUP BY page ORDER BY count DESC`
    ).all(...params);

    // By day (last 30 days, 按北京时间分组)
    const byDay = db.prepare(
      `SELECT date(created_at, '+8 hours') AS date, COUNT(*) AS count
       FROM page_views
       WHERE datetime(created_at, '+8 hours') >= date('now', '+8 hours', '-30 days') ${pageFilter} ${excludeAdmin}
       GROUP BY date(created_at, '+8 hours') ORDER BY date ASC`
    ).all(...params);

    // Recent 50 records
    const recentWhere = `WHERE 1=1 ${dateFilter.replace(/created_at/g, 'pv.created_at')} ${pageFilter.replace(/page =/g, 'pv.page =')} ${excludeAdminPv}`;
    const recent = db.prepare(
      `SELECT pv.page, pv.tab, pv.ip, pv.user_agent, pv.country, pv.created_at,
              u.nickname
       FROM page_views pv
       LEFT JOIN users u ON pv.user_id = u.id
       ${recentWhere}
       ORDER BY pv.id DESC LIMIT 50`
    ).all(...params);

    // Mask IP: replace last segment with *
    function maskIp(ip) {
      if (!ip) return '-';
      // IPv4
      if (ip.includes('.')) {
        const parts = ip.split('.');
        if (parts.length === 4) {
          parts[3] = '*';
          return parts.join('.');
        }
      }
      // IPv6 or other: mask last 4 chars
      if (ip.length > 4) {
        return ip.substring(0, ip.length - 4) + '****';
      }
      return '****';
    }

    res.json({
      success: true,
      data: {
        summary: { total, today, unique_ips: uniqueIps },
        by_page: byPage,
        by_day: byDay,
        recent: recent
      }
    });
  } catch (err) {
    console.error('Admin page-views error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/admin/push-logs — 全部推送日志
// ═══════════════════════════════════════════════════════════════════

router.get('/push-logs', (req, res) => {
  try {
    const logs = db.prepare(`
      SELECT p.id, p.title, p.content, p.status, p.ip, p.response, p.created_at, p.read_state,
             u.nickname, u.wechat_openid, u.id as user_id
      FROM push_logs p
      LEFT JOIN users u ON p.user_id = u.id
      ORDER BY p.id DESC LIMIT 200
    `).all();

    res.json({ success: true, data: logs });
  } catch (err) {
    console.error('Admin push-logs error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// PATCH /api/admin/push-logs/:id/read — admin 标记单条已读（bit 2）
router.patch('/push-logs/:id/read', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }
    const info = db.prepare('UPDATE push_logs SET read_state = read_state | 2 WHERE id = ?').run(id);
    res.json({ success: true, data: { updated: info.changes } });
  } catch (err) {
    console.error('Admin mark read error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// POST /api/admin/push-logs/mark-all-read — admin 批量标记所有失败已读
router.post('/push-logs/mark-all-read', (req, res) => {
  try {
    const info = db.prepare(`
      UPDATE push_logs SET read_state = read_state | 2
      WHERE status = 'failed' AND (read_state & 2) = 0
    `).run();
    res.json({ success: true, data: { updated: info.changes } });
  } catch (err) {
    console.error('Admin mark all read error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/admin/retry-queue — 延时重试队列状态
// ═══════════════════════════════════════════════════════════════════

router.get('/retry-queue', (req, res) => {
  try {
    const { getStats } = require('../services/retry-queue');
    const stats = getStats();

    const recent = db.prepare(`
      SELECT r.id, r.user_id, r.channel_id, r.title, r.source,
             r.first_failed_at, r.first_error_code,
             r.attempts, r.max_attempts, r.next_try_at, r.last_try_at,
             r.status, r.recovered_by, r.recovered_at,
             r.final_attempt_count, r.failure_history,
             u.nickname
      FROM push_retry_queue r
      LEFT JOIN users u ON r.user_id = u.id
      ORDER BY r.id DESC LIMIT 100
    `).all();

    // 分析：按 recovered_by 统计成功率
    const analytics = db.prepare(`
      SELECT recovered_by, final_attempt_count, COUNT(*) AS cnt
      FROM push_retry_queue
      WHERE status IN ('success','exhausted','abandoned')
      GROUP BY recovered_by, final_attempt_count
      ORDER BY cnt DESC
    `).all();

    res.json({ success: true, data: { stats, recent, analytics } });
  } catch (err) {
    console.error('Admin retry-queue error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/admin/neg2-probe — ret:-2 长期探测状态
// ═══════════════════════════════════════════════════════════════════

router.get('/neg2-probe', (req, res) => {
  try {
    const { getStats } = require('../services/neg2-probe');
    const stats = getStats();
    const recent = db.prepare(`
      SELECT p.*, c.user_id, u.nickname
      FROM neg2_recovery_probe p
      LEFT JOIN channels c ON c.id = p.channel_id
      LEFT JOIN users u ON c.user_id = u.id
      ORDER BY p.started_at DESC LIMIT 100
    `).all();
    res.json({ success: true, data: { stats, recent } });
  } catch (err) {
    console.error('Admin neg2-probe error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /api/admin/channels/:id/test-send — 手动给通道发一条测试消息
// ═══════════════════════════════════════════════════════════════════

router.post('/channels/:id/test-send', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }
    const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
    if (!ch) return res.status(404).json({ success: false, error: '通道不存在' });
    if (!ch.context_token) return res.json({ success: false, error: '通道未激活（无 context_token）' });

    const ilink = require('../ilink');
    const { enqueueSend } = require('../services/push-queue');
    const { markSendResult } = require('../services/channel-health');

    const msg = '🧪 通道连通性测试，请回复"1"';

    try {
      const r = await enqueueSend(id,
        () => ilink.sendMessage(ch.bot_token, ch.wechat_openid, msg, ch.context_token),
        { title: '🧪 管理员测试', source: 'admin-test' });
      markSendResult(id, r, true);
      db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'success', 'admin-test', ?, ?)")
        .run(ch.user_id, '🧪 管理员测试', msg, id, JSON.stringify(r));
      res.json({ success: true, data: { sent: true, response: r } });
    } catch (err) {
      markSendResult(id, err, false);
      const errData = err.response?.data;
      db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'failed', 'admin-test', ?, ?)")
        .run(ch.user_id, '🧪 管理员测试', msg, id, JSON.stringify(errData || { error: err.message }));
      res.json({ success: false, error: errData ? JSON.stringify(errData) : err.message });
    }
  } catch (err) {
    console.error('Admin test-send error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /api/admin/channels/:id/inbounds — 通道最近用户回复
// ═══════════════════════════════════════════════════════════════════

router.get('/channels/:id/inbounds', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }
    const events = db.prepare(`
      SELECT id, message_type, has_text, text_preview, context_token_prefix, received_at
      FROM inbound_events
      WHERE channel_id = ?
      ORDER BY id DESC LIMIT 50
    `).all(id);
    const total = db.prepare('SELECT COUNT(*) AS cnt FROM inbound_events WHERE channel_id = ?').get(id).cnt;
    res.json({ success: true, data: { total, events } });
  } catch (err) {
    console.error('Admin channel inbounds error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

module.exports = router;
