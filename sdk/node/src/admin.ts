/**
 * BotTalk Admin client -- Tier 2 management SDK (Node.js).
 *
 * Session-based management client for channel management, reminders,
 * push logs, key management, and QR binding workflows.
 *
 * Zero external dependencies (uses only built-in fetch).
 */

import { BotTalkError, NetworkError } from './errors.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for constructing an BotTalkAdmin client. */
export interface AdminOptions {
  /** Base URL of the BotTalk server. Defaults to "https://bot-talk.com". */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
}

/** A push channel. */
export interface Channel {
  id: number;
  user_id: number;
  name: string;
  channel_type: string;
  wechat_openid?: string;
  bot_token?: string;
  context_token?: string;
  status: string;
  is_default: number;
  created_at: string;
}

/** Result from getQR(). */
export interface QRResult {
  qrcode: string;
  qr_url?: string;
  url?: string;
}

/** Result from checkBindStatus(). */
export interface BindStatus {
  status?: string;
  id?: number;
  send_key?: string;
  wechat_openid?: string;
  is_new?: boolean;
  rebind?: boolean;
  [key: string]: unknown;
}

/** A reminder. */
export interface Reminder {
  id: number;
  user_id: number;
  title: string;
  message: string;
  time: string;
  type: string;
  max_count: number;
  enabled: number;
  created_at: string;
  [key: string]: unknown;
}

/** Options for creating a reminder. */
export interface ReminderOptions {
  title: string;
  time: string;
  type?: string;
  message?: string;
  max_count?: number;
}

/** A push log entry. */
export interface PushLog {
  id: number;
  user_id: number;
  channel_id?: number;
  channel_name?: string;
  title?: string;
  desp?: string;
  status: string;
  created_at: string;
  [key: string]: unknown;
}

/** User info returned from login/me. */
export interface UserInfo {
  id: number;
  email?: string;
  send_key: string;
  channel_count: number;
}

// ---------------------------------------------------------------------------
// BindingSession
// ---------------------------------------------------------------------------

/** Represents an in-progress QR binding flow. */
export class BindingSession {
  /** URL of the QR code image to display / scan. */
  public readonly qrUrl: string;
  /** The qrcode token used to poll status. */
  public readonly qrcode: string;

  private readonly _admin: BotTalkAdmin;

  constructor(admin: BotTalkAdmin, qrcode: string, qrUrl: string) {
    this._admin = admin;
    this.qrcode = qrcode;
    this.qrUrl = qrUrl;
  }

  /**
   * Poll until the QR code is scanned and binding completes.
   *
   * @param timeout - Maximum milliseconds to wait (default 120000, max 300000).
   * @param interval - Milliseconds between polls (default 2000).
   * @returns The binding result from the server.
   * @throws BotTalkError if QR expires or timeout is reached.
   */
  async wait(timeout: number = 120_000, interval: number = 2_000): Promise<BindStatus> {
    if (timeout > 300_000) timeout = 300_000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const result = await this._admin.checkBindStatus(this.qrcode);
      const status = result.status ?? '';
      // Binding complete when we get an id/send_key or status is active/pending
      if (result.id || result.send_key || status === 'active' || status === 'pending') {
        return result;
      }
      if (status === 'expired') {
        throw new BotTalkError('QR code expired');
      }
      await new Promise(r => setTimeout(r, interval));
    }
    throw new BotTalkError(`Binding not completed within ${timeout}ms`);
  }
}

// ---------------------------------------------------------------------------
// Admin client
// ---------------------------------------------------------------------------

export class BotTalkAdmin {
  public readonly baseUrl: string;
  public readonly timeout: number;
  private _cookies: string = '';
  private _loggedIn: boolean = false;

  constructor(options: AdminOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://bot-talk.com').replace(/\/+$/, '');
    this.timeout = options.timeout ?? 30_000;
  }

  // ------------------------------------------------------------------
  // Auth
  // ------------------------------------------------------------------

  /** Log in with a SendKey. Stores session cookie internally. */
  async login(sendKey: string): Promise<UserInfo> {
    const data = await this._post<UserInfo>('/api/auth/login', { send_key: sendKey });
    this._loggedIn = true;
    return data;
  }

  /** Log out and destroy the session. */
  async logout(): Promise<void> {
    await this._post('/api/auth/logout', {});
    this._loggedIn = false;
    this._cookies = '';
  }

  /** Get current user info. */
  async me(): Promise<UserInfo> {
    this._requireLogin();
    return this._get<UserInfo>('/api/auth/me');
  }

  // ------------------------------------------------------------------
  // Channel management
  // ------------------------------------------------------------------

  /** List all channels for the current user. */
  async listChannels(): Promise<Channel[]> {
    this._requireLogin();
    return this._get<Channel[]>('/api/channels/');
  }

  /** Delete (soft-delete) a channel. */
  async deleteChannel(channelId: number): Promise<void> {
    this._requireLogin();
    await this._delete(`/api/channels/${channelId}`);
  }

