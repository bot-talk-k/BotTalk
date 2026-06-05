// 企业微信智能机器人 — WebSocket 长连接 client(MVP 原型阶段)
//
// 依据: @wecom/aibot-node-sdk v1.0.7 的 WSClient
//   端点: wss://openws.work.weixin.qq.com
//   鉴权: aibot_subscribe { bot_id, secret }(SDK connect() 后自动发)
//   心跳: ping 每 30s(SDK 内置)
//   主动发: aibot_send_msg(SDK client.sendMessage(chatid, body))
//   收消息: aibot_msg_callback → 'message' 事件
//   事件:   aibot_event_callback → 'event.enter_chat' 等
//
// 与飞书的根本差异: 飞书是无状态 REST(每条独立换 token + POST),
// 企业微信智能机器人是 *有状态 WebSocket 长连接*。所以本进程维持一条单例连接。
//
// 关键: 浏览器扫码 SDK 只返回 {botid, secret},*不返回发送目标 userid*。
// 主动推送需要单聊 chatid(= userid),只能从 enter_chat 事件或用户首条消息里捕获。
// 所以原型流程: 扫码绑定 → 用户在企业微信打开机器人并发一句话 → 抓到 userid → 才能发。

const sdk = require('@wecom/aibot-node-sdk');
// cjs 命名导出兼容(default 是 { WSClient })
const WSClient = sdk.WSClient || (sdk.default && sdk.default.WSClient);

let _client = null;

// 模块级状态(原型只测一个 bot,够用)
let _state = {
  botId: null,
  startedAt: null,
  connected: false, // WS open
  authenticated: false, // aibot_subscribe 成功
  lastError: null,
  capturedUserId: null, // 单聊 userid,主动推送用
  inbound: [], // 最近收到的消息(证明双向/无限接收)
  events: [], // 最近事件(enter_chat / disconnected / reconnecting ...)
};

function nowISO() {
  return new Date().toISOString();
}

function pushCapped(arr, item, cap = 100) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

// 建立(或重建)长连接
function connect({ botId, secret }) {
  if (!WSClient) throw new Error('@wecom/aibot-node-sdk WSClient 未正确加载');
  if (!botId || !secret) throw new Error('botId / secret 缺失');

  if (_client) {
    try {
      _client.disconnect();
    } catch (e) {
      /* ignore */
    }
    _client = null;
  }

  // 保留上次抓到的 userid(同一个人重连不必再触发 enter_chat)
  const keepUserId = _state.botId === botId ? _state.capturedUserId : null;
  _state = {
    botId,
    startedAt: nowISO(),
    connected: false,
    authenticated: false,
    lastError: null,
    capturedUserId: keepUserId,
    inbound: [],
    events: [],
  };

  const client = new WSClient({ botId, secret });

  client.on('connected', () => {
    _state.connected = true;
  });
  client.on('authenticated', () => {
    _state.authenticated = true;
    _state.lastError = null;
    pushCapped(_state.events, { at: nowISO(), type: 'authenticated' });
  });
  client.on('disconnected', (reason) => {
    _state.connected = false;
    _state.authenticated = false;
    pushCapped(_state.events, { at: nowISO(), type: 'disconnected', reason: String(reason) });
  });
  client.on('reconnecting', (attempt) => {
    pushCapped(_state.events, { at: nowISO(), type: 'reconnecting', attempt });
  });
  client.on('error', (err) => {
    _state.lastError = err && err.message ? err.message : String(err);
    pushCapped(_state.events, { at: nowISO(), type: 'error', error: _state.lastError });
  });

  // 任意收到的消息 → 抓 userid(单聊) + 记日志
  client.on('message', (frame) => {
    const body = (frame && frame.body) || {};
    const userid = body.from && body.from.userid;
    if (userid && body.chattype === 'single') _state.capturedUserId = userid;
    let text = '';
    if (body.msgtype === 'text' && body.text) text = body.text.content;
    else if (body.msgtype === 'voice' && body.voice) text = `[语音转文字] ${body.voice.content || ''}`;
    pushCapped(_state.inbound, {
      at: nowISO(),
      msgid: body.msgid,
      chattype: body.chattype,
      userid,
      msgtype: body.msgtype,
      text,
    });
  });

  // 进入会话事件(用户当天首次进入单聊)→ 抓 userid
  client.on('event.enter_chat', (frame) => {
    const body = (frame && frame.body) || {};
    const userid = body.from && body.from.userid;
    if (userid) _state.capturedUserId = userid;
    pushCapped(_state.events, { at: nowISO(), type: 'enter_chat', userid });
  });

  client.connect();
  _client = client;
  return getState();
}

// 主动推送 markdown 消息. chatid 单聊填 userid.
async function sendMarkdown(chatid, content) {
  if (!_client) throw new Error('WS 未连接 — 先绑定/连接');
  if (!_client.isConnected) throw new Error('WS 未就绪(connecting / reconnecting),稍候再试');
  if (!chatid) throw new Error('chatid 缺失 — 需先在企业微信打开机器人会话以捕获 userid');
  const resp = await _client.sendMessage(chatid, {
    msgtype: 'markdown',
    markdown: { content },
  });
  return resp; // { headers, errcode, errmsg }
}

function getState() {
  return {
    botId: _state.botId,
    startedAt: _state.startedAt,
    connected: _state.connected,
    authenticated: _state.authenticated,
    isConnected: !!(_client && _client.isConnected),
    lastError: _state.lastError,
    capturedUserId: _state.capturedUserId,
    inbound: _state.inbound,
    events: _state.events,
  };
}

function disconnect() {
  if (_client) {
    try {
      _client.disconnect();
    } catch (e) {
      /* ignore */
    }
    _client = null;
  }
  _state.connected = false;
  _state.authenticated = false;
}

module.exports = { connect, sendMarkdown, getState, disconnect };
