const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateSendKey } = require('../db');
const ilink = require('../ilink');
const { requireLogin } = require('../middleware/auth');
const { logActivity } = require('../services/logger');
const { startMessagePoller, getContextToken } = require('../services/message-poller');

// 通知所有 admin 用户
function notifyAdmins(message) {
  try {
    const admins = db.prepare(
      "SELECT u.id, c.bot_token, c.wechat_openid, c.context_token FROM users u JOIN channels c ON c.user_id = u.id AND c.is_default = 1 AND c.status = 'active' WHERE u.role = 'admin'"
    ).all();
    for (const admin of admins) {
      if (admin.context_token) {
        ilink.sendMessage(admin.bot_token, admin.wechat_openid, message, admin.context_token)
          .catch(err => console.error('通知 admin 失败:', err.message));
      }
    }
  } catch (e) {
    console.error('notifyAdmins 错误:', e.message);
  }
}

// Temporary map: qrcode -> { userId, sessionId } (for binding flow)
const pendingBindings = new Map();

// ═══════════════════════════════════════════════════════════════════
//  公开路由（无需登录）— 扫码即注册
// ═══════════════════════════════════════════════════════════════════

// POST /qrcode-public — 生成 QR 码（无需登录）
router.post('/qrcode-public', async (req, res) => {
  try {
    // 强制保存 session（saveUninitialized: false 时未登录用户 session 不会自动保存）
    req.session._qrPublic = true;
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));

    const data = await ilink.getQRCode();
    if (data.qrcode) {
      pendingBindings.set(data.qrcode, { userId: null, sessionId: req.sessionID });
    }
    res.json({ success: true, data });
  } catch (err) {
    console.error('Public QR code error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Failed to get QR code' } });
  }
});

// GET /bind-status-public/:qrcode — 轮询扫码状态（无需登录，自动创建用户）
router.get('/bind-status-public/:qrcode', async (req, res) => {
  try {
    const pending = pendingBindings.get(req.params.qrcode);
    if (!pending) {
      return res.json({ success: true, data: { status: 'expired' } });
    }
    // 校验 session 防劫持
    if (pending.sessionId && pending.sessionId !== req.sessionID) {
      return res.status(403).json({ success: false, data: { error: 'Session mismatch' } });
    }

    const result = await ilink.checkQRStatus(req.params.qrcode);

    // 还没扫码
    if (!result.bot_token) {
      return res.json({ success: true, data: result });
    }

    const ilinkUserId = result.ilink_user_id || result.user_id;
    const botToken = result.bot_token;

    // 检查该微信是否已有账户
    const existingChannel = db.prepare(
      "SELECT c.*, u.send_key FROM channels c JOIN users u ON c.user_id = u.id WHERE c.wechat_openid = ? AND c.status != 'inactive' LIMIT 1"
    ).get(ilinkUserId);

    if (existingChannel) {
      // ── 已有用户：重新绑定 + 自动登录 ──
      const userId = existingChannel.user_id;

      db.prepare(
        "UPDATE channels SET bot_token = ?, context_token = NULL, status = 'pending' WHERE id = ?"
      ).run(botToken, existingChannel.id);

      startMessagePoller(botToken, ilinkUserId, (contextToken) => {
        db.prepare("UPDATE channels SET context_token = ?, status = 'active' WHERE id = ?")
          .run(contextToken, existingChannel.id);
        ilink.sendMessage(botToken, ilinkUserId,
          '欢迎回来！\n\n你的 BotTalk 通道已重新激活。',
          contextToken
        ).catch(err => console.error('发送重绑通知失败:', err.message));
      });

      req.session.userId = userId;
      pendingBindings.delete(req.params.qrcode);
      logActivity(userId, 'qr_login', { channel_id: existingChannel.id }, req);
      const reloginUser = db.prepare('SELECT nickname FROM users WHERE id = ?').get(userId);
      const reloginName = reloginUser?.nickname ? `${reloginUser.nickname} (${ilinkUserId})` : ilinkUserId;
      notifyAdmins(`📢 用户重新登录\n\n用户: ${reloginName}\n用户ID: ${userId}\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);


      return res.json({
        success: true,
        data: {
          id: existingChannel.id,
          send_key: existingChannel.send_key,
          status: 'pending',
          wechat_openid: ilinkUserId,
          is_new: false,
        },
      });
    }

    // ── 全新用户：创建用户 + 创建通道 ──
    const sendKey = generateSendKey();
    const now = new Date();
    const defaultNickname = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0') + '-' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
    const userInfo = db.prepare(
      'INSERT INTO users (send_key, wechat_openid, nickname) VALUES (?, ?, ?)'
    ).run(sendKey, ilinkUserId, defaultNickname);
    const userId = userInfo.lastInsertRowid;

    const channelInfo = db.prepare(
      `INSERT INTO channels (user_id, name, channel_type, wechat_openid, bot_token, status, is_default)
       VALUES (?, '默认通道', 'wechat_ilink', ?, ?, 'pending', 1)`
    ).run(userId, ilinkUserId, botToken);
    const channelId = channelInfo.lastInsertRowid;

    startMessagePoller(botToken, ilinkUserId, (contextToken) => {
      db.prepare("UPDATE channels SET context_token = ?, status = 'active' WHERE id = ?")
        .run(contextToken, channelId);
      ilink.sendMessage(botToken, ilinkUserId,
        `🎉 欢迎使用 BotTalk！\n\n你的推送通道已激活。\n访问 ${process.env.BASE_URL || 'https://bot-talk.com'} 查看你的 SendKey 和 API 文档。\n\n💡 由于微信 ClawBot 同一微信号只保持一个活跃通道，绑定新应用会自动失效之前的连接。如果消息未收到，重新扫码即可恢复。`,
        contextToken
      ).catch(err => console.error('发送欢迎消息失败:', err.message));
    });

    req.session.userId = userId;
    pendingBindings.delete(req.params.qrcode);
    logActivity(userId, 'qr_register', { channel_id: channelId }, req);
      notifyAdmins(`📢 新用户注册\n\n昵称: ${defaultNickname}\nOpenID: ${ilinkUserId}\n用户ID: ${userId}\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);


    return res.json({
      success: true,
      data: {
        id: channelId,
        send_key: sendKey,
        status: 'pending',
        wechat_openid: ilinkUserId,
        is_new: true,
      },
    });
  } catch (err) {
    console.error('Public bind status error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Failed to check bind status' } });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  以下路由需要登录
// ═══════════════════════════════════════════════════════════════════
router.use(requireLogin);

// Helper: verify channel belongs to current user
function getOwnedChannel(channelId, userId) {
  return db.prepare('SELECT * FROM channels WHERE id = ? AND user_id = ?').get(channelId, userId);
}

// GET / — list all channels for current user
router.get('/', (req, res) => {
  try {
    const channels = db.prepare(
      "SELECT * FROM channels WHERE user_id = ? AND status != 'inactive' ORDER BY created_at DESC"
    ).all(req.session.userId);

    res.json({ success: true, data: channels });
  } catch (err) {
    console.error('List channels error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Internal error' } });
  }
});

