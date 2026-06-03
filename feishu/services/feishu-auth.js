// 飞书 Device Flow OAuth 封装
//
// 依据: @larksuite/openclaw-lark-tools v1.0.46(飞书官方 npm,ISC 协议)
// 端点: POST /oauth/v1/app/registration (archetype=PersonalAgent)
//
// 用户扫码后,飞书代用户创建飞书 app + 返回 client_id / client_secret 给客户端,
// 用户完全不接触 open.feishu.cn 后台。每次扫码 = 一个全新 app(= 一个通道)。
//
// 身份说明(已核实 lark-tools PollResponse 契约):
//   user_info 只含 { open_id, tenant_brand },open_id 是 per-app 的,
//   不能跨 app 稳定标识同一人 → 用户身份用本站 SendKey/session,不依赖 open_id 重认。

// 懒加载避免启动开销;返回的是 ES module 的命名导出
let _module = null;
async function getAuthModule() {
  if (!_module) {
    _module = await import('@larksuite/openclaw-lark-tools/dist/utils/feishu-auth.js');
  }
  return _module;
}

// 启动 Device Flow:返回二维码 URL + deviceCode (后续轮询用)
// isLark=false 走国内飞书,isLark=true 走海外 Lark
async function startQrcode(isLark = false) {
  const { FeishuAuth } = await getAuthModule();
  const auth = new FeishuAuth();
  auth.setDomain(!!isLark);
  await auth.init();
  const resp = await auth.begin();
  return {
    url: resp.verification_uri_complete, // 用于渲染 QR 的 URL
    deviceCode: resp.device_code,
    interval: resp.interval || 5, // 推荐轮询间隔(秒)
    expireIn: resp.expire_in || 300, // 二维码有效期(秒)
  };
}

// 轮询绑定结果。authorization_pending / slow_down → 仍未完成,前端继续轮询;
// 成功 → 返回 { done:true, appId, appSecret, domain, openId }
// 失败 → 返回 { done:false, error }
async function pollBind(deviceCode, isLark = false) {
  const { FeishuAuth } = await getAuthModule();
  const auth = new FeishuAuth();
  auth.setDomain(!!isLark);
  const resp = await auth.poll(deviceCode);

  if (resp.error) {
    if (resp.error === 'authorization_pending' || resp.error === 'slow_down') {
      return { done: false };
    }
    return { done: false, error: resp.error_description || resp.error };
  }

  if (resp.client_id && resp.client_secret) {
    const domain = resp.user_info && resp.user_info.tenant_brand === 'lark' ? 'lark' : 'feishu';
    const openId = resp.user_info && resp.user_info.open_id;
    return {
      done: true,
      appId: resp.client_id,
      appSecret: resp.client_secret,
      domain,
      openId, // 该 app 下用户的 open_id — 作为 sendText 的 receive_id
    };
  }

  return { done: false };
}

// 用 appId+appSecret 试着换 tenant_access_token,验证凭证是否有效
async function validateCredentials(appId, appSecret) {
  const { validateAppCredentials } = await getAuthModule();
  try {
    return await validateAppCredentials(appId, appSecret);
  } catch (e) {
    return false;
  }
}

module.exports = { startQrcode, pollBind, validateCredentials };
