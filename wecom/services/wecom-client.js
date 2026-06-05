// 单条企业微信智能机器人 WS 连接封装 — 基于 @wecom/aibot-node-sdk 的 WSClient。
// (源自原型 experiments/wecom/client.js,但去掉模块级单例;实例由 wecom-pool 管理)
//
// WSClient 内置: aibot_subscribe 鉴权 + 30s ping 心跳 + 断线自动重连(指数退避)。
// 这里只做: 创建实例、把事件归一化成回调、暴露 sendMarkdown。

const sdk = require('@wecom/aibot-node-sdk');
const WSClient = sdk.WSClient || (sdk.default && sdk.default.WSClient);

// 创建并连接一条 WS。handlers: { onAuthenticated, onDisconnected, onError, onCapture(userid) }
function createConnection({ botId, secret, onAuthenticated, onDisconnected, onError, onCapture }) {
  if (!WSClient) throw new Error('@wecom/aibot-node-sdk WSClient 未正确加载');
  const client = new WSClient({ botId, secret });

  client.on('authenticated', () => onAuthenticated && onAuthenticated());
  client.on('disconnected', (reason) => onDisconnected && onDisconnected(String(reason)));
  client.on('error', (err) => onError && onError(err && err.message ? err.message : String(err)));

  // 捕获 userid:单聊任意消息 或 enter_chat 事件
  client.on('message', (frame) => {
    const b = (frame && frame.body) || {};
    if (b.chattype === 'single' && b.from && b.from.userid) onCapture && onCapture(b.from.userid);
  });
  client.on('event.enter_chat', (frame) => {
    const b = (frame && frame.body) || {};
    if (b.from && b.from.userid) onCapture && onCapture(b.from.userid);
  });

  const wrapped = {
    get isConnected() { return !!client.isConnected; },
    // chatid 单聊填 userid
    sendMarkdown(chatid, content) {
      return client.sendMessage(chatid, { msgtype: 'markdown', markdown: { content } });
    },
    disconnect() { try { client.disconnect(); } catch (e) { /* ignore */ } },
    raw: client,
  };

  client.connect();
  return wrapped;
}

module.exports = { createConnection };
