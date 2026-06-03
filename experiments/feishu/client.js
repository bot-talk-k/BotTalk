// 飞书消息发送 — MVP 原型阶段 (REST API,直接调用,不走 OpenClaw Gateway)
//
// 文档:
//   - tenant_access_token: https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
//   - im/v1/messages:       https://open.feishu.cn/document/server-docs/im-v1/message/create
//
// 域名区分:
//   - feishu (国内): https://open.feishu.cn
//   - lark   (海外): https://open.larksuite.com

const axios = require('axios');

const HOST_BY_DOMAIN = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

// 内存 token 缓存: key=`${appId}@${domain}` -> { token, expiresAt(ms) }
// MVP 阶段不持久化,进程重启重新换 token,可接受
const _tokenCache = new Map();

// token 距过期不到 5 分钟视为需要刷新(避免临界过期失败)
const TOKEN_REFRESH_SLACK_MS = 5 * 60 * 1000;

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
    { timeout: 10000 },
  );

  if (!resp.data || resp.data.code !== 0 || !resp.data.tenant_access_token) {
    const err = new Error(
      `tenant_access_token failed: code=${resp.data && resp.data.code}, msg=${resp.data && resp.data.msg}`,
    );
    err.feishuResponse = resp.data;
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

// 发文本消息. receiveIdType 默认 open_id,值可选: open_id / user_id / union_id / email / chat_id
// 返回飞书 API 原始响应(便于诊断)
async function sendText({ appId, appSecret, domain, receiveId, receiveIdType = 'open_id', text }) {
  if (!receiveId) throw new Error('receiveId required');
  if (!text) throw new Error('text required');
  const host = HOST_BY_DOMAIN[domain] || HOST_BY_DOMAIN.feishu;
  const token = await getTenantToken(appId, appSecret, domain);

  const resp = await axios.post(
    `${host}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
    {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      timeout: 15000,
      // 不要让 4xx/非 0 业务码抛 axios 异常,我们要看完整 response
      validateStatus: () => true,
    },
  );

  return {
    httpStatus: resp.status,
    code: resp.data && resp.data.code,
    msg: resp.data && resp.data.msg,
    data: resp.data && resp.data.data,
    raw: resp.data,
  };
}

// MVP 工具: 列出 bot 所在的所有 chat,用于在没有 openId 时手动选 chat_id
// (用户在飞书里跟 bot 私聊一次后,bot 就有了这个 chat)
async function listChats({ appId, appSecret, domain }) {
  const host = HOST_BY_DOMAIN[domain] || HOST_BY_DOMAIN.feishu;
  const token = await getTenantToken(appId, appSecret, domain);
  const resp = await axios.get(`${host}/open-apis/im/v1/chats?page_size=20`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000,
    validateStatus: () => true,
  });
  return resp.data;
}

module.exports = { getTenantToken, sendText, listChats, _tokenCache };
