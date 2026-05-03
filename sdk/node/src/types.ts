/**
 * Type definitions for the BotTalk Node.js SDK.
 */

/** Options for constructing an BotTalk client. */
export interface BotTalkOptions {
  /** Base URL of the BotTalk server. Defaults to "https://bot-talk.com". */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
}

/** Options for a single send call. */
export interface SendOptions {
  /** Message body / description (Markdown supported). */
  desp?: string;
  /** Target channel(s): "default", "all", or comma-separated IDs. */
  channel?: string;
  /** HTTP method: "GET" or "POST". Defaults to "POST". */
  method?: 'GET' | 'POST';
}

/** Result for a single channel push attempt. */
export interface ChannelResult {
  channelId: string;
  status: string;
  tokenInvalid: boolean;
  /** Sub-classification of the failure (e.g. 'context_expired', 'channel_dead'). */
  reason?: string;
  /** iLink raw ret code (e.g. -2 / -14) for failures with an iLink response. */
  retCode?: number | null;
}

/** Raw API response shape. */
export interface ApiResponse {
  code: number;
  message: string;
  data?: {
    results?: Array<{
      channel_id?: string;
      status?: string;
      token_invalid?: boolean;
      reason?: string;
      ret_code?: number | null;
    }>;
    /** Aggregated failure reason for 50001 responses. */
    reason?: string;
    /** Human-readable recovery hint for 50001 responses. */
    hint?: string;
  } | null;
}

/** Result of a push operation. */
export class PushResult {
  public readonly code: number;
  public readonly message: string;
  public readonly results: ChannelResult[];

  constructor(code: number, message: string, data?: ApiResponse['data']) {
    this.code = code;
    this.message = message;
    this.results = [];

    if (data && data.results) {
      for (const r of data.results) {
        this.results.push({
          channelId: r.channel_id ?? '',
          status: r.status ?? 'unknown',
          tokenInvalid: r.token_invalid ?? false,
          reason: r.reason,
          retCode: r.ret_code ?? null,
        });
      }
    }
  }

  /** True if the push succeeded (code === 0). */
  get isSuccess(): boolean {
    return this.code === 0;
  }

  toString(): string {
    return `PushResult(code=${this.code}, message=${JSON.stringify(this.message)})`;
  }
}
