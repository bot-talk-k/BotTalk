const express = require('express');
const router = express.Router();
const db = require('../db');
const { markSendResult } = require('../services/channel-health');
const { enqueueSend } = require('../services/push-queue');
const { appendTip } = require('../services/keepalive-tip');
const { markRecoveredByRescan } = require('../services/retry-queue');
const { markRecoveredByRescan: probeMarkRescan } = require('../services/neg2-probe');
const { reviveChannel } = require('../services/channel-health');
const { generateSendKey } = require('../db');
const ilink = require('../ilink');
const { requireLogin } = require('../middleware/auth');
const { logActivity } = require('../services/logger');
const { startMessagePoller, getContextToken } = require('../services/message-poller');

// 通道恢复后补发失效期间失败的消息
async function resendFailedMessages(userId, channelId, botToken, wechatOpenid, contextToken) {
  try {
    // 取最新的 20 条失败消息（不限时间，用户可能隔几天才来重绑）
    // 补发成功后会直接删除原记录，避免下次再次补发
    const failed = db.prepare(`
      SELECT id, title, content, created_at FROM push_logs
      WHERE id IN (
        SELECT id FROM push_logs
        WHERE user_id = ?
          AND status = 'failed'
          AND ip NOT IN ('system', 'system-announce', 'system-warning', 'session-warning', 'alert', 'announce-redo', 'system-backfill', 'system-announce-retry', 'system-announce-retry2', 'health-check', 'resend', 'system-apology', 'resend-notice', 'resend-recovery')
        ORDER BY id DESC
        LIMIT 20
      )
      ORDER BY id ASC
    `).all(userId);

    if (failed.length === 0) return;

    console.log(`📬 开始补发 user=${userId} 的 ${failed.length} 条失败消息`);

    // 先发一个头部消息告知用户
    const header = `📬 通道已恢复\n\n检测到失效期间有 ${failed.length} 条消息未能送达，将依次补发给你。`;
    try {
      const r = await enqueueSend(channelId,
        () => ilink.sendMessage(botToken, wechatOpenid, header, contextToken),
        { title: '📬 通道恢复', source: 'resend-notice' });
      db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'success', ?, ?, ?)")
        .run(userId, '📬 通道恢复通知', header, 'resend-notice', channelId, JSON.stringify({ count: failed.length }));
      markSendResult(channelId, r, true);
    } catch (e) {
      console.error('补发头部消息失败:', e.message);
      markSendResult(channelId, e, false);
      return; // 头部都发不出去就别硬补发了
    }

    // 查通道完整记录用于 appendTip
    const chRow = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    let okCount = 0;
    for (const log of failed) {
      // 补发时明确标注原定推送时间（北京时间），让用户知道这条消息本该什么时候收到
      const origTime = log.created_at
        ? new Date(log.created_at + 'Z').toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
        : '未知时间';
      const prefix = `⏰ 原本应于 ${origTime} 推送（通道失联期间未送达，现补发）\n\n`;
      const baseMsg = prefix + (log.title || '') + (log.content ? '\n\n' + log.content : '');
      const msg = appendTip(baseMsg, chRow);
      try {
        const r = await enqueueSend(channelId,
          () => ilink.sendMessage(botToken, wechatOpenid, msg, contextToken),
          { title: log.title + ' [补发]', source: 'resend-recovery' });
        db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'success', ?, ?, ?)")
          .run(userId, (log.title || '') + ' [补发]', log.content, 'resend-recovery', channelId, JSON.stringify({ ...r, original_log_id: log.id }));
        // 补发成功，删除原失败记录，防止下次重绑重复补发
        db.prepare("DELETE FROM push_logs WHERE id = ?").run(log.id);
        markSendResult(channelId, r, true);
        okCount++;
      } catch (e) {
        console.error(`补发 log ${log.id} 失败:`, e.message);
        markSendResult(channelId, e, false);
      }
      // 队列已保证 10s 间隔，无需额外 sleep
    }

    console.log(`✅ 补发完成: ${okCount}/${failed.length} 成功`);
  } catch (e) {
    console.error('resendFailedMessages 错误:', e.message);
  }
}

// 统一记录欢迎/系统消息的推送结果（成功和失败都记录到 push_logs）
function logSystemPush(userId, channelId, title, message, resultOrErr, isSuccess) {
  try {
    const status = isSuccess ? 'success' : 'failed';
    const response = isSuccess
      ? JSON.stringify(resultOrErr)
      : JSON.stringify(resultOrErr?.response?.data || { error: resultOrErr?.message });
    db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(userId, title, message, status, 'system', channelId, response);
    markSendResult(channelId, resultOrErr, isSuccess);
    if (!isSuccess) {
      const errData = resultOrErr?.response?.data;
      const errStatus = resultOrErr?.response?.status;
      if (errStatus === 401 || errStatus === 403 || (errData && errData.ret === -14)) {
        db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channelId);
        console.error(`⚠️ 通道 ${channelId} 已标记为 inactive（token 失效）`);
      }
    }
  } catch (e) {
    console.error('logSystemPush 错误:', e.message);
  }
}

