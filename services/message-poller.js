const ilink = require('../ilink');
const db = require('../db');

// 内存缓存
const contextTokenCache = {};
const pollerHeartbeat = {}; // botToken -> { lastOk: timestamp, alive: bool }
const lastAckAt = {};       // channelId -> timestamp（回执去重）

// 回执文案池（轮换避免机械感）
const ACK_MESSAGES = [
  '✅ 收到，通道状态已刷新，谢谢配合',
  '✅ 已收到你的回复，通道保持活跃中',
  '✅ 收到，谢谢——你的回复有助于通道稳定',
];
const ACK_DEDUP_MS = 30 * 1000;

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
        let batchHasUserText = false;
        let batchChannelId = null;
        let batchContextToken = null;
        for (const msg of result.msgs) {
          if (msg.context_token) {
            // 写入内存缓存
            contextTokenCache[userId] = msg.context_token;

            // 持久化到 channels 表（含 last_inbound_at）
            db.prepare(`UPDATE channels SET context_token = ?, status = 'active', last_inbound_at = CURRENT_TIMESTAMP WHERE bot_token = ? AND wechat_openid = ?`)
              .run(msg.context_token, botToken, userId);

            // 记录 inbound_events（脱敏：仅存前 50 字预览）
            try {
              const channelRow = db.prepare('SELECT id FROM channels WHERE bot_token = ? AND wechat_openid = ? LIMIT 1').get(botToken, userId);
              let textPreview = null;
              let hasText = 0;
              if (msg.item_list && msg.item_list.length > 0) {
                const txtItem = msg.item_list.find(it => it.text_item?.text);
                if (txtItem) {
                  hasText = 1;
                  textPreview = String(txtItem.text_item.text).substring(0, 50);
                }
              }
              db.prepare(`
                INSERT INTO inbound_events
                (channel_id, wechat_openid, from_user_id, message_type, has_text, text_preview, context_token_prefix)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `).run(
                channelRow?.id || null,
                userId,
                msg.from_user_id || null,
                msg.message_type || null,
                hasText,
                textPreview,
                msg.context_token.substring(0, 20)
              );
              console.log(`📥 inbound_event 记录: channel=${channelRow?.id} from=${msg.from_user_id} text="${textPreview || '(无)'}"`);
              if (hasText) {
                batchHasUserText = true;
                batchChannelId = channelRow?.id || null;
                batchContextToken = msg.context_token;
              }
            } catch (e) {
              console.error('inbound_events 写入失败:', e.message);
            }

            if (!hasReceivedFirstMessage && onFirstMessage) {
              hasReceivedFirstMessage = true;
              onFirstMessage(msg.context_token);
            }
          }
        }

        // 整批消息处理完后，统一回一次 ack（不论 N 条都只回 1 条）
        if (batchHasUserText && batchChannelId && batchContextToken) {
          maybeSendAck(batchChannelId, botToken, userId, batchContextToken);
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

// 用户回复时秒回一条确认（让用户知道"我们收到了"）
// 同 channel 30 秒去重；走 push-queue 限流；失败不重试（在 push_logs 可见即可）
function maybeSendAck(channelId, botToken, wechatOpenid, contextToken) {
  const now = Date.now();
  if ((lastAckAt[channelId] || 0) > now - ACK_DEDUP_MS) return;
  lastAckAt[channelId] = now;
  const text = ACK_MESSAGES[Math.floor(Math.random() * ACK_MESSAGES.length)];
  // 延迟 require 避免循环依赖
  const { enqueueSend } = require('./push-queue');
  const { markSendResult } = require('./channel-health');
  enqueueSend(channelId,
    () => ilink.sendMessage(botToken, wechatOpenid, text, contextToken),
    { title: 'ack', source: 'inbound-ack' })
    .then(r => {
      markSendResult(channelId, r, true);
      try {
        db.prepare(`INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response)
          SELECT user_id, '✅ 回执', ?, 'success', 'inbound-ack', id, ?
          FROM channels WHERE id = ?`)
          .run(text, JSON.stringify(r), channelId);
      } catch (e) {}
    })
    .catch(err => {
      markSendResult(channelId, err, false);
      console.error(`📤 ack 失败 channel=${channelId}:`, err.message);
    });
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
    `SELECT context_token FROM channels WHERE wechat_openid = ? AND context_token IS NOT NULL ORDER BY id DESC LIMIT 1`
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

module.exports = { startMessagePoller, getContextToken, setContextToken, isChannelAlive, _heartbeat: pollerHeartbeat };
