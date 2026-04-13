const express = require('express');
const router = express.Router();
const db = require('../db');
const ilink = require('../ilink');
const { logActivity } = require('../services/logger');
const { markSendResult, classifyRet14, markSendDisabled } = require('../services/channel-health');
const { enqueueSend } = require('../services/push-queue');

// 简单内存限流：每 Key 每小时最多 100 条
const rateLimits = {};
function checkRateLimit(sendKey) {
  const now = Date.now();
  const hour = Math.floor(now / 3600000);
  const key = `${sendKey}:${hour}`;
  rateLimits[key] = (rateLimits[key] || 0) + 1;
  for (const k in rateLimits) {
    if (!k.endsWith(`:${hour}`)) delete rateLimits[k];
  }
  return rateLimits[key] <= 100;
}

// 推送失败时通知 admin（同一 channel+错误码 1 小时内只通知一次，避免刷屏）
const adminAlertDedup = {};
function alertAdminsOnFailure({ userId, nickname, channelId, title, errData, errMsg }) {
  try {
    const errKey = errData?.ret ?? errData?.errcode ?? errMsg ?? 'unknown';
    const dedupKey = `${channelId}:${errKey}`;
    const hour = Math.floor(Date.now() / 3600000);
    if (adminAlertDedup[dedupKey] === hour) return;
    adminAlertDedup[dedupKey] = hour;
    // 清理旧 key
    for (const k in adminAlertDedup) {
      if (adminAlertDedup[k] < hour - 1) delete adminAlertDedup[k];
    }

    const admins = db.prepare(`
      SELECT u.id, c.id AS channel_id, c.bot_token, c.wechat_openid, c.context_token
      FROM users u
      JOIN channels c ON c.id = (
        SELECT MAX(id) FROM channels
        WHERE user_id = u.id AND is_default = 1 AND context_token IS NOT NULL
      )
      WHERE u.role = 'admin'
    `).all();

    const userLabel = nickname || `User#${userId}`;
    const errStr = errData ? JSON.stringify(errData) : errMsg;
    const msg = `⚠️ 推送失败报警\n\n用户: ${userLabel} (ID:${userId})\n通道: ${channelId}\n标题: ${title || '(无)'}\n错误: ${errStr}\n时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n(同类错误1小时内只提醒一次)`;

    for (const admin of admins) {
      if (!admin.context_token) continue;
      enqueueSend(admin.channel_id,
        () => ilink.sendMessage(admin.bot_token, admin.wechat_openid, msg, admin.context_token),
        { title: '⚠️ 失败报警', source: 'alert' })
        .then(r => {
          db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'success', ?, ?, ?)")
            .run(admin.id, '⚠️ 失败报警', msg, 'alert', admin.channel_id, JSON.stringify(r));
          markSendResult(admin.channel_id, r, true);
        })
        .catch(err => {
          console.error('失败报警发送失败:', err.message);
          markSendResult(admin.channel_id, err, false);
        });
    }
  } catch (e) {
    console.error('alertAdminsOnFailure 错误:', e.message);
  }
}

