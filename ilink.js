const axios = require('axios');
const crypto = require('crypto');

const BASE_URL = 'https://ilinkai.weixin.qq.com';

function getHeaders(botToken) {
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString('base64'),
    'Authorization': `Bearer ${botToken}`
  };
}

// 生成 client_id
function generateClientId() {
  return 'bottalk_' + crypto.randomBytes(8).toString('hex');
}

// 获取登录二维码
async function getQRCode() {
  const res = await axios.get(`${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`);
  console.log('📋 getQRCode 响应:', JSON.stringify(res.data).substring(0, 200));
  return res.data;
}

// 查询扫码状态
async function checkQRStatus(qrcode) {
  const res = await axios.get(`${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${qrcode}`);
  console.log('📋 checkQRStatus 响应:', JSON.stringify(res.data).substring(0, 300));
  return res.data;
}

// 长轮询收消息（35 秒超时）
async function getUpdates(botToken, cursor = '') {
  const headers = getHeaders(botToken);
  const body = {
    get_updates_buf: cursor,
    base_info: { channel_version: '1.0.2' }
  };
  
  console.log('🔄 getUpdates 请求:', { cursor: cursor.substring(0, 50) + '...' });
  
  try {
    const startTime = Date.now();
    const res = await axios.post(`${BASE_URL}/ilink/bot/getupdates`, body, { 
      headers,
      timeout: 40000
    });
    const duration = Date.now() - startTime;
    
    console.log(`📥 getUpdates 响应 (${duration}ms):`, JSON.stringify({
      ret: res.data.ret,
      has_msgs: res.data.msgs && res.data.msgs.length > 0,
      msg_count: res.data.msgs ? res.data.msgs.length : 0,
      has_cursor: !!res.data.get_updates_buf,
      cursor_preview: res.data.get_updates_buf ? res.data.get_updates_buf.substring(0, 50) + '...' : null
    }));
    
    if (res.data.msgs && res.data.msgs.length > 0) {
      console.log('📨 消息详情:', res.data.msgs.map(m => ({
        from: m.from_user_id,
        type: m.message_type,
        has_context_token: !!m.context_token
      })));
    }
    
    // 检测 session 过期
    if (res.data.ret === -14) {
      const err = new Error('iLink session 已过期 (ret: -14)');
      err.code = 'SESSION_EXPIRED';
      err.response = { status: res.status, data: res.data };
      throw err;
    }

    return res.data;
  } catch (error) {
    console.error('❌ getUpdates 错误:', error.message);
    if (error.response) {
      console.error('响应状态:', error.response.status);
      console.error('响应数据:', JSON.stringify(error.response.data).substring(0, 500));
    }
    // 重新抛出 session 过期错误，让调用方处理
    if (error.code === 'SESSION_EXPIRED') throw error;
    return { get_updates_buf: cursor, msgs: [] };
  }
}