// 通知所有 admin 用户
function notifyAdmins(message) {
  try {
    const admins = db.prepare(`
      SELECT u.id, c.id AS channel_id, c.bot_token, c.wechat_openid, c.context_token
      FROM users u
      JOIN channels c ON c.id = (
        SELECT MAX(id) FROM channels
        WHERE user_id = u.id AND is_default = 1 AND context_token IS NOT NULL
      )
      WHERE u.role = 'admin'
    `).all();
    console.log(`📢 notifyAdmins: 找到 ${admins.length} 个 admin 通道`);
    for (const admin of admins) {
      if (admin.context_token) {
        enqueueSend(admin.channel_id,
          () => ilink.sendMessage(admin.bot_token, admin.wechat_openid, message, admin.context_token),
          { title: '📢 系统通知', source: 'notifyAdmins' })
          .then(r => {
            db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'success', ?, ?, ?)")
              .run(admin.id, '📢 系统通知', message, 'system', admin.channel_id, JSON.stringify(r));
            markSendResult(admin.channel_id, r, true);
          })
          .catch(err => {
            console.error('通知 admin 失败:', err.message);
            const errData = err.response?.data;
            db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'failed', ?, ?, ?)")
              .run(admin.id, '📢 系统通知', message, 'system', admin.channel_id, JSON.stringify(errData || { error: err.message }));
            markSendResult(admin.channel_id, err, false);
          });
      } else {
        console.log(`📢 notifyAdmins: admin ${admin.id} 无 context_token，跳过`);
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

    // 检查该微信是否已有账户（不按 status 过滤，避免 inactive 通道被误判为新用户）
    const existingChannel = db.prepare(
      "SELECT c.*, u.send_key FROM channels c JOIN users u ON c.user_id = u.id WHERE c.wechat_openid = ? ORDER BY c.id DESC LIMIT 1"
    ).get(ilinkUserId);

    if (existingChannel) {
      // ── 已有用户：重新绑定 + 自动登录 ──
      const userId = existingChannel.user_id;

      db.prepare(
        "UPDATE channels SET bot_token = ?, context_token = NULL, status = 'pending', bot_token_updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(botToken, existingChannel.id);

      startMessagePoller(botToken, ilinkUserId, (contextToken) => {
        db.prepare("UPDATE channels SET context_token = ? WHERE id = ?")
          .run(contextToken, existingChannel.id);
        reviveChannel(existingChannel.id);
        markRecoveredByRescan(existingChannel.id);
        probeMarkRescan(existingChannel.id);
        const welcomeMsg = '✅ 通道已激活（重绑恢复）\n\n欢迎回来！你的 BotTalk 通道已重新激活。你刚才的回复已成功送达，通道测试通过 ✓\n\n📢 由于 腾讯微信 ClawBot 协议的限制，通道长时间无互动会被微信平台静默断开。\n\n✅ 临时保活方法（直到腾讯修复）：\n• 收到推送后回复一字（"在""好""1"），系统会立即回执确认\n• 没收到回执 = 通道已断 → 回 https://bot-talk.com/app 重新扫码\n• 每天发一字保活，可显著降低断开概率';
        enqueueSend(existingChannel.id,
          () => ilink.sendMessage(botToken, ilinkUserId, welcomeMsg, contextToken),
          { title: '🔄 重绑欢迎', source: 'rebind-welcome' })
          .then(r => {
            logSystemPush(existingChannel.user_id, existingChannel.id, '🔄 重绑欢迎', welcomeMsg, r, true);
            resendFailedMessages(existingChannel.user_id, existingChannel.id, botToken, ilinkUserId, contextToken);
          })
          .catch(err => {
            console.error('发送重绑通知失败:', err.message);
            logSystemPush(existingChannel.user_id, existingChannel.id, '🔄 重绑欢迎', welcomeMsg, err, false);
          });
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
    const defaultNickname = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0') + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
    const userInfo = db.prepare(
      'INSERT INTO users (send_key, wechat_openid, nickname) VALUES (?, ?, ?)'
    ).run(sendKey, ilinkUserId, defaultNickname);
    const userId = userInfo.lastInsertRowid;

    const channelInfo = db.prepare(
      `INSERT INTO channels (user_id, name, channel_type, wechat_openid, bot_token, status, is_default, bot_token_updated_at)
       VALUES (?, '默认通道', 'wechat_ilink', ?, ?, 'pending', 1, CURRENT_TIMESTAMP)`
    ).run(userId, ilinkUserId, botToken);
    const channelId = channelInfo.lastInsertRowid;

    startMessagePoller(botToken, ilinkUserId, (contextToken) => {
      db.prepare("UPDATE channels SET context_token = ?, status = 'active' WHERE id = ?")
        .run(contextToken, channelId);
      const baseUrl = process.env.BASE_URL || 'https://bot-talk.com';
      const welcomeMsg =
        `🎉 欢迎使用 BotTalk！\n\n` +
        `你的推送通道已激活成功，刚才的回复已收到，通道测试通过 ✓\n` +
        `访问 ${baseUrl}/app 查看 SendKey 和 API 文档。\n\n` +
        `━━━━━━━━━━━━\n` +
        `📢 关于通道稳定性（请花 30 秒了解）\n\n` +
        `坦白告知：本服务依赖的是 腾讯微信 ClawBot 通道——这是腾讯仍在内测灰度阶段的协议，存在一个我们无法绕开的限制：` +
        `通道如果长时间没有用户互动，会被微信平台静默断开。这是腾讯方面的不完善，不是 BotTalk 的 bug。\n\n` +
        `想用微信简单接收推送，目前只有这一条相对方便的路（企业微信配置复杂得多）。所以在腾讯修复之前，需要你配合一个小动作：\n\n` +
        `✅ 临时保活方法：\n` +
        `• 收到推送后顺手回复一字（"在""好""1"），系统会立即回执确认\n` +
        `• 没收到回执 = 通道已被腾讯断开 → 回 ${baseUrl}/app 重新扫码（数据不丢）\n` +
        `• 即使没收到推送，每天发一字保活，可显著降低断开概率\n\n` +
        `🙏 我们持续跟进腾讯协议更新，一旦官方修复 bug，本提示和保活动作都会立即移除。`;
      enqueueSend(channelId,
        () => ilink.sendMessage(botToken, ilinkUserId, welcomeMsg, contextToken),
        { title: '🎉 欢迎消息', source: 'new-user-welcome' })
        .then(r => logSystemPush(userId, channelId, '🎉 欢迎消息', welcomeMsg, r, true))
        .catch(err => {
          console.error('发送欢迎消息失败:', err.message);
          logSystemPush(userId, channelId, '🎉 欢迎消息', welcomeMsg, err, false);
        });
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

    // 检查该微信是否已被绑定（不按 status 过滤，避免 inactive 通道被误判导致重复创建）
    const existingChannel = db.prepare(
      "SELECT c.*, u.wechat_openid as owner_openid FROM channels c JOIN users u ON c.user_id = u.id WHERE c.wechat_openid = ? ORDER BY c.id DESC LIMIT 1"
    ).get(ilinkUserId);

    if (existingChannel) {
      if (existingChannel.user_id === userId) {
        // 同一用户重新绑定 — 更新 bot_token，重置激活状态
        db.prepare(
          "UPDATE channels SET bot_token = ?, context_token = NULL, status = 'pending', bot_token_updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).run(botToken, existingChannel.id);

        // 重启 poller
        startMessagePoller(botToken, ilinkUserId, (contextToken) => {
          db.prepare("UPDATE channels SET context_token = ? WHERE id = ?")
            .run(contextToken, existingChannel.id);
          reviveChannel(existingChannel.id);
          markRecoveredByRescan(existingChannel.id);
        probeMarkRescan(existingChannel.id);
          const rebindMsg = '✅ 通道已激活（重绑恢复）\n\n通道重新绑定成功！可以正常接收消息推送了。\n\n📢 由于 腾讯微信 ClawBot 协议的限制，通道长时间无互动会被微信平台静默断开。\n\n✅ 临时保活方法（直到腾讯修复）：\n• 收到推送后回复一字（"在""好""1"），系统会立即回执确认\n• 没收到回执 = 通道已断 → 回 https://bot-talk.com/app 重新扫码\n• 每天发一字保活，可显著降低断开概率\n\n现在试试回复任意一字测试通道 👇';
          enqueueSend(existingChannel.id,
            () => ilink.sendMessage(botToken, ilinkUserId, rebindMsg, contextToken),
            { title: '🔄 通道重绑', source: 'rebind' })
            .then(r => {
              logSystemPush(userId, existingChannel.id, '🔄 通道重绑', rebindMsg, r, true);
              resendFailedMessages(userId, existingChannel.id, botToken, ilinkUserId, contextToken);
            })
            .catch(err => {
              console.error('发送重绑通知失败:', err.message);
              logSystemPush(userId, existingChannel.id, '🔄 通道重绑', rebindMsg, err, false);
            });
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
      `INSERT INTO channels (user_id, name, channel_type, wechat_openid, bot_token, status, is_default, bot_token_updated_at)
       VALUES (?, ?, 'wechat_ilink', ?, ?, 'pending', ?, CURRENT_TIMESTAMP)`
    ).run(userId, channelName, ilinkUserId, botToken, isFirst);

    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(info.lastInsertRowid);

    // Start message poller for the new channel
    startMessagePoller(botToken, ilinkUserId, (contextToken) => {
      db.prepare(
        "UPDATE channels SET context_token = ?, status = 'active' WHERE id = ?"
      ).run(contextToken, channel.id);
      const bindMsg = '通道绑定成功！\n\n该通道已激活，可以正常接收消息推送了。';
      enqueueSend(channel.id,
        () => ilink.sendMessage(botToken, ilinkUserId, bindMsg, contextToken),
        { title: '🆕 通道绑定', source: 'new-channel-bind' })
        .then(r => logSystemPush(userId, channel.id, '🆕 通道绑定', bindMsg, r, true))
        .catch(err => {
          console.error('发送绑定通知失败:', err.message);
          logSystemPush(userId, channel.id, '🆕 通道绑定', bindMsg, err, false);
        });
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
