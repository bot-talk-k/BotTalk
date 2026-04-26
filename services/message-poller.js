const ilink = require('../ilink');
const db = require('../db');

// 内存缓存
const contextTokenCache = {};
const pollerHeartbeat = {}; // botToken -> { lastOk: timestamp, alive: bool }
const lastAckAt = {};       // channelId -> timestamp（回执去重）
const pollerEpoch = {};     // botToken -> integer（每次 startMessagePoller 递增，旧 loop 发现 epoch 不匹配就退出）

// 回执文案池（轮换避免机械感）
const ACK_MESSAGES = [
  '✅ 收到，通道状态已刷新，谢谢配合',
  '✅ 已收到你的回复，通道保持活跃中',
  '✅ 收到，谢谢——你的回复有助于通道稳定',
];
const ACK_DEDUP_MS = 30 * 1000;

// 启动长轮询服务（持续接收消息）
// 幂等保护：同一 bot_token 只允许一个 loop 活跃。再次调用会递增 epoch，
// 旧 loop 在下一次迭代发现 epoch 不匹配就自行 break，避免并发 long-poll。
async function startMessagePoller(botToken, userId, onFirstMessage) {
  const myEpoch = (pollerEpoch[botToken] || 0) + 1;
  pollerEpoch[botToken] = myEpoch;
  console.log(`🔄 启动消息轮询服务：${userId} (epoch=${myEpoch})`);

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
    // Epoch 检查：如果有更新的 poller 被启动（epoch 递增），本 loop 退出
    if (pollerEpoch[botToken] !== myEpoch) {
      console.log(`🛑 ${userId} poller (epoch=${myEpoch}) 退出，已被新 loop (epoch=${pollerEpoch[botToken]}) 取代`);
      return;
    }
    try {
      const result = await ilink.getUpdates(botToken, cursor);

      // 再次检查 epoch（await 期间可能已被取代）
      if (pollerEpoch[botToken] !== myEpoch) {
        console.log(`🛑 ${userId} poller (epoch=${myEpoch}) 在 getUpdates 后发现被取代，退出`);
        return;
      }

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
        let batchFiredFirstMessage = false;
        for (const msg of result.msgs) {
          if (msg.context_token) {
            // 写入内存缓存
            contextTokenCache[userId] = msg.context_token;

            // 持久化到 channels 表：刷新 context_token + 复位所有衰退标记
            // 用户回复证明通道活着，ret:-2 老化状态自动清零
            db.prepare(`UPDATE channels
              SET context_token = ?, status = 'active', last_inbound_at = CURRENT_TIMESTAMP,
                  consecutive_neg2_count = 0
              WHERE bot_token = ? AND wechat_openid = ?`)
              .run(msg.context_token, botToken, userId);

            // 用户回复 → 把 pending 重试立即置为到期（scheduler 30s 内会重试真正发送）
            // neg2-probe 的恢复探测则直接标为 user_reply 恢复（本身没消息内容要补发）
            try {
              const chRow = db.prepare('SELECT id FROM channels WHERE bot_token = ? AND wechat_openid = ? LIMIT 1').get(botToken, userId);
              if (chRow?.id) {
                // 逐条补发：只触发最早到期的一条，其余保持 paused。
                // 用户每回复一次 → 触发一条补发 + 刷新 context_token，天然保活。
                // 旧版本无 paused 列，用 try-catch 降级（全部立即触发）。
                try {
                  const oldest = db.prepare(`
                    SELECT id FROM push_retry_queue
                    WHERE channel_id = ? AND status = 'pending' AND paused = 1
                    ORDER BY next_try_at ASC
                    LIMIT 1
                  `).get(chRow.id);
                  if (oldest) {
                    const r1 = db.prepare(`
                      UPDATE push_retry_queue
                      SET paused = 0, next_try_at = CURRENT_TIMESTAMP, triggered_by_reply = 1
                      WHERE id = ?
                    `).run(oldest.id);
                    console.log(`♻️ 用户回复: channel=${chRow.id} 触发 1 条补发（逐条模式，其余 ${db.prepare('SELECT COUNT(*) AS c FROM push_retry_queue WHERE channel_id = ? AND status = \'pending\' AND paused = 1').get(chRow.id).c} 条保持 paused）`);
                  }
                } catch (e) {
                  // 降级：无 paused 列时全部触发（兼容旧 schema）
                  db.prepare(`
                    UPDATE push_retry_queue
                    SET next_try_at = CURRENT_TIMESTAMP
                    WHERE channel_id = ? AND status = 'pending'
                  `).run(chRow.id);
                }
                const r2 = db.prepare(`UPDATE neg2_recovery_probe
                  SET recovered_at = CURRENT_TIMESTAMP, recovered_by = 'user_reply'
                  WHERE channel_id = ? AND recovered_at IS NULL AND gave_up_at IS NULL`).run(chRow.id);
                if (r2.changes > 0) {
                  console.log(`♻️ 用户回复: channel=${chRow.id} 触发 ${r2.changes} 条探测标 user_reply 恢复`);
                }
              }
            } catch (e) {
              console.error('用户回复复位失败:', e.message);
            }

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
              batchFiredFirstMessage = true;
              onFirstMessage(msg.context_token);
            }
          }
        }

        // 整批消息处理完后，统一回一次 ack（不论 N 条都只回 1 条）
        // 但若本批触发了 onFirstMessage（首条消息 → welcome 已包含"测试通过"反馈），则跳过 ack 避免重复
        if (batchHasUserText && batchChannelId && batchContextToken && !batchFiredFirstMessage) {
          maybeSendAck(batchChannelId, botToken, userId, batchContextToken);
        }

        // 补发续发：用户回复 → 检查是否有活跃补发引导，有则发下一条
        try {
          const ch = db.prepare('SELECT user_id, bot_token FROM channels WHERE id = ?').get(batchChannelId);
          if (ch) {
            const { resendNextMessage } = require('../routes/channels');
            resendNextMessage(batchChannelId, ch.user_id, botToken, userId, batchContextToken);
          }
        } catch (e) {
          console.error('补发续发失败:', e.message);
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
  // 手动注入 token = 管理员确认通道可用 → 全量复活（status/send_disabled/计数一起清）
  const rows = db.prepare(`SELECT id FROM channels WHERE wechat_openid = ?`).all(userId);
  db.prepare(`UPDATE channels SET context_token = ? WHERE wechat_openid = ?`).run(token, userId);
  try {
    const { reviveChannel } = require('./channel-health');
    rows.forEach(r => reviveChannel(r.id));
  } catch (e) {
    // channel-health 可能在循环依赖下加载失败；降级为最小更新
    db.prepare(`UPDATE channels SET status = 'active' WHERE wechat_openid = ?`).run(userId);
  }
  console.log(`✅ 手动设置 ${userId} 的 context_token`);
}

module.exports = { startMessagePoller, getContextToken, setContextToken, isChannelAlive, _heartbeat: pollerHeartbeat };
