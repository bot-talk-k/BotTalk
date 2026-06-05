(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
    typeof define === 'function' && define.amd ? define(['exports'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.WecomAIBotSDK = {}));
})(this, (function (exports) { 'use strict';

    /** 消息类型常量 */
    const MESSAGE_TYPE = {
        QR_CODE_READY: 'QR_CODE_READY',
        AUTH_SUCCESS: 'AUTH_SUCCESS',
        AUTH_ERROR: 'AUTH_ERROR',
        AUTH_CANCEL: 'AUTH_CANCEL',
        WINDOW_CLOSE: 'WINDOW_CLOSE',
    };
    /** 错误码常量 */
    const ERROR_CODE = {
        WINDOW_BLOCKED: 'WINDOW_BLOCKED',
        INVALID_APP_ID: 'INVALID_APP_ID',
        ACCESS_DENIED: 'ACCESS_DENIED',
        AUTH_TIMEOUT: 'AUTH_TIMEOUT',
        CANCELLED: 'CANCELLED',
    };
    /** 默认配置 */
    const DEFAULT_CONFIG = {
        authOrigin: 'https://work.weixin.qq.com',
        width: 950,
        height: 640,
        debug: false,
    };
    /** 窗口关闭轮询间隔（毫秒） */
    const POLLING_INTERVAL = 500;

    /**
     * 轻量级事件发射器
     * 负责 SDK 内部事件的注册、触发和移除
     */
    class EventEmitter {
        constructor() {
            this.handlers = new Map();
        }
        /**
         * 注册事件监听
         * @param event - 事件名
         * @param handler - 事件处理函数
         */
        on(event, handler) {
            const list = this.handlers.get(event) || [];
            list.push(handler);
            this.handlers.set(event, list);
            return this;
        }
        /**
         * 移除事件监听
         * @param event - 事件名
         * @param handler - 指定处理函数，不传则移除该事件所有监听
         */
        off(event, handler) {
            if (!handler) {
                this.handlers.delete(event);
                return this;
            }
            const list = this.handlers.get(event);
            if (list) {
                const filtered = list.filter(h => h !== handler);
                if (filtered.length > 0) {
                    this.handlers.set(event, filtered);
                }
                else {
                    this.handlers.delete(event);
                }
            }
            return this;
        }
        /**
         * 触发事件
         * @param event - 事件名
         * @param args - 传递给处理函数的参数
         */
        emit(event, ...args) {
            const list = this.handlers.get(event);
            if (list) {
                list.forEach(handler => {
                    try {
                        handler(...args);
                    }
                    catch (e) {
                        console.error(`[WecomAIBotSDK] Event handler error for "${event}":`, e);
                    }
                });
            }
        }
        /** 移除所有事件监听 */
        removeAll() {
            this.handlers.clear();
        }
        /** 获取某事件的监听器数量（主要用于测试） */
        listenerCount(event) {
            var _a, _b;
            return (_b = (_a = this.handlers.get(event)) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0;
        }
    }

    /**
     * 企业微信 AI Bot 授权 SDK
     *
     * 基于 Popup Window + PostMessage 跨窗口通信机制，
     * 实现外部网页与独立授权窗口的交互。
     */
    class WecomAIBotSDK {
        constructor() {
            this.authWindow = null;
            this.pollingTimer = null;
            this.messageListener = null;
            this.config = { ...DEFAULT_CONFIG };
            this.emitter = new EventEmitter();
            this.setupMessageListener();
        }
        /**
         * 打开机器人信息授权窗口
         *
         * 同时支持回调风格和 Promise 风格：
         * - 回调：通过 onCreated / onError 获取结果
         * - Promise：通过 .then() / .catch() 或 await 获取结果
         */
        openBotInfoAuthWindow(options) {
            var _a;
            this.validateOptions(options);
            this.mergeConfig(options);
            const state = options.state || this.generateState();
            const authUrl = this.buildAuthUrl(options.source, state);
            const windowFeatures = this.buildWindowFeatures();
            this.authWindow = window.open(authUrl, 'WecomAIBotAuthWindow', windowFeatures);
            if (!this.authWindow) {
                const error = {
                    code: ERROR_CODE.WINDOW_BLOCKED,
                    message: '弹窗被拦截，请允许弹窗或点击手动打开',
                };
                this.emitter.emit('error', error);
                (_a = options.onError) === null || _a === void 0 ? void 0 : _a.call(options, error);
                return Promise.reject(error);
            }
            this.startPolling();
            return new Promise((resolve, reject) => {
                const cleanup = () => {
                    this.emitter.off('success', onSuccess);
                    this.emitter.off('error', onError);
                    this.emitter.off('cancel', onCancel);
                };
                const onSuccess = (bot) => {
                    cleanup();
                    resolve(bot);
                };
                const onError = (err) => {
                    cleanup();
                    reject(err);
                };
                const onCancel = () => {
                    cleanup();
                    reject({ code: ERROR_CODE.CANCELLED, message: '用户取消授权' });
                };
                this.emitter.on('success', onSuccess);
                this.emitter.on('error', onError);
                this.emitter.on('cancel', onCancel);
                if (options.onCreated) {
                    this.emitter.on('success', options.onCreated);
                }
                if (options.onError) {
                    this.emitter.on('error', options.onError);
                }
            });
        }
        /** 手动关闭授权窗口 */
        closeWindow() {
            if (this.authWindow && !this.authWindow.closed) {
                this.authWindow.close();
            }
            this.authWindow = null;
            this.stopPolling();
        }
        /** 销毁 SDK 实例，释放所有资源 */
        destroy() {
            this.closeWindow();
            this.removeMessageListener();
            this.emitter.removeAll();
            this.log('SDK destroyed');
        }
        /** 注册事件监听 */
        on(event, handler) {
            this.emitter.on(event, handler);
            return this;
        }
        /** 移除事件监听 */
        off(event, handler) {
            this.emitter.off(event, handler);
            return this;
        }
        // ========== 私有方法 ==========
        validateOptions(options) {
            if (!options.source) {
                throw new Error(`[WecomAIBotSDK] source is required`);
            }
        }
        mergeConfig(options) {
            if (options.authOrigin) {
                this.config.authOrigin = options.authOrigin;
            }
            if (options.width != null) {
                this.config.width = options.width;
            }
            if (options.height != null) {
                this.config.height = options.height;
            }
            if (options.debug != null) {
                this.config.debug = options.debug;
            }
        }
        buildAuthUrl(source, state) {
            const params = new URLSearchParams({
                source,
                state,
                timestamp: String(Date.now()),
            });
            return `${this.config.authOrigin}/ai/qc/gen?${params.toString()}`;
        }
        buildWindowFeatures() {
            const { width, height } = this.config;
            const left = (window.screen.width - width) / 2;
            const top = (window.screen.height - height) / 2;
            return [
                `width=${width}`,
                `height=${height}`,
                `left=${left}`,
                `top=${top}`,
                'resizable=false',
                'scrollbars=false',
                'status=no',
                'toolbar=no',
                'menubar=no',
                'location=no',
            ].join(',');
        }
        generateState() {
            return `state_${Math.random().toString(36).substring(2, 11)}_${Date.now()}`;
        }
        setupMessageListener() {
            this.messageListener = (event) => {
                var _a;
                if (event.origin !== this.config.authOrigin) {
                    this.log('Message from unknown origin:', event.origin);
                    return;
                }
                const data = event.data;
                if (!data || !data.type) {
                    return;
                }
                this.log('Message received:', data.type, data.payload);
                switch (data.type) {
                    case MESSAGE_TYPE.QR_CODE_READY: {
                        this.emitter.emit('ready', data.payload);
                        break;
                    }
                    case MESSAGE_TYPE.AUTH_SUCCESS: {
                        this.emitter.emit('success', data.payload);
                        this.closeWindow();
                        break;
                    }
                    case MESSAGE_TYPE.AUTH_ERROR: {
                        const error = ((_a = data.payload) === null || _a === void 0 ? void 0 : _a.error) || data.payload;
                        this.emitter.emit('error', error);
                        this.closeWindow();
                        break;
                    }
                    case MESSAGE_TYPE.AUTH_CANCEL: {
                        this.emitter.emit('cancel', null);
                        this.closeWindow();
                        break;
                    }
                    case MESSAGE_TYPE.WINDOW_CLOSE: {
                        this.closeWindow();
                        break;
                    }
                }
            };
            window.addEventListener('message', this.messageListener);
        }
        removeMessageListener() {
            if (this.messageListener) {
                window.removeEventListener('message', this.messageListener);
                this.messageListener = null;
            }
        }
        startPolling() {
            this.stopPolling();
            this.pollingTimer = setInterval(() => {
                var _a;
                if ((_a = this.authWindow) === null || _a === void 0 ? void 0 : _a.closed) {
                    this.stopPolling();
                    this.authWindow = null;
                    this.emitter.emit('cancel', null);
                }
            }, POLLING_INTERVAL);
        }
        stopPolling() {
            if (this.pollingTimer) {
                clearInterval(this.pollingTimer);
                this.pollingTimer = null;
            }
        }
        log(...args) {
            if (this.config.debug) {
                console.log('[WecomAIBotSDK]', ...args);
            }
        }
    }

    // 创建单例并挂载到全局（UMD 场景下通过 <script> 标签引入时使用）
    const sdk = new WecomAIBotSDK();
    if (typeof window !== 'undefined') {
        window.WecomAIBotSDK = sdk;
    }

    exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
    exports.ERROR_CODE = ERROR_CODE;
    exports.MESSAGE_TYPE = MESSAGE_TYPE;
    exports.WecomAIBotSDK = WecomAIBotSDK;
    exports.default = sdk;

    Object.defineProperty(exports, '__esModule', { value: true });

}));
//# sourceMappingURL=wecom-aibot-sdk.umd.js.map
