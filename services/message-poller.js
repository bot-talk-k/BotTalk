const ilink = require('../ilink');
const db = require('../db');
const logger = require('./logger');

const contextTokenCache = {};
const pollerHeartbeat = {};
const lastAckAt = {};
const activePollers = new Map(); // botToken -> { controller, promise }

const IDLE_DELAYS_MS = [1000, 2000, 4000];
const IDLE_DELAY_MAX_MS = 5000;
const ERROR_DELAY_BASE_MS = 1000;
const ERROR_DELAY_MAX_MS = 30000;

const ACK_MESSAGES = [
  '✅ 收到！假装在聊天，通道才畅通',
  '✅ 收到！收到消息多回复，保障通道畅通',
  '✅ 收到！微信通道靠双向对话维持，多互动几次就不会断',
];
const ACK_DEDUP_MS = 30 * 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function idleDelay(attempt) {
  return attempt <= IDLE_DELAYS_MS.length
    ? IDLE_DELAYS_MS[attempt - 1]
    : IDLE_DELAY_MAX_MS;
}

function errorDelay(attempt) {
  return Math.min(ERROR_DELAY_BASE_MS * (2 ** (attempt - 1)), ERROR_DELAY_MAX_MS);
}

// Testable core. Empty responses are deliberately paced; only messages pull again
// immediately. A request error is not an empty response and uses the longer cap.
async function runPollingLoop({
  botToken,
  userId,
  signal,
  getUpdates = ilink.getUpdates,
  now = Date.now,
  wait = sleep,
  onResult = async () => {},
  onError = logger.warn,
  onSessionExpired = async () => {},
  onHeartbeat = () => {},
  onStart = () => {},
}) {
  let cursor = '';
  let idleAttempt = 0;
  let errorAttempt = 0;
  let pollCount = 0;
  const startedAt = now();

  onStart();
  while (!signal?.aborted) {
    try {
      const result = await getUpdates(botToken, cursor, { signal });
      if (signal?.aborted) return { reason: 'aborted', pollCount };

      pollCount++;
      errorAttempt = 0;
      onHeartbeat({ lastOk: now(), alive: true, pollCount, startedAt });
      if (pollCount % 100 === 0) {
        const hours = ((now() - startedAt) / 3600000).toFixed(1);
        logger.debug(`💓 ${userId} poller 存活 ${hours}h，已轮询 ${pollCount} 次`);
      }

      if (result.get_updates_buf && result.get_updates_buf !== cursor) {
        cursor = result.get_updates_buf;
      }

      const messages = Array.isArray(result.msgs) ? result.msgs : [];
      if (messages.length > 0) {
        idleAttempt = 0;
        await onResult(messages);
        continue; // next pull is intentionally immediate
      }

      idleAttempt++;
      await wait(idleDelay(idleAttempt), signal);
    } catch (error) {
      if (signal?.aborted || error.code === 'ABORT_ERR' || error.name === 'CanceledError') {
        return { reason: 'aborted', pollCount };
      }
      if (error.code === 'SESSION_EXPIRED') {
        await onSessionExpired(error);
        return { reason: 'session_expired', pollCount };
      }

      errorAttempt++;
      idleAttempt = 0;
      const delay = errorDelay(errorAttempt);
      onError(`⚠️ ${userId} 轮询失败，${delay / 1000}s 后重试: ${error.message}`);
      await wait(delay, signal);
    }
  }
  return { reason: 'aborted', pollCount };
}