// 发送消息（带完整请求体，包含 client_id）
async function sendMessage(botToken, userId, message, contextToken = '') {
  const clientId = generateClientId();
  const headers = getHeaders(botToken);
  const body = {
    msg: {
      to_user_id: userId,
      from_user_id: botToken.split('@')[0] + '@im.bot',
      client_id: clientId,  // 关键修复：添加 client_id
      message_type: 2,  // 必须是 2 (BOT)
      message_state: 2,
      context_token: contextToken || undefined,  // 空字符串传 undefined
      item_list: [{ type: 1, text_item: { text: message } }]
    },
    base_info: { channel_version: '1.0.2' }
  };
  
  console.log('📤 sendMessage 请求:', JSON.stringify({
    client_id: clientId,
    to: userId,
    message: message.substring(0, 50),
    context_token: contextToken ? contextToken.substring(0, 50) + '...' : '(空)',
    has_base_info: !!body.base_info
  }));
  
  try {
    const startTime = Date.now();
    const res = await axios.post(`${BASE_URL}/ilink/bot/sendmessage`, body, { headers, timeout: 30000 });
    const duration = Date.now() - startTime;
    
    console.log(`✅ sendMessage 响应 (${duration}ms):`, JSON.stringify({
      status: res.status,
      data: res.data
    }));

    // iLink 可能返回 ret 或 errcode 字段表示业务失败
    const ret = res.data.ret;
    const errcode = res.data.errcode;
    const errmsg = res.data.errmsg || res.data.msg || '';
    if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
      const code = ret !== undefined && ret !== 0 ? ret : errcode;
      const err = new Error(`iLink 业务错误: code=${code}, msg=${errmsg}`);
      err.response = { status: res.status, data: { ret: code, errcode: code, msg: errmsg } };
      throw err;
    }

    // 构造标准化的响应记录
    return {
      errcode: res.data.ret || 0,
      errmsg: res.data.msg || 'ok',
      http_status: res.status,
      duration_ms: duration,
      ...(res.data.msgid ? { msgid: res.data.msgid } : {}),
    };
  } catch (error) {
    console.error('❌ sendMessage 错误:', error.message);
    if (error.response) {
      console.error('响应状态:', error.response.status);
      console.error('响应头:', JSON.stringify(error.response.headers));
      console.error('响应数据:', JSON.stringify(error.response.data).substring(0, 500));
    }
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  图片发送：getUploadUrl → AES-128-ECB 加密上传 CDN → sendMessage(image_item)
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');

function aesEcbPaddedSize(n) { return Math.ceil((n + 1) / 16) * 16; }

async function uploadImageToCdn(botToken, toUserId, filePath) {
  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskey = crypto.randomBytes(16);

  const headers = getHeaders(botToken);
  const resp = await axios.post(`${BASE_URL}/ilink/bot/getuploadurl`, {
    filekey,
    media_type: 1,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex'),
    base_info: { channel_version: '1.0.2' },
  }, { headers, timeout: 15000 });

  const uploadFullUrl = resp.data.upload_full_url?.trim();
  const uploadParam = resp.data.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error('getUploadUrl: 未返回上传 URL，resp=' + JSON.stringify(resp.data));
  }

  const cdnUrl = uploadFullUrl || (() => {
    const cdnBase = process.env.ILINK_CDN_BASE || 'https://novac2c.cdn.weixin.qq.com/c2c';
    return `${cdnBase}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  })();

  const cipher = crypto.createCipheriv('aes-128-ecb', aeskey, null);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  console.log(`📤 CDN 上传: filekey=${filekey} size=${ciphertext.length} url=${cdnUrl.substring(0, 80)}...`);

  const cdnResp = await axios.post(cdnUrl, ciphertext, {
    headers: { 'Content-Type': 'application/octet-stream' },
    timeout: 30000,
    maxBodyLength: Infinity,
  });

  const downloadParam = cdnResp.headers['x-encrypted-param'];
  if (!downloadParam) {
    throw new Error('CDN 上传成功但缺少 x-encrypted-param 头');
  }

  console.log(`✅ CDN 上传完成: filekey=${filekey}`);
  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskeyHex: aeskey.toString('hex'),
    fileSizeCiphertext: filesize,
  };
}

async function sendImage(botToken, userId, filePath, contextToken) {
  const uploaded = await uploadImageToCdn(botToken, userId, filePath);
  const clientId = generateClientId();
  const headers = getHeaders(botToken);
  const body = {
    msg: {
      to_user_id: userId,
      from_user_id: botToken.split('@')[0] + '@im.bot',
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken || undefined,
      item_list: [{
        type: 2,
        image_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            aes_key: Buffer.from(uploaded.aeskeyHex).toString('base64'),
            encrypt_type: 1,
          },
          mid_size: uploaded.fileSizeCiphertext,
        },
      }],
    },
    base_info: { channel_version: '1.0.2' },
  };

  console.log(`📤 sendImage: to=${userId} filekey=${uploaded.filekey}`);
  const res = await axios.post(`${BASE_URL}/ilink/bot/sendmessage`, body, { headers, timeout: 30000 });

  const ret = res.data.ret;
  const errcode = res.data.errcode;
  const errmsg = res.data.errmsg || res.data.msg || '';
  if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
    const code = ret !== undefined && ret !== 0 ? ret : errcode;
    const err = new Error(`sendImage 业务错误: code=${code}, msg=${errmsg}`);
    err.response = { status: res.status, data: { ret: code, errcode: code, msg: errmsg } };
    throw err;
  }

  console.log(`✅ sendImage 成功: to=${userId}`);
  return { errcode: 0, errmsg: 'ok', http_status: res.status };
}

module.exports = { getQRCode, checkQRStatus, sendMessage, sendImage, getUpdates };
