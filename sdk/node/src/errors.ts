/**
 * Exception classes for the BotTalk Node.js SDK.
 */

export class BotTalkError extends Error {
  public readonly code: number;

  constructor(message: string, code: number = -1) {
    super(message);
    this.name = 'BotTalkError';
    this.code = code;
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
  constructor(message: string = 'All push channels failed') {
    super(message, 50001);
    this.name = 'PushFailedError';
  }
}

export class NetworkError extends BotTalkError {
  constructor(message: string = 'Network error') {
    super(message, -1);
    this.name = 'NetworkError';
  }
}
