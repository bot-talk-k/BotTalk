const ilink = require('../ilink');
const db = require('../db');

// 内存缓存
const contextTokenCache = {};
const pollerHeartbeat = {}; // botToken -> { lastOk: timestamp, alive: bool }

// 启动长轮询服务（持续接收消息）
async function startMessagePoller(botToken, userId, onFirstMessage) {
  console.log(`🔄 启动消息轮询服务：${userId}`);

  let cursor = '';
  let hasReceivedFirstMessage = false;
  const pollerStartTime = Date.now();
  let pollCount = 0;

  // 初始化心跳
  pollerHeartbeat[botToken] = { lastOk: Date.now(), alive: true };

  // 从 channels 表加载已有的 context_token
  const channel = db.prepare(
    `SELECT context_token FROM channels WHERE bot_token = ? AND wechat_openid = ? AND context_token IS NOT NULL LIMIT 1`
  ).get(botToken, userId);
  if (channel?.context_token) {
    contextTokenCache[userId] = channel.context_token;
    hasReceivedFirstMessage = true;
    console.log(`📦 ${userId} 从数据库恢复 context_token`);
  }

  while (true) {
    try {
      const result = await ilink.getUpdates(botToken, cursor);

      // 每次 getUpdates 正常返回（含空轮询）都更新心跳
      pollCount++;
      pollerHeartbeat[botToken] = { lastOk: Date.now(), alive: true };
      if (pollCount % 100 === 0) {
        const hours = ((Date.now() - pollerStartTime) / 3600000).toFixed(1);
        console.log(`💓 ${userId} poller 存活 ${hours}h，已轮询 ${pollCount} 次`);
      }

      if (result.get_updates_buf && result.get_updates_buf !== cursor) {
        cursor = result.get_updates_buf;
      }

      if (result.msgs && result.msgs.length > 0) {
        for (const msg of result.msgs) {
          if (msg.context_token) {
            // 写入内存缓存
            contextTokenCache[userId] = msg.context_token;

            // 持久化到 channels 表
            db.prepare(`UPDATE channels SET context_token = ?, status = 'active' WHERE bot_token = ? AND wechat_openid = ?`)
              .run(msg.context_token, botToken, userId);

            if (!hasReceivedFirstMessage && onFirstMessage) {
              hasReceivedFirstMessage = true;
              onFirstMessage(msg.context_token);
            }
          }
        }
      }
    } catch (error) {
      if (error.code === 'SESSION_EXPIRED') {
        console.error(`⚠️ ${userId} session 已过期，停止轮询并标记通道 inactive`);
        pollerHeartbeat[botToken] = { lastOk: pollerHeartbeat[botToken]?.lastOk || 0, alive: false, reason: 'session_expired' };
        db.prepare("UPDATE channels SET status = 'inactive' WHERE bot_token = ? AND wechat_openid = ?")
          .run(botToken, userId);
        delete contextTokenCache[userId];
        return; // 停止轮询
      }
      console.error(`❌ ${userId} 轮询错误:`, error.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// 检查通道是否存活（不调 iLink API，只看 poller 心跳）
function isChannelAlive(botToken) {
  const hb = pollerHeartbeat[botToken];
  if (!hb) return { alive: false, reason: 'no_poller' };
  if (!hb.alive) return { alive: false, reason: hb.reason || 'stopped' };
  // 超过 60 秒没心跳认为异常（正常长轮询约 18 秒一次）
  const age = Date.now() - hb.lastOk;
  if (age > 60000) return { alive: false, reason: 'heartbeat_timeout', last_ok_seconds_ago: Math.round(age / 1000) };
  return { alive: true, last_ok_seconds_ago: Math.round(age / 1000) };
}

function getContextToken(userId) {
  // 先查缓存
  if (contextTokenCache[userId]) return contextTokenCache[userId];
  // 再查 channels 表
  const channel = db.prepare(
    `SELECT context_token FROM channels WHERE wechat_openid = ? AND status = 'active' AND context_token IS NOT NULL LIMIT 1`
  ).get(userId);
  if (channel?.context_token) {
    contextTokenCache[userId] = channel.context_token;
    return channel.context_token;
  }
  return '';
}

function setContextToken(userId, token) {
  contextTokenCache[userId] = token;
  db.prepare(`UPDATE channels SET context_token = ?, status = 'active' WHERE wechat_openid = ?`).run(token, userId);
  console.log(`✅ 手动设置 ${userId} 的 context_token`);
}

module.exports = { startMessagePoller, getContextToken, setContextToken, isChannelAlive };
