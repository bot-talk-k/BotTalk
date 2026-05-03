/**
 * Exception classes for the BotTalk Node.js SDK.
 */

/**
 * Failure reason returned by the server in `data.reason` for code 50001.
 * The most actionable one is `context_expired` — ask the receiver to reply
 * to ClawBot in WeChat and the message auto-redelivers within minutes.
 */
export type FailureReason =
  | 'context_expired'
  | 'channel_dead'
  | 'account_restricted'
  | 'no_channel'
  | 'transient';

export class BotTalkError extends Error {
  public readonly code: number;
  /** Sub-classification of the failure (only populated for code 50001). */
  public readonly reason?: FailureReason;
  /** Human-readable recovery hint (only populated for code 50001). */
  public readonly hint?: string;

  constructor(message: string, code: number = -1, opts?: { reason?: FailureReason; hint?: string }) {
    super(message);
    this.name = 'BotTalkError';
    this.code = code;
    this.reason = opts?.reason;
    this.hint = opts?.hint;
  }
}

export class InvalidKeyError extends BotTalkError {
  constructor(message: string = 'SendKey is invalid') {
    super(message, 40001);
    this.name = 'InvalidKeyError';
  }
}

export class NoChannelError extends BotTalkError {
  constructor(message: string = 'No active push channel available') {
    super(message, 40002);
    this.name = 'NoChannelError';
  }
}

export class EmptyMessageError extends BotTalkError {
  constructor(message: string = 'Title and content cannot both be empty') {
    super(message, 40003);
    this.name = 'EmptyMessageError';
  }
}

export class RateLimitError extends BotTalkError {
  constructor(message: string = 'Rate limit exceeded (max 100 per hour)') {
    super(message, 42901);
    this.name = 'RateLimitError';
  }
}

export class PushFailedError extends BotTalkError {
  constructor(
    message: string = 'All push channels failed',
    opts?: { reason?: FailureReason; hint?: string },
  ) {
    super(message, 50001, opts);
    this.name = 'PushFailedError';
  }

  /**
   * True when the channel can be recovered just by having the receiver
   * reply to ClawBot in WeChat (i.e. reason === 'context_expired'). The
   * server will then auto-resend the message via its retry queue, no
   * rebinding required. This is the most common 50001 case.
   */
  get isRecoverableByReply(): boolean {
    return this.reason === 'context_expired';
  }
}

export class NetworkError extends BotTalkError {
  constructor(message: string = 'Network error') {
    super(message, -1);
    this.name = 'NetworkError';
  }
}