// 解析目标 channels
// 注意：不再按 status='active' 过滤，因为该标记不一定准确。
// 只要通道存在且有 context_token 就尝试发送，由 iLink 返回决定成败。
// 对同一 wechat_openid 的重复通道，取最新的一条（MAX(id)）。
function resolveChannels(userId, channelParam) {
  if (!channelParam || channelParam === 'default') {
    // 默认频道：is_default=1 里取最新的
    const ch = db.prepare(
      `SELECT * FROM channels WHERE user_id = ? AND is_default = 1 AND context_token IS NOT NULL ORDER BY id DESC LIMIT 1`
    ).get(userId);
    return ch ? [ch] : [];
  }

  if (channelParam === 'all') {
    // 每个 wechat_openid 只保留最新通道
    return db.prepare(
      `SELECT * FROM channels WHERE id IN (
         SELECT MAX(id) FROM channels
         WHERE user_id = ? AND context_token IS NOT NULL
         GROUP BY wechat_openid
       )`
    ).all(userId);
  }

  // 逗号分隔的 ID 列表
  const ids = channelParam.split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM channels WHERE id IN (${placeholders}) AND user_id = ? AND context_token IS NOT NULL`
  ).all(...ids, userId);
}

// 核心推送逻辑
async function handlePush(sendKey, title, content, clientIp, channelParam, req) {
  const user = db.prepare('SELECT * FROM users WHERE send_key = ?').get(sendKey);
  if (!user) {
    return { code: 40001, message: 'SendKey 无效', data: null };
  }

  if (!checkRateLimit(sendKey)) {
    return { code: 42901, message: '发送频率超限（每小时最多100条）', data: null };
  }

  if (!title && !content) {
    return { code: 40003, message: 'title 和消息内容不能同时为空', data: null };
  }

  const channels = resolveChannels(user.id, channelParam);
  if (channels.length === 0) {
    return { code: 40002, message: '没有可用的推送通道，请先绑定并激活通道', data: null };
  }

  const message = title + (content ? '\n\n' + content : '');
  const results = [];

  for (const channel of channels) {
    if (!channel.context_token) {
      results.push({ channel_id: channel.id, status: 'skipped', reason: 'no context_token' });
      continue;
    }

    try {
      let ilinkRes;
      const startedAt = Date.now();
      try {
        ilinkRes = await enqueueSend(channel.id,
          () => ilink.sendMessage(channel.bot_token, channel.wechat_openid, message, channel.context_token),
          { title, source: 'api' });
      } catch (retryErr) {
        // ret: -2 时等 5 秒自动重试一次
        if (retryErr.response?.data?.ret === -2) {
          console.log(`⏳ 通道 ${channel.id} ret:-2，5秒后重试...`);
          await new Promise(r => setTimeout(r, 5000));
          const delaySec = Math.round((Date.now() - startedAt) / 1000);
          const retryMessage = `ℹ️ 本消息因通道临时不稳定延迟 ${delaySec} 秒送达\n\n${message}`;
          ilinkRes = await enqueueSend(channel.id,
            () => ilink.sendMessage(channel.bot_token, channel.wechat_openid, retryMessage, channel.context_token),
            { title, source: 'api-retry' });
        } else {
          throw retryErr;
        }
      }
      const resJson = JSON.stringify(ilinkRes);

      db.prepare(`
        INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response)
        VALUES (?, ?, ?, 'success', ?, ?, ?)
      `).run(user.id, title, content, clientIp, channel.id, resJson);

      markSendResult(channel.id, ilinkRes, true);
      logActivity(user.id, 'push_api', { channel_id: channel.id, title }, req);
      results.push({ channel_id: channel.id, status: 'success' });
    } catch (error) {
      const errStatus = error.response?.status;
      const errData = error.response?.data;
      const resJson = JSON.stringify(errData || { errcode: -1, errmsg: error.message });
      markSendResult(channel.id, error, false);

      // ret:-14 分类：调 getUpdates 二次确认是 session 真死还是"半死态"（账号被风控）
      let tokenInvalid = false;
      if (errData && errData.ret === -14) {
        try {
          const cls = await classifyRet14(channel.id, channel.bot_token);
          if (cls.trueSessionDeath) {
            tokenInvalid = true;
            db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channel.id);
            console.error(`⚠️ 通道 ${channel.id} session 真失效（getUpdates 也 ret:-14），标记 inactive`);
          } else if (cls.sendDisabled) {
            markSendDisabled(channel.id, '账号可能被 iLink 风控（sendMessage -14 但 getUpdates 正常）');
            console.error(`⚠️ 通道 ${channel.id} 半死态：能收不能发（账号可能未实名/被风控）`);
          }
        } catch (clsErr) {
          console.error('classifyRet14 失败，保守当做 session 死:', clsErr.message);
          tokenInvalid = true;
          db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channel.id);
        }
      } else if (errStatus === 401 || errStatus === 403) {
        // HTTP 401/403 明确的 token 失效
        tokenInvalid = true;
        db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channel.id);
        console.error(`⚠️ 通道 ${channel.id} 已标记为 inactive（HTTP ${errStatus}）`);
      }

      db.prepare(`
        INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response)
        VALUES (?, ?, ?, 'failed', ?, ?, ?)
      `).run(user.id, title, content, clientIp, channel.id, resJson);

      logActivity(user.id, 'push_fail', { channel_id: channel.id, error: error.message, token_invalid: tokenInvalid }, req);
      console.error('❌ 推送失败:', errData || error.message);
      alertAdminsOnFailure({
        userId: user.id,
        nickname: user.nickname,
        channelId: channel.id,
        title,
        errData,
        errMsg: error.message,
      });
      results.push({ channel_id: channel.id, status: 'failed', token_invalid: tokenInvalid });
    }
  }

  const anySuccess = results.some(r => r.status === 'success');
  return {
    code: anySuccess ? 0 : 50001,
    message: anySuccess ? 'success' : '全部推送失败',
    data: { results }
  };
}

function getClientIp(req) {
  return req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
}

// ===== 风格1：兼容现有 relay-api 格式 =====
// GET /notify?key=KEY&msg=消息&title=标题
// POST /notify (Authorization: Bearer KEY, body: {message, title})
router.all('/notify', async (req, res) => {
  let sendKey = req.query.key;
  if (!sendKey) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      sendKey = auth.slice(7);
    }
  }
  if (!sendKey) {
    return res.json({ code: 40001, message: '缺少 key 参数', data: null });
  }

  const title = req.body?.title || req.query?.title || '';
  const content = req.body?.message || req.body?.desp || req.query?.msg || req.query?.desp || '';
  const channel = req.body?.channel || req.query?.channel || '';

  const result = await handlePush(sendKey, title, content, getClientIp(req), channel, req);
  res.json(result);
});

// ===== 风格2：Server酱风格 =====
// GET/POST /:key.send?title=标题&desp=内容
router.all('/:key.send', async (req, res) => {
  const sendKey = req.params.key;
  const title = req.body?.title || req.query?.title || '';
  const content = req.body?.desp || req.body?.message || req.query?.desp || req.query?.msg || '';
  const channel = req.body?.channel || req.query?.channel || '';

  const result = await handlePush(sendKey, title, content, getClientIp(req), channel, req);
  res.json(result);
});

// ===== 联系团队 =====
const { requireLogin } = require('../middleware/auth');

router.post('/contact', requireLogin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || message.trim().length === 0 || message.trim().length > 100) {
      return res.json({ code: 40003, message: '消息不能为空且不超过100字' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.json({ code: 40001, message: '用户不存在' });

    const nickname = user.nickname || user.wechat_openid || ('User#' + user.id);
    const content = message.trim();
    const fullMsg = `💬 用户反馈\n\n来自: ${nickname}\n内容: ${content}`;

    const clientIp = getClientIp(req);

    // 发给所有 admin（不按 status 过滤，只要有 context_token 就尝试）
    const admins = db.prepare(`
      SELECT u.id, c.id AS channel_id, c.bot_token, c.wechat_openid, c.context_token
      FROM users u
      JOIN channels c ON c.id = (
        SELECT MAX(id) FROM channels
        WHERE user_id = u.id AND is_default = 1 AND context_token IS NOT NULL
      )
      WHERE u.role = 'admin'
    `).all();
    for (const admin of admins) {
      if (admin.context_token) {
        try {
          let r;
          const startedAt = Date.now();
          try {
            r = await enqueueSend(admin.channel_id,
              () => ilink.sendMessage(admin.bot_token, admin.wechat_openid, fullMsg, admin.context_token),
              { title: '💬 用户反馈', source: 'contact-admin' });
          } catch (retryErr) {
            if (retryErr.response?.data?.ret === -2) {
              console.log(`⏳ Admin 通道 ${admin.channel_id} ret:-2，5秒后重试...`);
              await new Promise(resolve => setTimeout(resolve, 5000));
              const delaySec = Math.round((Date.now() - startedAt) / 1000);
              const retryMsg = `ℹ️ 本消息因通道临时不稳定延迟 ${delaySec} 秒送达\n\n${fullMsg}`;
              r = await enqueueSend(admin.channel_id,
                () => ilink.sendMessage(admin.bot_token, admin.wechat_openid, retryMsg, admin.context_token),
                { title: '💬 用户反馈', source: 'contact-admin-retry' });
            } else {
              throw retryErr;
            }
          }
          db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'success', ?, ?, ?)")
            .run(admin.id, '💬 用户反馈', content, 'contact', admin.channel_id, JSON.stringify(r));
          markSendResult(admin.channel_id, r, true);
        } catch (e) {
          const errData = e.response?.data;
          const errStatus = e.response?.status;
          const tokenInvalid = errStatus === 401 || errStatus === 403
            || (errData && errData.ret === -14);
          if (tokenInvalid) {
            db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(admin.channel_id);
            console.error(`⚠️ Admin 通道 ${admin.channel_id} 已标记为 inactive（token 失效）`);
          }
          db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'failed', ?, ?, ?)")
            .run(admin.id, '💬 用户反馈', content, 'contact', admin.channel_id, JSON.stringify(errData || { error: e.message }));
          markSendResult(admin.channel_id, e, false);
          alertAdminsOnFailure({
            userId: user.id,
            nickname: user.nickname,
            channelId: admin.channel_id,
            title: '💬 用户反馈转发失败',
            errData,
            errMsg: e.message,
          });
        }
      }
    }

    // 发给用户自己（确认副本，不按 status 过滤）
    const userCh = db.prepare(
      "SELECT * FROM channels WHERE user_id = ? AND is_default = 1 AND context_token IS NOT NULL ORDER BY id DESC LIMIT 1"
    ).get(user.id);
    if (userCh && userCh.context_token) {
      try {
        let r;
        const confirmMsg = '✅ 你的反馈已发送\n\n内容: ' + content;
        const startedAt = Date.now();
        try {
          r = await enqueueSend(userCh.id,
            () => ilink.sendMessage(userCh.bot_token, userCh.wechat_openid, confirmMsg, userCh.context_token),
            { title: '✅ 反馈确认', source: 'contact-user' });
        } catch (retryErr) {
          if (retryErr.response?.data?.ret === -2) {
            console.log(`⏳ 用户通道 ${userCh.id} ret:-2，5秒后重试...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            const delaySec = Math.round((Date.now() - startedAt) / 1000);
            const retryMsg = `ℹ️ 本消息因通道临时不稳定延迟 ${delaySec} 秒送达\n\n${confirmMsg}`;
            r = await enqueueSend(userCh.id,
              () => ilink.sendMessage(userCh.bot_token, userCh.wechat_openid, retryMsg, userCh.context_token),
              { title: '✅ 反馈确认', source: 'contact-user-retry' });
          } else {
            throw retryErr;
          }
        }
        db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'success', ?, ?, ?)")
          .run(user.id, '✅ 反馈确认', content, clientIp, userCh.id, JSON.stringify(r));
        markSendResult(userCh.id, r, true);
      } catch (e) {
        const errData = e.response?.data;
        const errStatus = e.response?.status;
        const tokenInvalid = errStatus === 401 || errStatus === 403
          || (errData && errData.ret === -14);
        if (tokenInvalid) {
          db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(userCh.id);
          console.error(`⚠️ 用户通道 ${userCh.id} 已标记为 inactive（token 失效）`);
        }
        db.prepare("INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response) VALUES (?, ?, ?, 'failed', ?, ?, ?)")
          .run(user.id, '✅ 反馈确认', content, clientIp, userCh.id, JSON.stringify(errData || { error: e.message }));
        markSendResult(userCh.id, e, false);
        alertAdminsOnFailure({
          userId: user.id,
          nickname: user.nickname,
          channelId: userCh.id,
          title: '✅ 反馈确认副本失败',
          errData,
          errMsg: e.message,
        });
      }
    }

    logActivity(user.id, 'contact_team', { message: content }, req);
    res.json({ code: 0, message: 'success' });
  } catch (err) {
    console.error('Contact error:', err.message);
    res.json({ code: 50001, message: '发送失败' });
  }
});

module.exports = router;
module.exports.alertAdminsOnFailure = alertAdminsOnFailure;