// POST /qrcode — get QR code for adding a new channel (max 10)
router.post('/qrcode', async (req, res) => {
  try {
    const count = db.prepare(
      "SELECT COUNT(*) AS cnt FROM channels WHERE user_id = ? AND status != 'inactive'"
    ).get(req.session.userId).cnt;

    if (count >= 10) {
      return res.status(400).json({ success: false, data: { error: 'Maximum 10 channels allowed' } });
    }

    const data = await ilink.getQRCode();

    // Store mapping so bind-status knows which user initiated this
    if (data.qrcode) {
      pendingBindings.set(data.qrcode, { userId: req.session.userId, sessionId: req.sessionID });
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error('Channel QR code error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Failed to get QR code' } });
  }
});

// GET /bind-status/:qrcode — poll channel-binding QR status
router.get('/bind-status/:qrcode', async (req, res) => {
  try {
    const result = await ilink.checkQRStatus(req.params.qrcode);

    if (!result.bot_token) {
      return res.json({ success: true, data: result });
    }

    const ilinkUserId = result.ilink_user_id || result.user_id;
    const botToken = result.bot_token;
    const userId = req.session.userId;

    // 检查该微信是否已被绑定
    const existingChannel = db.prepare(
      "SELECT c.*, u.wechat_openid as owner_openid FROM channels c JOIN users u ON c.user_id = u.id WHERE c.wechat_openid = ? AND c.status != 'inactive'"
    ).get(ilinkUserId);

    if (existingChannel) {
      if (existingChannel.user_id === userId) {
        // 同一用户重新绑定 — 更新 bot_token，重置激活状态
        db.prepare(
          "UPDATE channels SET bot_token = ?, context_token = NULL, status = 'pending' WHERE id = ?"
        ).run(botToken, existingChannel.id);

        // 重启 poller
        startMessagePoller(botToken, ilinkUserId, (contextToken) => {
          db.prepare("UPDATE channels SET context_token = ?, status = 'active' WHERE id = ?")
            .run(contextToken, existingChannel.id);
          ilink.sendMessage(botToken, ilinkUserId,
            '通道重新绑定成功！\n\n该通道已激活，可以正常接收消息推送了。',
            contextToken
          ).catch(err => console.error('发送重绑通知失败:', err.message));
        });

        pendingBindings.delete(req.params.qrcode);
        logActivity(userId, 'channel_rebind', { channel_id: existingChannel.id }, req);

        return res.json({
          success: true,
          data: {
            id: existingChannel.id,
            name: existingChannel.name,
            status: 'pending',
            wechat_openid: ilinkUserId,
            is_default: existingChannel.is_default,
            rebind: true,
          },
        });
      } else {
        // 该微信已被其他用户绑定
        pendingBindings.delete(req.params.qrcode);
        return res.json({
          success: false,
          data: { error: 'wechat_already_bound', message: '该微信已被其他账户绑定' },
        });
      }
    }

    // 全新微信 — 创建新 channel
    const existingCount = db.prepare(
      'SELECT COUNT(*) AS cnt FROM channels WHERE user_id = ?'
    ).get(userId).cnt;
    const channelName = `Channel ${existingCount + 1}`;
    const hasActiveDefault = db.prepare(
      "SELECT COUNT(*) AS cnt FROM channels WHERE user_id = ? AND is_default = 1 AND status = 'active'"
    ).get(userId).cnt > 0;
    const isFirst = hasActiveDefault ? 0 : 1;
    if (isFirst) {
      db.prepare('UPDATE channels SET is_default = 0 WHERE user_id = ?').run(userId);
    }

    const info = db.prepare(
      `INSERT INTO channels (user_id, name, channel_type, wechat_openid, bot_token, status, is_default)
       VALUES (?, ?, 'wechat_ilink', ?, ?, 'pending', ?)`
    ).run(userId, channelName, ilinkUserId, botToken, isFirst);

    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(info.lastInsertRowid);

    // Start message poller for the new channel
    startMessagePoller(botToken, ilinkUserId, (contextToken) => {
      db.prepare(
        "UPDATE channels SET context_token = ?, status = 'active' WHERE id = ?"
      ).run(contextToken, channel.id);
      ilink.sendMessage(botToken, ilinkUserId,
        '通道绑定成功！\n\n该通道已激活，可以正常接收消息推送了。',
        contextToken
      ).catch(err => console.error('发送绑定通知失败:', err.message));
    });

    pendingBindings.delete(req.params.qrcode);
    logActivity(userId, 'channel_add', { channel_id: channel.id, name: channelName }, req);

    res.json({
      success: true,
      data: {
        id: channel.id,
        name: channel.name,
        status: channel.status,
        wechat_openid: channel.wechat_openid,
        is_default: channel.is_default,
      },
    });
  } catch (err) {
    console.error('Bind status error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Failed to check bind status' } });
  }
});