  /**
   * Start a QR binding flow (high-level).
   * Returns a BindingSession with qrUrl and a wait() method.
   */
  async startBinding(): Promise<BindingSession> {
    const qr = await this.getQR();
    const qrUrl = qr.qr_url ?? qr.url ?? '';
    return new BindingSession(this, qr.qrcode, qrUrl);
  }

  /** Get a QR code for channel binding (low-level). */
  async getQR(): Promise<QRResult> {
    this._requireLogin();
    return this._post<QRResult>('/api/channels/qrcode', {});
  }

  /** Check the binding status of a QR code (low-level). */
  async checkBindStatus(qrcode: string): Promise<BindStatus> {
    this._requireLogin();
    return this._get<BindStatus>(`/api/channels/bind-status/${encodeURIComponent(qrcode)}`);
  }

  // ------------------------------------------------------------------
  // Reminder management
  // ------------------------------------------------------------------

  /** List all reminders for the current user. */
  async listReminders(): Promise<Reminder[]> {
    this._requireLogin();
    return this._get<Reminder[]>('/api/reminders/');
  }

  /** Create a new reminder. */
  async createReminder(opts: ReminderOptions): Promise<Reminder> {
    this._requireLogin();
    return this._post<Reminder>('/api/reminders/', {
      title: opts.title,
      time: opts.time,
      type: opts.type ?? 'once',
      message: opts.message ?? '',
      max_count: opts.max_count ?? 0,
    });
  }

  /** Delete a reminder. */
  async deleteReminder(id: number): Promise<void> {
    this._requireLogin();
    await this._delete(`/api/reminders/${id}`);
  }

  // ------------------------------------------------------------------
  // Push logs
  // ------------------------------------------------------------------

  /** Get recent push logs. */
  async getPushLogs(limit: number = 50): Promise<PushLog[]> {
    this._requireLogin();
    return this._get<PushLog[]>('/api/push-logs/');
  }

  // ------------------------------------------------------------------
  // Key management
  // ------------------------------------------------------------------

  /** Get the current SendKey. */
  async getSendKey(): Promise<string> {
    this._requireLogin();
    const data = await this._get<{ send_key: string }>('/api/key/');
    return data.send_key ?? '';
  }

  /** Reset the SendKey and return the new one. */
  async resetSendKey(): Promise<string> {
    this._requireLogin();
    const data = await this._post<{ send_key: string }>('/api/key/reset', {});
    return data.send_key ?? '';
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private _requireLogin(): void {
    if (!this._loggedIn) {
      throw new BotTalkError('Not logged in. Call login() first.');
    }
  }

  private async _request<T>(method: string, path: string, body?: object): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    const headers: Record<string, string> = {};
    if (this._cookies) {
      headers['Cookie'] = this._cookies;
    }

    let init: RequestInit;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init = {
        method,
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
      };
    } else {
      init = {
        method,
        headers,
        signal: controller.signal,
        redirect: 'manual',
      };
    }

    let response: Response;
    let raw: string;
    try {
      response = await fetch(url, init);
      clearTimeout(timer);
      raw = await response.text();
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new NetworkError('Request timed out');
      }
      throw new NetworkError(err instanceof Error ? err.message : String(err));
    }

    // Parse and store Set-Cookie headers
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) {
      const cookieParts: string[] = [];
      // Keep existing cookies
      if (this._cookies) {
        for (const c of this._cookies.split('; ')) {
          cookieParts.push(c);
        }
      }
      for (const sc of setCookies) {
        const nameValue = sc.split(';')[0];
        if (nameValue) {
          // Replace existing cookie with same name
          const name = nameValue.split('=')[0];
          const idx = cookieParts.findIndex(c => c.startsWith(name + '='));
          if (idx >= 0) {
            cookieParts[idx] = nameValue;
          } else {
            cookieParts.push(nameValue);
          }
        }
      }
      this._cookies = cookieParts.join('; ');
    }

    let result: { success: boolean; data?: T; error?: string; id?: number };
    try {
      result = JSON.parse(raw);
    } catch {
      throw new NetworkError(`Invalid JSON response: ${raw.slice(0, 200)}`);
    }

    if (!result.success) {
      const errorMsg =
        result.error ??
        ((result.data as any)?.error as string | undefined) ??
        'Unknown error';
      throw new BotTalkError(String(errorMsg));
    }

    // Some endpoints return { success, id } instead of { success, data }
    if (result.data === undefined && result.id !== undefined) {
      return result as unknown as T;
    }

    return result.data as T;
  }

  private _get<T>(path: string): Promise<T> {
    return this._request<T>('GET', path);
  }

  private _post<T>(path: string, body: object): Promise<T> {
    return this._request<T>('POST', path, body);
  }

  private _delete<T = void>(path: string): Promise<T> {
    return this._request<T>('DELETE', path);
  }

  // ------------------------------------------------------------------
  // Repr (never exposes cookies or keys)
  // ------------------------------------------------------------------

  toString(): string {
    const status = this._loggedIn ? 'logged_in' : 'not_logged_in';
    return `BotTalkAdmin(baseUrl="${this.baseUrl}", status=${status})`;
  }

  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, timeout: this.timeout, loggedIn: this._loggedIn };
  }
}
