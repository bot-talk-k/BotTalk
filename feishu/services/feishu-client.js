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
// 飞书无 10 条限流、无时间衰减、无需用户互动 → 纯单向推送,失败处理极简。

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

// 发文本消息. receiveIdType 默认 open_id,值可选: open_id / user_id / union_id / email / chat_id
// 返回 { code, msg, httpStatus, data }(code===0 即成功);凭证死会 throw(err.deadCredential=true)
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
      validateStatus: () => true,
    },
  );

  return {
    httpStatus: resp.status,
    code: resp.data && resp.data.code,
    msg: resp.data && resp.data.msg,
    data: resp.data && resp.data.data,
    deadCredential: isDeadCredentialCode(resp.data && resp.data.code),
  };
}

module.exports = { getTenantToken, sendText, isDeadCredentialCode, _tokenCache };
