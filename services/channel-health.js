const db = require('../db');
const ilink = require('../ilink');
const { isChannelAlive } = require('./message-poller');

// 标记 sendMessage 成功 → 刷新 last_send_success_at + 全量复活通道
// （成功发送是最强的"通道现在可用"信号，同时清掉 send_disabled / 连续失败计数 /
//  把 status 拉回 active，避免"进去容易出来难"的不对称状态）
function markSendSuccess(channelId) {
  if (!channelId) return;
  try {
    db.prepare(`
      UPDATE channels
      SET last_send_success_at = CURRENT_TIMESTAMP,
          status = 'active',
          consecutive_neg2_count = 0,
          send_disabled = 0,
          send_disabled_reason = NULL,
          send_disabled_at = NULL
      WHERE id = ?
    `).run(channelId);
  } catch (e) {
    console.error('markSendSuccess 错误:', e.message);
  }
}

// 累计"连续确定性失败"计数（列名历史原因叫 consecutive_neg2_count，但语义
// 已扩展为任何 iLink 返回确定 ret 的失败——-2/-14/其它非 0 ret 都算）。
// 网络错误/超时不在此处理，因为无法区分是通道问题还是瞬时抖动。
function markSendFail(channelId) {
  if (!channelId) return;
  try {
    db.prepare(`
      UPDATE channels
      SET consecutive_neg2_count = COALESCE(consecutive_neg2_count, 0) + 1,
          last_neg2_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(channelId);
  } catch (e) {
    console.error('markSendFail 错误:', e.message);
  }
}
// 向后兼容别名（之前叫 markNeg2）
const markNeg2 = markSendFail;

// 防止同一通道被并发触发 classifyRet14（两次 getUpdates 会互相抢长轮询位）
const classifyInFlight = new Map(); // channelId -> Promise<{tokenInvalid, sendDisabled}>

// -14 分类 + 落库的统一入口。任何 send 路径拿到 -14 都走这里，保证：
// 1) 不会并发调 classifyRet14（同通道在跑时后来者复用同一 Promise）
// 2) 分类结果一致落库（真死 → status=inactive；半死态 → send_disabled=1）
// 返回 { tokenInvalid, sendDisabled }，调用方可据此做同步决策（比如 notify.js 的 shouldRetry）。
async function classifyAndMarkRet14(channelId, botToken) {
  if (!channelId || !botToken) return { tokenInvalid: false, sendDisabled: false };
  if (classifyInFlight.has(channelId)) return classifyInFlight.get(channelId);
  const p = (async () => {
    try {
      const cls = await classifyRet14(channelId, botToken);
      if (cls.trueSessionDeath) {
        db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channelId);
        console.error(`⚠️ 通道 ${channelId} session 真失效（getUpdates 也 ret:-14），标记 inactive`);
        return { tokenInvalid: true, sendDisabled: false };
      }
      if (cls.sendDisabled) {
        markSendDisabled(channelId, '账号可能被 iLink 风控（sendMessage -14 但 getUpdates 正常）');
        console.error(`⚠️ 通道 ${channelId} 半死态：能收不能发（账号可能未实名/被风控）`);
        return { tokenInvalid: false, sendDisabled: true };
      }
      return { tokenInvalid: false, sendDisabled: false };
    } catch (e) {
      console.error('classifyAndMarkRet14 异常，保守当 session 死:', e.message);
      db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channelId);
      return { tokenInvalid: true, sendDisabled: false };
    } finally {
      classifyInFlight.delete(channelId);
    }
  })();
  classifyInFlight.set(channelId, p);
  return p;
}

// 根据 iLink 响应自动落库。
// - 成功 → markSendSuccess（顺便复活通道）
// - 失败：
//     · 无 ret（网络/超时）→ 不改状态，避免瞬时抖动误判
//     · ret === 0（理论不会走到失败分支）→ 忽略
//     · 其它确定性 ret → markSendFail（累加计数，yellow/red 兜底）
//     · ret === -14 → 额外触发 classifyAndMarkRet14（fire-and-forget，
//       注意此处不 await，调用方如果需要 sync 判定 tokenInvalid，
//       应直接 await classifyAndMarkRet14 自己处理）
function markSendResult(channelId, resultOrErr, isSuccess) {
  if (!channelId) return;
  if (isSuccess) {
    markSendSuccess(channelId);
    return;
  }
  const ret = resultOrErr?.response?.data?.ret ?? resultOrErr?.ret;
  if (ret === null || ret === undefined) return; // 网络/超时不落状态
  if (ret === 0) return;
  markSendFail(channelId);
  if (ret === -14) {
    try {
      const row = db.prepare('SELECT bot_token FROM channels WHERE id = ?').get(channelId);
      if (row?.bot_token) {
        classifyAndMarkRet14(channelId, row.bot_token).catch(e =>
          console.error('markSendResult -14 分类失败:', e.message));
      }
    } catch (e) {
      console.error('markSendResult 查 bot_token 失败:', e.message);
    }
  }
}

// 非发送路径的通道复活（例如重扫绑定、手动 setContextToken）：
// 把 status/send_disabled/连续失败计数一次性复位到"干净的活通道"状态。
function reviveChannel(channelId) {
  if (!channelId) return;
  try {
    db.prepare(`
      UPDATE channels
      SET status = 'active',
          consecutive_neg2_count = 0,
          send_disabled = 0,
          send_disabled_reason = NULL,
          send_disabled_at = NULL
      WHERE id = ?
    `).run(channelId);
  } catch (e) {
    console.error('reviveChannel 错误:', e.message);
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

  const lastInbound = channel.last_inbound_at
    ? now - new Date(channel.last_inbound_at + 'Z').getTime()
    : null;
  const details = {
    poller_alive: hb.alive,
    poller_reason: hb.reason || null,
    last_send_ok_min: lastSendOk !== null ? Math.round(lastSendOk / 60000) : null,
    last_neg2_min: lastNeg2 !== null ? Math.round(lastNeg2 / 60000) : null,
    last_inbound_min: lastInbound !== null ? Math.round(lastInbound / 60000) : null,
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
    return { health: 'red', reason: `连续 ${neg2Count} 次发送失败（-2/-14/其它确定 ret）`, details };
  }
  if (dbStatus === 'inactive') {
    return { health: 'red', reason: '通道已标记为 inactive', details };
  }

  // 黄：poller 活但近期无成功 / 或最近有过 ret:-2 但 < 3 次
  if (neg2Count > 0 && lastNeg2 !== null && lastNeg2 < 60 * 60 * 1000) {
    return { health: 'yellow', reason: `最近 ${Math.round(lastNeg2/60000)} 分钟内发送失败 ${neg2Count} 次`, details };
  }
  // "长时间无成功推送"判黄之前，先给"用户最近回复过"一个豁免：
  //   用户回复会刷新 context_token，24h 内回过就不算异常（低流量用户不应被持续判黄）
  const inboundFresh = lastInbound !== null && lastInbound < 24 * 60 * 60 * 1000;
  if (lastSendOk !== null && lastSendOk > 4 * 60 * 60 * 1000 && !inboundFresh) {
    return { health: 'yellow', reason: `${Math.round(lastSendOk/60000)} 分钟未推送成功，用户也长时间未回复`, details };
  }
  if (lastSendOk === null && dbStatus === 'active' && !inboundFresh) {
    return { health: 'yellow', reason: '通道激活后尚无成功推送记录，用户也未回复过', details };
  }

  // 绿：(4h 内成功推送 OR 24h 内用户回复过) + poller 活 + 无最近 ret:-2
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
  markSendSuccess, markNeg2, markSendFail, markSendResult, getChannelHealth,
  classifyRet14, classifyAndMarkRet14, markSendDisabled, clearSendDisabled,
  reviveChannel,
};