// GET /:id/activation — check if channel has been activated
router.get('/:id/activation', (req, res) => {
  try {
    const channel = getOwnedChannel(req.params.id, req.session.userId);
    if (!channel) {
      return res.status(404).json({ success: false, data: { error: 'Channel not found' } });
    }

    let activated = false;

    if (channel.context_token && channel.status === 'pending') {
      db.prepare("UPDATE channels SET status = 'active' WHERE id = ?").run(channel.id);
      activated = true;
      logActivity(req.session.userId, 'channel_activate', { channel_id: channel.id }, req);
    } else if (channel.status === 'active') {
      activated = true;
    }

    res.json({ success: true, data: { activated } });
  } catch (err) {
    console.error('Activation check error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Internal error' } });
  }
});

// PATCH /:id — update channel name and/or is_default
router.patch('/:id', (req, res) => {
  try {
    const channel = getOwnedChannel(req.params.id, req.session.userId);
    if (!channel) {
      return res.status(404).json({ success: false, data: { error: 'Channel not found' } });
    }

    const { name, is_default } = req.body;

    if (is_default === 1) {
      // Clear is_default on all other channels for this user
      db.prepare('UPDATE channels SET is_default = 0 WHERE user_id = ?').run(req.session.userId);
    }

    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name);
    }
    if (is_default !== undefined) {
      updates.push('is_default = ?');
      params.push(is_default);
    }

    if (updates.length > 0) {
      params.push(channel.id);
      db.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(channel.id);
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('Update channel error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Internal error' } });
  }
});

// POST /:id/check — 检测通道是否存活（通过 poller 心跳，不调 iLink API）
router.post('/:id/check', (req, res) => {
  try {
    const channel = getOwnedChannel(req.params.id, req.session.userId);
    if (!channel) {
      return res.status(404).json({ success: false, data: { error: 'Channel not found' } });
    }

    const { isChannelAlive } = require('../services/message-poller');
    const result = isChannelAlive(channel.bot_token);

    if (!result.alive && channel.status === 'active') {
      db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channel.id);
    }

    res.json({
      success: true,
      data: {
        alive: result.alive,
        reason: result.reason || null,
        last_ok_seconds_ago: result.last_ok_seconds_ago,
        status: result.alive ? 'active' : 'inactive',
      },
    });
  } catch (err) {
    console.error('Check channel error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Internal error' } });
  }
});

// DELETE /:id — soft-delete channel (set status to inactive)
router.delete('/:id', (req, res) => {
  try {
    const channel = getOwnedChannel(req.params.id, req.session.userId);
    if (!channel) {
      return res.status(404).json({ success: false, data: { error: 'Channel not found' } });
    }

    db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channel.id);

    logActivity(req.session.userId, 'channel_delete', { channel_id: channel.id, name: channel.name }, req);

    res.json({ success: true, data: { message: 'Channel deleted' } });
  } catch (err) {
    console.error('Delete channel error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Internal error' } });
  }
});

module.exports = router;
