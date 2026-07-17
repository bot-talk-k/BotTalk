// 飞书消息发送 — REST API,直接调用(不走任何 Gateway)
//
// 文档:
//   - tenant_access_token: https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
//   - im/v1/messages:       https://open.feishu.cn/document/server-docs/im-v1/message/create
//
// 域名区分:
//   - feishu (国内): https://open.feishu.cn
//   - lark   (海外): https://open.larksuite.com
//
// 飞书无微信 iLink 那种 10 条业务限流、无时间衰减、无需用户互动。
// 但**接口频控一直在**(2026-07-16 血账,见下方发送闸门):撞频控返回 code 9499 "too many request"。

const axios = require('axios');

const HOST_BY_DOMAIN = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

// 内存 token 缓存: key=`${appId}@${domain}` -> { token, expiresAt(ms) }
// 进程重启重新换 token(2h ttl),可接受
const _tokenCache = new Map();

// token 距过期不到 5 分钟视为需要刷新(避免临界过期失败)
const TOKEN_REFRESH_SLACK_MS = 5 * 60 * 1000;

// 凭证死(app 被删 / app_id/secret 无效)对应的飞书码 → 调用方据此把通道标 inactive 让用户重扫
// 参考飞书 auth 错误码: 10003 invalid app_id, 10014 invalid app_secret, 99991663/99991664 app 不存在/被停用
const DEAD_CREDENTIAL_CODES = new Set([10003, 10014, 99991663, 99991664]);

function isDeadCredentialCode(code) {
  return DEAD_CREDENTIAL_CODES.has(code);
}

// 飞书接口频控码。凭证/通道均健康,退避后可恢复 → 必须重试,不可当永久失败丢弃。
const THROTTLE_CODES = new Set([9499]);

function isThrottleCode(code) {
  return THROTTLE_CODES.has(code);
}

// ── 发送闸门(2026-07-16 加)──
//
// 飞书 im/v1/messages 频控(官方): 同一接收者 5 QPS;单应用 50 次/秒、1000 次/分钟。
//   https://open.feishu.cn/document/server-docs/im-v1/message/create
//
// 血账: 上游定时任务爱卡整点齐发 —— 通道 9 的 3 个行情任务同在北京 10:00 打同一个 open_id,
// 三条并发请求各自直冲飞书 → 全撞 9499。本站设计上无重试队列,9499 当瞬时失败落库即弃 =
// 消息静默永久丢失。故加两层: 闸门(不撞)+ 退避重试(撞了也能回来)。
//
// 闸门按接收者串行化并保最小间隔,把整点齐发摊开到频控线下。跨并发 HTTP 请求进程内生效。
const MIN_SEND_INTERVAL_MS = 250; // ≤4 QPS/接收者,压在飞书 5 QPS 下留余量
const SEND_RETRY_BACKOFF_MS = [500, 1000, 2000]; // 撞 9499/5xx 的有界退避

const _gateChains = new Map(); // gateKey -> 队尾 Promise
const _lastSentAt = new Map(); // gateKey -> 上次发送完成时刻(ms)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 同一 key 的调用串行执行,且与上一次发送间隔 ≥ MIN_SEND_INTERVAL_MS
function gated(key, fn) {
  const prev = _gateChains.get(key) || Promise.resolve();
  const next = prev.then(async () => {
    const wait = MIN_SEND_INTERVAL_MS - (Date.now() - (_lastSentAt.get(key) || 0));
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      _lastSentAt.set(key, Date.now());
    }
  });
  // 队尾吞错:一次失败不得毒化后续排队者
  const tail = next.then(() => {}, () => {});
  _gateChains.set(key, tail);
  // 队列排空后清理,避免 Map 随通道数长期累积
  tail.then(() => {
    if (_gateChains.get(key) === tail) {
      _gateChains.delete(key);
      _lastSentAt.delete(key);
    }
  });
  return next;
}

async function getTenantToken(appId, appSecret, domain = 'feishu') {
  const cacheKey = `${appId}@${domain}`;
  const cached = _tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_SLACK_MS) {
    return cached.token;
  }

  const host = HOST_BY_DOMAIN[domain] || HOST_BY_DOMAIN.feishu;
  const resp = await axios.post(
    `${host}/open-apis/auth/v3/tenant_access_token/internal`,
    { app_id: appId, app_secret: appSecret },
    { timeout: 10000, validateStatus: () => true },
  );

  if (!resp.data || resp.data.code !== 0 || !resp.data.tenant_access_token) {
    const err = new Error(
      `tenant_access_token failed: code=${resp.data && resp.data.code}, msg=${resp.data && resp.data.msg}`,
    );
    err.feishuCode = resp.data && resp.data.code;
    err.deadCredential = isDeadCredentialCode(resp.data && resp.data.code);
    throw err;
  }

  const token = resp.data.tenant_access_token;
  const ttlSec = resp.data.expire || 7200; // 一般 2h
  _tokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + ttlSec * 1000,
  });
  return token;
}

// 发一条消息(闸门 + 频控退避重试的唯一收窄点),msgType/content 由调用方按飞书格式给好。
// 返回 { code, msg, httpStatus, data, deadCredential, attempts };凭证死会 throw(err.deadCredential=true)
async function _sendMessage({ appId, appSecret, domain, receiveId, receiveIdType, msgType, content }) {
  if (!receiveId) throw new Error('receiveId required');
  const host = HOST_BY_DOMAIN[domain] || HOST_BY_DOMAIN.feishu;
  const url = `${host}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`;

  // 频控是按「同一接收者」算的 → 闸门也按接收者开
  return gated(`${appId}:${receiveId}`, async () => {
    let last;
    for (let attempt = 0; ; attempt++) {
      const token = await getTenantToken(appId, appSecret, domain);
      const resp = await axios.post(
        url,
        { receive_id: receiveId, msg_type: msgType, content },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          timeout: 15000,
          validateStatus: () => true,
        },
      );
      const code = resp.data && resp.data.code;
      last = {
        httpStatus: resp.status,
        code,
        msg: resp.data && resp.data.msg,
        data: resp.data && resp.data.data,
        deadCredential: isDeadCredentialCode(code),
        attempts: attempt + 1,
      };
      // 撞频控 / 飞书 5xx → 退避重试;其余(成功、凭证死、参数错)立即返回,重试无意义
      const retriable = isThrottleCode(code) || resp.status >= 500;
      if (!retriable || attempt >= SEND_RETRY_BACKOFF_MS.length) return last;
      await sleep(SEND_RETRY_BACKOFF_MS[attempt]);
    }
  });
}

// 发文本消息. receiveIdType 默认 open_id,值可选: open_id / user_id / union_id / email / chat_id
async function sendText({ appId, appSecret, domain, receiveId, receiveIdType = 'open_id', text }) {
  if (!text) throw new Error('text required');
  return _sendMessage({
    appId, appSecret, domain, receiveId, receiveIdType,
    msgType: 'text',
    content: JSON.stringify({ text }),
  });
}

// 发送卡片消息 (msg_type: interactive) — 支持标题/Markdown/分割线/按钮
// card 参数为飞书卡片 JSON 对象(不是字符串)
async function sendCard({ appId, appSecret, domain, receiveId, receiveIdType = 'open_id', card }) {
  return _sendMessage({
    appId, appSecret, domain, receiveId, receiveIdType,
    msgType: 'interactive',
    content: JSON.stringify(card),
  });
}

module.exports = {
  getTenantToken, sendText, sendCard,
  isDeadCredentialCode, isThrottleCode,
  _tokenCache, _gateChains,
};