function handleMessages(botToken, userId, messages, state) {
  let batchHasUserText = false;
  let batchChannelId = null;
  let batchContextToken = null;
  let batchFiredFirstMessage = false;

  for (const msg of messages) {
    if (!msg.context_token) continue;

    contextTokenCache[userId] = msg.context_token;
    db.prepare(`UPDATE channels
      SET context_token = ?, status = 'active', last_inbound_at = CURRENT_TIMESTAMP,
          consecutive_neg2_count = 0, disconnected_at = NULL
      WHERE bot_token = ? AND wechat_openid = ?`)
      .run(msg.context_token, botToken, userId);

    try {
      const chRow = db.prepare('SELECT id FROM channels WHERE bot_token = ? AND wechat_openid = ? LIMIT 1').get(botToken, userId);
      if (chRow?.id) {
        const result = db.prepare(`UPDATE neg2_recovery_probe
          SET recovered_at = CURRENT_TIMESTAMP, recovered_by = 'user_reply'
          WHERE channel_id = ? AND recovered_at IS NULL AND gave_up_at IS NULL`).run(chRow.id);
        if (result.changes > 0) logger.info(`♻️ 用户回复: channel=${chRow.id} 标记 ${result.changes} 条探测为 user_reply 恢复`);
      }
    } catch (error) {
      logger.error('用户回复复位失败:', error.message);
    }

    try {
      const channelRow = db.prepare('SELECT id FROM channels WHERE bot_token = ? AND wechat_openid = ? LIMIT 1').get(botToken, userId);
      let textPreview = null;
      let hasText = 0;
      if (msg.item_list?.length > 0) {
        const textItem = msg.item_list.find(item => item.text_item?.text);
        if (textItem) {
          hasText = 1;
          textPreview = String(textItem.text_item.text).substring(0, 50);
        }
      }
      db.prepare(`INSERT INTO inbound_events
        (channel_id, wechat_openid, from_user_id, message_type, has_text, text_preview, context_token_prefix)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(channelRow?.id || null, userId, msg.from_user_id || null, msg.message_type || null,
          hasText, textPreview, msg.context_token.substring(0, 20));
      logger.info(`📥 收到消息: channel=${channelRow?.id || 'unknown'}${hasText ? ` text="${textPreview}"` : ''}`);
      if (hasText) {
        batchHasUserText = true;
        batchChannelId = channelRow?.id || null;
        batchContextToken = msg.context_token;
      }
    } catch (error) {
      logger.error('inbound_events 写入失败:', error.message);
    }

    if (!state.hasReceivedFirstMessage && state.onFirstMessage) {
      state.hasReceivedFirstMessage = true;
      batchFiredFirstMessage = true;
      state.onFirstMessage(msg.context_token);
    }
  }

  if (batchHasUserText && batchChannelId && batchContextToken && !batchFiredFirstMessage) {
    // 用户回复仅恢复 context/channel 状态与 ack；持久化 retry queue 已停用。
    maybeSendAck(batchChannelId, botToken, userId, batchContextToken);
  }
}

// Same token gets one flight. Normal duplicate starts return that flight; callers
// may pass { restart: true } only when a deliberate replacement is required.
function startPollingFlight(botToken, userId, onFirstMessage) {
  const controller = new AbortController();
  const state = { hasReceivedFirstMessage: false, onFirstMessage };
  const channel = db.prepare(
    `SELECT context_token FROM channels WHERE bot_token = ? AND wechat_openid = ? AND context_token IS NOT NULL LIMIT 1`
  ).get(botToken, userId);
  if (channel?.context_token) {
    contextTokenCache[userId] = channel.context_token;
    state.hasReceivedFirstMessage = true;
    logger.info(`📦 ${userId} 从数据库恢复 context_token`);
  }

  logger.info(`🔄 启动消息轮询服务：${userId}`);
  const entry = { controller, promise: null };
  entry.promise = runPollingLoop({
    botToken,
    userId,
    signal: controller.signal,
    onStart: () => {
      pollerHeartbeat[botToken] = { lastOk: Date.now(), alive: true };
    },
    onHeartbeat: heartbeat => {
      pollerHeartbeat[botToken] = heartbeat;
    },
    onResult: messages => handleMessages(botToken, userId, messages, state),
    onSessionExpired: () => {
      logger.error(`⚠️ ${userId} session 已过期，停止轮询并标记通道 inactive`);
      pollerHeartbeat[botToken] = { lastOk: pollerHeartbeat[botToken]?.lastOk || 0, alive: false, reason: 'session_expired' };
      db.prepare("UPDATE channels SET status = 'inactive' WHERE bot_token = ? AND wechat_openid = ?")
        .run(botToken, userId);
      delete contextTokenCache[userId];
    },
  }).catch(error => logger.error(`poller ${userId} 未处理异常:`, error.message))
    .finally(() => {
      if (activePollers.get(botToken) === entry) activePollers.delete(botToken);
    });
  activePollers.set(botToken, entry);
  return entry.promise;
}

function startMessagePoller(botToken, userId, onFirstMessage, options = {}) {
  const existing = activePollers.get(botToken);
  if (!existing) return startPollingFlight(botToken, userId, onFirstMessage);
  if (!options.restart) return existing.promise;

  existing.controller.abort();
  return existing.promise.finally(() => startPollingFlight(botToken, userId, onFirstMessage));
}

function maybeSendAck(channelId, botToken, wechatOpenid, contextToken) {
  const now = Date.now();
  if ((lastAckAt[channelId] || 0) > now - ACK_DEDUP_MS) return;
  lastAckAt[channelId] = now;
  const text = ACK_MESSAGES[Math.floor(Math.random() * ACK_MESSAGES.length)];
  const { enqueueSend } = require('./push-queue');
  const { markSendResult } = require('./channel-health');
  enqueueSend(channelId,
    () => ilink.sendMessage(botToken, wechatOpenid, text, contextToken),
    { title: 'ack', source: 'inbound-ack' })
    .then(result => {
      markSendResult(channelId, result, true);
      try {
        db.prepare(`INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response)
          SELECT user_id, '✅ 回执', ?, 'success', 'inbound-ack', id, ?
          FROM channels WHERE id = ?`)
          .run(text, JSON.stringify(result), channelId);
      } catch {}
    })
    .catch(error => {
      markSendResult(channelId, error, false);
      logger.error(`📤 ack 失败 channel=${channelId}:`, error.message);
    });
}

function isChannelAlive(botToken) {
  const heartbeat = pollerHeartbeat[botToken];
  if (!heartbeat) return { alive: false, reason: 'no_poller' };
  if (!heartbeat.alive) return { alive: false, reason: heartbeat.reason || 'stopped' };
  // 40s long-poll plus 30s retry backoff requires a wider supervisor window.
  const age = Date.now() - heartbeat.lastOk;
  if (age > 120000) return { alive: false, reason: 'heartbeat_timeout', last_ok_seconds_ago: Math.round(age / 1000) };
  return { alive: true, last_ok_seconds_ago: Math.round(age / 1000) };
}

function getContextToken(userId) {
  if (contextTokenCache[userId]) return contextTokenCache[userId];
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
  const rows = db.prepare(`SELECT id FROM channels WHERE wechat_openid = ?`).all(userId);
  db.prepare(`UPDATE channels SET context_token = ? WHERE wechat_openid = ?`).run(token, userId);
  try {
    const { reviveChannel } = require('./channel-health');
    rows.forEach(row => reviveChannel(row.id));
  } catch {
    db.prepare(`UPDATE channels SET status = 'active' WHERE wechat_openid = ?`).run(userId);
  }
  logger.info(`✅ 手动设置 ${userId} 的 context_token`);
}

module.exports = {
  startMessagePoller,
  runPollingLoop,
  idleDelay,
  errorDelay,
  getContextToken,
  setContextToken,
  isChannelAlive,
  _heartbeat: pollerHeartbeat,
  _activePollers: activePollers,
};
