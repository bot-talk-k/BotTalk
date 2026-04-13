const db = require('../db');
const ilink = require('../ilink');
const { isChannelAlive } = require('./message-poller');

// 标记 sendMessage 成功 → 更新 last_send_success_at，重置 consecutive_neg2_count
function markSendSuccess(channelId) {
  if (!channelId) return;
  try {
    db.prepare(`
      UPDATE channels
      SET last_send_success_at = CURRENT_TIMESTAMP,
          consecutive_neg2_count = 0
      WHERE id = ?
    `).run(channelId);
  } catch (e) {
    console.error('markSendSuccess 错误:', e.message);
  }
}

// 标记 sendMessage 返回 ret:-2 → 累加 consecutive_neg2_count，记录时间
function markNeg2(channelId) {
  if (!channelId) return;
  try {
    db.prepare(`
      UPDATE channels
      SET consecutive_neg2_count = COALESCE(consecutive_neg2_count, 0) + 1,
          last_neg2_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(channelId);
  } catch (e) {
    console.error('markNeg2 错误:', e.message);
  }
}

// 根据 iLink 响应自动决定 mark*
// r: {errcode: 0, ...} → success；err 对象 → 根据 response.data.ret 判断
function markSendResult(channelId, resultOrErr, isSuccess) {
  if (!channelId) return;
  if (isSuccess) {
    markSendSuccess(channelId);
  } else {
    const ret = resultOrErr?.response?.data?.ret ?? resultOrErr?.ret;
    if (ret === -2) markNeg2(channelId);
    // ret:-14 / 其他失败不在 Batch 1 处理（Batch 2 会做分类）
  }
}

// 计算通道健康状态（三色）
// 返回 { health: 'green'|'yellow'|'red', reason: string, details: {...} }
function getChannelHealth(channel) {
  const hb = isChannelAlive(channel.bot_token);
  const now = Date.now();
  const lastSendOk = channel.last_send_success_at
    ? now - new Date(channel.last_send_success_at + 'Z').getTime()
    : null;
  const lastNeg2 = channel.last_neg2_at
    ? now - new Date(channel.last_neg2_at + 'Z').getTime()
    : null;
  const neg2Count = channel.consecutive_neg2_count || 0;
  const dbStatus = channel.status;

  const details = {
    poller_alive: hb.alive,
    poller_reason: hb.reason || null,
    last_send_ok_min: lastSendOk !== null ? Math.round(lastSendOk / 60000) : null,
    last_neg2_min: lastNeg2 !== null ? Math.round(lastNeg2 / 60000) : null,
    consecutive_neg2_count: neg2Count,
    db_status: dbStatus,
    send_disabled: !!channel.send_disabled,
    send_disabled_reason: channel.send_disabled_reason || null,
  };

  // 红：半死态（账号风控）、poller 挂、连续 3+ ret:-2、DB inactive
  if (channel.send_disabled) {
    return { health: 'red', reason: '半死态（能收不能发）：' + (channel.send_disabled_reason || '未知'), details };
  }
  if (!hb.alive) {
    return { health: 'red', reason: 'poller 心跳失效（' + (hb.reason || '未知') + '）', details };
  }
  if (neg2Count >= 3) {
    return { health: 'red', reason: `连续 ${neg2Count} 次 ret:-2，context_token 可能老化严重`, details };
  }
  if (dbStatus === 'inactive') {
    return { health: 'red', reason: '通道已标记为 inactive', details };
  }

  // 黄：poller 活但近期无成功 / 或最近有过 ret:-2 但 < 3 次
  if (neg2Count > 0 && lastNeg2 !== null && lastNeg2 < 60 * 60 * 1000) {
    return { health: 'yellow', reason: `最近 ${Math.round(lastNeg2/60000)} 分钟内出现 ${neg2Count} 次 ret:-2`, details };
  }
  if (lastSendOk !== null && lastSendOk > 4 * 60 * 60 * 1000) {
    return { health: 'yellow', reason: `${Math.round(lastSendOk/60000)} 分钟未推送成功（poller 仍活）`, details };
  }
  if (lastSendOk === null && dbStatus === 'active') {
    return { health: 'yellow', reason: '通道激活后尚无成功推送记录', details };
  }

  // 绿：poller 活 + 近期（4h 内）有成功推送 + 无最近 ret:-2
  return { health: 'green', reason: '正常', details };
}

// 当 sendMessage 返回 ret:-14 时，调用 getUpdates 二次确认 session 真伪
// 返回 { trueSessionDeath: boolean, sendDisabled: boolean }
//   - trueSessionDeath = true: session 彻底过期，bot_token 无效，需要用户重扫
//   - sendDisabled = true: "半死态"（能收不能发），bot_token 仍有效，通常是账号被 iLink 风控
async function classifyRet14(channelId, botToken) {
  try {
    // 用很短的 timeout 检查 getUpdates 是否也 ret:-14
    const result = await Promise.race([
      ilink.getUpdates(botToken, ''),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
    // 如果 getUpdates 能正常返回（包括长轮询超时正常结束），说明 session 活着
    // iLink.getUpdates 内部已对 ret:-14 抛异常，所以这里返回即认为是 session 活
    return { trueSessionDeath: false, sendDisabled: true };
  } catch (e) {
    if (e.message === 'timeout') {
      // 超时通常意味着长轮询挂住了——视为 session 还活（因为连接建立了）
      return { trueSessionDeath: false, sendDisabled: true };
    }
    if (e.code === 'SESSION_EXPIRED' || e.response?.data?.ret === -14) {
      return { trueSessionDeath: true, sendDisabled: false };
    }
    // 其他异常（网络等），保守视为未确认，标记 sendDisabled 让人工排查
    console.error('classifyRet14 异常:', e.message);
    return { trueSessionDeath: false, sendDisabled: true };
  }
}

// 标记"半死态"
function markSendDisabled(channelId, reason) {
  if (!channelId) return;
  try {
    db.prepare(`
      UPDATE channels
      SET send_disabled = 1,
          send_disabled_reason = ?,
          send_disabled_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reason || 'ret:-14 但 getUpdates 正常（可能账号被风控）', channelId);
  } catch (e) {
    console.error('markSendDisabled 错误:', e.message);
  }
}

// 清除"半死态"（比如通道重新扫码或人工干预后）
function clearSendDisabled(channelId) {
  if (!channelId) return;
  try {
    db.prepare(`
      UPDATE channels
      SET send_disabled = 0, send_disabled_reason = NULL, send_disabled_at = NULL
      WHERE id = ?
    `).run(channelId);
  } catch (e) {
    console.error('clearSendDisabled 错误:', e.message);
  }
}

module.exports = {
  markSendSuccess, markNeg2, markSendResult, getChannelHealth,
  classifyRet14, markSendDisabled, clearSendDisabled,
};
