/**
 * BotTalk push client -- Tier 1 SDK (Node.js).
 *
 * Zero external dependencies (uses only built-in fetch).
 */

import {
  BotTalkError,
  InvalidKeyError,
  NoChannelError,
  EmptyMessageError,
  RateLimitError,
  PushFailedError,
  NetworkError,
} from './errors.ts';
import { PushResult, type BotTalkOptions, type SendOptions, type ApiResponse } from './types.ts';

/**
 * Map server error codes to SDK exception constructors.
 * 50001 is handled specially in _request to thread through reason + hint.
 */
const CODE_TO_ERROR: Record<number, new (message: string) => BotTalkError> = {
  40001: InvalidKeyError,
  40002: NoChannelError,
  40003: EmptyMessageError,
  42901: RateLimitError,
  50001: PushFailedError,
};

/** Allowed characters in a SendKey. */
const KEY_PATTERN = /^[A-Za-z0-9_\-]{1,256}$/;

export class BotTalk {
  private readonly _key: string;
  public readonly baseUrl: string;
  public readonly timeout: number;

  constructor(key: string, options: BotTalkOptions = {}) {
    if (!key || typeof key !== 'string') {
      throw new Error('key must be a non-empty string');
    }
    if (!KEY_PATTERN.test(key)) {
      throw new Error(
        'key contains invalid characters (only alphanumeric, dash, underscore allowed)'
      );
    }

    this._key = key;
    this.baseUrl = (options.baseUrl ?? 'https://bot-talk.com').replace(/\/+$/, '');
    this.timeout = options.timeout ?? 30_000;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Push a message.
   *
   * @param title - Message title.
   * @param options - Optional: desp, channel, method.
   * @returns A PushResult object.
   *
   * @throws EmptyMessageError if both title and desp are empty.
   * @throws InvalidKeyError if the server rejects the key.
   * @throws NoChannelError if no active channel is configured.
   * @throws RateLimitError if the hourly limit is exceeded.
   * @throws PushFailedError if all channels fail.
   * @throws NetworkError on connection / timeout errors.
   */
  async send(title: string = '', options: SendOptions = {}): Promise<PushResult> {
    const { desp = '', channel = '', method = 'POST' } = options;

    if (!title && !desp) {
      throw new EmptyMessageError();
    }

    const upperMethod = method.toUpperCase();
    if (upperMethod !== 'GET' && upperMethod !== 'POST') {
      throw new Error("method must be 'GET' or 'POST'");
    }

    const url = `${this.baseUrl}/${encodeURIComponent(this._key)}.send`;

    const params: Record<string, string> = {};
    if (title) params.title = title;
    if (desp) params.desp = desp;
    if (channel) params.channel = channel;

    return this._request(url, params, upperMethod as 'GET' | 'POST');
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private async _request(
    url: string,
    params: Record<string, string>,
    method: 'GET' | 'POST'
  ): Promise<PushResult> {
    let data: ApiResponse;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      let response: Response;

      if (method === 'GET') {
        const qs = new URLSearchParams(params).toString();
        const fullUrl = qs ? `${url}?${qs}` : url;
        response = await fetch(fullUrl, {
          method: 'GET',
          signal: controller.signal,
        });
      } else {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(),
          signal: controller.signal,
        });
      }

      clearTimeout(timer);

      const raw = await response.text();
      try {
        data = JSON.parse(raw) as ApiResponse;
      } catch {
        throw new NetworkError(`Invalid JSON response: ${raw.slice(0, 200)}`);
      }
    } catch (err) {
      if (err instanceof BotTalkError) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new NetworkError('Request timed out');
      }
      throw new NetworkError(err instanceof Error ? err.message : String(err));
    }

    const code = data.code ?? -1;
    const message = data.message ?? '';
    const resultData = data.data;

    if (code !== 0) {
      // 50001 carries reason + hint that tell the developer exactly what
      // the receiver should do (most often: reply to ClawBot in WeChat).
      if (code === 50001) {
        const reason = resultData?.reason as
          | 'context_expired'
          | 'channel_dead'
          | 'account_restricted'
          | 'no_channel'
          | 'transient'
          | undefined;
        throw new PushFailedError(message, { reason, hint: resultData?.hint });
      }
      const ErrorClass = CODE_TO_ERROR[code] ?? BotTalkError;
      throw new ErrorClass(message);
    }

    return new PushResult(code, message, resultData);
  }

  // ------------------------------------------------------------------
  // Repr (never exposes the key)
  // ------------------------------------------------------------------

  toString(): string {
    const masked = this._key.length > 3 ? this._key.slice(0, 3) + '***' : '***';
    return `BotTalk(key="${masked}", baseUrl="${this.baseUrl}")`;
  }

  /** Prevent key from appearing in JSON.stringify output. */
  toJSON(): Record<string, unknown> {
    const masked = this._key.length > 3 ? this._key.slice(0, 3) + '***' : '***';
    return { key: masked, baseUrl: this.baseUrl, timeout: this.timeout };
  }
}
