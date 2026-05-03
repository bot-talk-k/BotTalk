import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Import source directly (using --experimental-strip-types)
import { BotTalk } from '../src/client.ts';
import {
  BotTalkError,
  InvalidKeyError,
  NoChannelError,
  EmptyMessageError,
  RateLimitError,
  PushFailedError,
  NetworkError,
} from '../src/errors.ts';
import { PushResult } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Helper: mock global fetch
// ---------------------------------------------------------------------------

function mockFetch(responseBody: object, status: number = 200) {
  const fn = mock.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  (globalThis as any).fetch = fn;
  return fn;
}

function mockFetchReject(error: Error) {
  const fn = mock.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    throw error;
  });
  (globalThis as any).fetch = fn;
  return fn;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Constructor tests
// ---------------------------------------------------------------------------

describe('BotTalk constructor', () => {
  it('should create a client with valid key', () => {
    const client = new BotTalk('test_key_123');
    assert.ok(client);
    assert.equal(client.baseUrl, 'https://bot-talk.com');
    assert.equal(client.timeout, 30_000);
  });

  it('should accept custom baseUrl and timeout', () => {
    const client = new BotTalk('mykey', {
      baseUrl: 'https://custom.example.com/',
      timeout: 5000,
    });
    assert.equal(client.baseUrl, 'https://custom.example.com');
    assert.equal(client.timeout, 5000);
  });

  it('should reject empty key', () => {
    assert.throws(() => new BotTalk(''), /non-empty string/);
  });

  it('should reject invalid key characters', () => {
    assert.throws(() => new BotTalk('key with spaces'), /invalid characters/);
    assert.throws(() => new BotTalk('key<script>'), /invalid characters/);
    assert.throws(() => new BotTalk('key/../etc'), /invalid characters/);
  });

  it('should reject key longer than 256 chars', () => {
    assert.throws(() => new BotTalk('a'.repeat(257)), /invalid characters/);
  });

  it('should accept valid key characters', () => {
    assert.ok(new BotTalk('abc-DEF_123'));
    assert.ok(new BotTalk('a'));
    assert.ok(new BotTalk('a'.repeat(256)));
  });
});

// ---------------------------------------------------------------------------
// Key security tests
// ---------------------------------------------------------------------------

describe('Key security', () => {
  it('toString should mask the key', () => {
    const client = new BotTalk('my_secret_key_123');
    const str = client.toString();
    assert.ok(!str.includes('my_secret_key_123'));
    assert.ok(str.includes('my_***'));
  });

  it('toJSON should mask the key', () => {
    const client = new BotTalk('my_secret_key_123');
    const json = JSON.stringify(client);
    assert.ok(!json.includes('my_secret_key_123'));
    assert.ok(json.includes('my_***'));
  });

  it('short key should be fully masked', () => {
    const client = new BotTalk('ab');
    assert.ok(client.toString().includes('***'));
    assert.ok(!client.toString().includes('ab'));
  });
});

// ---------------------------------------------------------------------------
// send() parameter validation
// ---------------------------------------------------------------------------

describe('send() parameter validation', () => {
  it('should reject empty title and desp', async () => {
    const client = new BotTalk('testkey');
    await assert.rejects(
      () => client.send('', { desp: '' }),
      (err: any) => err instanceof EmptyMessageError
    );
  });

  it('should reject invalid method', async () => {
    const client = new BotTalk('testkey');
    await assert.rejects(
      () => client.send('hello', { method: 'PUT' as any }),
      /method must be/
    );
  });
});

// ---------------------------------------------------------------------------
// Successful send
// ---------------------------------------------------------------------------

describe('send() success', () => {
  it('should POST by default and return PushResult', async () => {
    const fetchFn = mockFetch({
      code: 0,
      message: 'success',
      data: {
        results: [
          { channel_id: 'ch1', status: 'success' },
          { channel_id: 'ch2', status: 'success', token_invalid: false },
        ],
      },
    });

    const client = new BotTalk('testkey');
    const result = await client.send('Hello', { desp: 'World' });

    assert.ok(result instanceof PushResult);
    assert.equal(result.code, 0);
    assert.equal(result.isSuccess, true);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].channelId, 'ch1');
    assert.equal(result.results[0].status, 'success');

    // Verify POST was used
    const [url, init] = fetchFn.mock.calls[0].arguments as [string, RequestInit];
    assert.ok(url.includes('testkey.send'));
    assert.equal(init.method, 'POST');
    assert.ok((init.headers as Record<string, string>)['Content-Type'].includes('urlencoded'));

    // Verify body contains params
    const body = init.body as string;
    assert.ok(body.includes('title=Hello'));
    assert.ok(body.includes('desp=World'));
  });

  it('should use GET when specified', async () => {
    const fetchFn = mockFetch({ code: 0, message: 'ok', data: { results: [] } });

    const client = new BotTalk('testkey');
    await client.send('Hello', { method: 'GET' });

    const [url, init] = fetchFn.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(init.method, 'GET');
    assert.ok(url.includes('title=Hello'));
  });

  it('should send title only (no desp)', async () => {
    mockFetch({ code: 0, message: 'ok', data: null });
    const client = new BotTalk('testkey');
    const result = await client.send('Title only');
    assert.ok(result.isSuccess);
    assert.equal(result.results.length, 0);
  });

  it('should send desp only (no title)', async () => {
    const fetchFn = mockFetch({ code: 0, message: 'ok', data: null });
    const client = new BotTalk('testkey');
    await client.send('', { desp: 'Body only' });

    const [, init] = fetchFn.mock.calls[0].arguments as [string, RequestInit];
    const body = init.body as string;
    assert.ok(!body.includes('title='));
    assert.ok(body.includes('desp=Body+only'));
  });

  it('should include channel param when specified', async () => {
    const fetchFn = mockFetch({ code: 0, message: 'ok', data: null });
    const client = new BotTalk('testkey');
    await client.send('Hi', { channel: 'all' });

    const [, init] = fetchFn.mock.calls[0].arguments as [string, RequestInit];
    const body = init.body as string;
    assert.ok(body.includes('channel=all'));
  });

  it('should URL-encode special characters', async () => {
    const fetchFn = mockFetch({ code: 0, message: 'ok', data: null });
    const client = new BotTalk('testkey');
    await client.send('Hello & World', { desp: '测试<script>' });

    const [, init] = fetchFn.mock.calls[0].arguments as [string, RequestInit];
    const body = init.body as string;
    // URLSearchParams encodes & and < properly
    assert.ok(!body.includes('&W'));  // & should be encoded
    assert.ok(!body.includes('<script>'));  // < should be encoded
  });

  it('should use custom baseUrl', async () => {
    const fetchFn = mockFetch({ code: 0, message: 'ok', data: null });
    const client = new BotTalk('testkey', { baseUrl: 'http://localhost:3000' });
    await client.send('Hi');

    const [url] = fetchFn.mock.calls[0].arguments as [string, RequestInit];
    assert.ok(url.startsWith('http://localhost:3000/'));
  });
});

// ---------------------------------------------------------------------------
// Error responses from server
// ---------------------------------------------------------------------------

describe('send() server errors', () => {
  it('should throw InvalidKeyError for code 40001', async () => {
    mockFetch({ code: 40001, message: 'bad key' });
    const client = new BotTalk('testkey');
    await assert.rejects(
      () => client.send('Hi'),
      (err: any) => {
        assert.ok(err instanceof InvalidKeyError);
        assert.equal(err.code, 40001);
        assert.equal(err.message, 'bad key');
        return true;
      }
    );
  });

  it('should throw NoChannelError for code 40002', async () => {
    mockFetch({ code: 40002, message: 'no channel' });
    const client = new BotTalk('testkey');
    await assert.rejects(
      () => client.send('Hi'),
      (err: any) => {
        assert.ok(err instanceof NoChannelError);
        return true;
      }
    );
  });

  it('should throw EmptyMessageError for code 40003', async () => {
    mockFetch({ code: 40003, message: 'empty' });
    const client = new BotTalk('testkey');
    await assert.rejects(
      () => client.send('Hi'),
      (err: any) => {
        assert.ok(err instanceof EmptyMessageError);
        return true;
      }
    );
  });

  it('should throw RateLimitError for code 42901', async () => {
    mockFetch({ code: 42901, message: 'rate limit' });
    const client = new BotTalk('testkey');
    await assert.rejects(
      () => client.send('Hi'),
      (err: any) => {
        assert.ok(err instanceof RateLimitError);
        return true;
      }
    );
  });

  it('should throw PushFailedError for code 50001', async () => {
    mockFetch({ code: 50001, message: 'all failed' });
    const client = new BotTalk('testkey');
    await assert.rejects(
      () => client.send('Hi'),
      (err: any) => {
        assert.ok(err instanceof PushFailedError);
        return true;
      }
    );
  });

  it('should populate reason + hint on 50001 (context_expired)', async () => {
    mockFetch({
      code: 50001,
      message: '全部推送失败',
      data: {
        results: [
          { channel_id: 1, status: 'failed', token_invalid: false, reason: 'context_expired', ret_code: -2 },
        ],
        reason: 'context_expired',
        hint: '让收信人在微信里向 ClawBot 回复任意一条消息',
      },
    });
    const client = new BotTalk('testkey');
    await assert.rejects(
      () => client.send('Hi'),
      (err: any) => {
        assert.ok(err instanceof PushFailedError);
        assert.equal(err.reason, 'context_expired');
        assert.ok(err.hint && err.hint.includes('回复'));
        assert.equal(err.isRecoverableByReply, true);
        return true;
      }
    );
  });

  it('should mark channel_dead as NOT recoverable by reply', async () => {
    mockFetch({
      code: 50001,
      message: '全部推送失败',
      data: {
        results: [{ channel_id: 1, status: 'failed', token_invalid: true, reason: 'channel_dead' }],
        reason: 'channel_dead',
        hint: '必须由收信人重新扫码绑定 ClawBot',
      },
    });
    const client = new BotTalk('testkey');
    await assert.rejects(
      () => client.send('Hi'),
      (err: any) => {
        assert.equal(err.reason, 'channel_dead');
        assert.equal(err.isRecoverableByReply, false);
        return true;
      }
    );
  });

  it('should accept 50001 without reason/hint (back-compat)', async () => {
    mockFetch({ code: 50001, message: 'all failed', data: { results: [] } });
    const client = new BotTalk('testkey');
    await assert.rejects(
      () => client.send('Hi'),
      (err: any) => {
        assert.ok(err instanceof PushFailedError);
        assert.equal(err.reason, undefined);
        assert.equal(err.isRecoverableByReply, false);
        return true;
      }
    );
  });

  it('should throw generic BotTalkError for unknown codes', async () => {
    mockFetch({ code: 99999, message: 'unknown error' });
    const client = new BotTalk('testkey');
    await assert.rejects(
      () => client.send('Hi'),
      (err: any) => {
        assert.ok(err instanceof BotTalkError);
        assert.equal(err.message, 'unknown error');
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Network errors
// ---------------------------------------------------------------------------

describe('send() network errors', () => {
  it('should throw NetworkError on fetch failure', async () => {
    mockFetchReject(new TypeError('fetch failed'));
    const client = new BotTalk('testkey');
    await assert.rejects(
      () => client.send('Hi'),
      (err: any) => {
        assert.ok(err instanceof NetworkError);
        assert.ok(err.message.includes('fetch failed'));
        return true;
      }
    );
  });

  it('should throw NetworkError on abort/timeout', async () => {
    mockFetchReject(Object.assign(new DOMException('signal is aborted', 'AbortError')));
    const client = new BotTalk('testkey');
    await assert.rejects(
      () => client.send('Hi'),
      (err: any) => {
        assert.ok(err instanceof NetworkError);
        assert.ok(err.message.includes('timed out'));
        return true;
      }
    );
  });

  it('should throw NetworkError on invalid JSON response', async () => {
    const fn = mock.fn(async () => {
      return new Response('not json', { status: 200 });
    });
    (globalThis as any).fetch = fn;

    const client = new BotTalk('testkey');
    await assert.rejects(
      () => client.send('Hi'),
      (err: any) => {
        assert.ok(err instanceof NetworkError);
        assert.ok(err.message.includes('Invalid JSON'));
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// PushResult / ChannelResult
// ---------------------------------------------------------------------------

describe('PushResult', () => {
  it('should parse channel results correctly', () => {
    const result = new PushResult(0, 'ok', {
      results: [
        { channel_id: 'ch1', status: 'success', token_invalid: false },
        { channel_id: 'ch2', status: 'failed', token_invalid: true, reason: 'expired' },
      ],
    });

    assert.equal(result.isSuccess, true);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[1].channelId, 'ch2');
    assert.equal(result.results[1].tokenInvalid, true);
    assert.equal(result.results[1].reason, 'expired');
  });

  it('should handle null data', () => {
    const result = new PushResult(0, 'ok', null as any);
    assert.equal(result.results.length, 0);
    assert.equal(result.isSuccess, true);
  });

  it('should handle undefined data', () => {
    const result = new PushResult(0, 'ok', undefined);
    assert.equal(result.results.length, 0);
  });

  it('toString should show code and message', () => {
    const result = new PushResult(0, 'ok');
    assert.ok(result.toString().includes('code=0'));
  });
});

// ---------------------------------------------------------------------------
// Error class hierarchy
// ---------------------------------------------------------------------------

describe('Error hierarchy', () => {
  it('all errors should extend BotTalkError', () => {
    assert.ok(new InvalidKeyError() instanceof BotTalkError);
    assert.ok(new NoChannelError() instanceof BotTalkError);
    assert.ok(new EmptyMessageError() instanceof BotTalkError);
    assert.ok(new RateLimitError() instanceof BotTalkError);
    assert.ok(new PushFailedError() instanceof BotTalkError);
    assert.ok(new NetworkError() instanceof BotTalkError);
  });

  it('all errors should extend Error', () => {
    assert.ok(new InvalidKeyError() instanceof Error);
    assert.ok(new NetworkError() instanceof Error);
  });

  it('each error should have correct code', () => {
    assert.equal(new InvalidKeyError().code, 40001);
    assert.equal(new NoChannelError().code, 40002);
    assert.equal(new EmptyMessageError().code, 40003);
    assert.equal(new RateLimitError().code, 42901);
    assert.equal(new PushFailedError().code, 50001);
    assert.equal(new NetworkError().code, -1);
  });

  it('each error should have correct name', () => {
    assert.equal(new InvalidKeyError().name, 'InvalidKeyError');
    assert.equal(new NoChannelError().name, 'NoChannelError');
    assert.equal(new EmptyMessageError().name, 'EmptyMessageError');
    assert.equal(new RateLimitError().name, 'RateLimitError');
    assert.equal(new PushFailedError().name, 'PushFailedError');
    assert.equal(new NetworkError().name, 'NetworkError');
  });
});

// ---------------------------------------------------------------------------
// URL encoding / key in URL
// ---------------------------------------------------------------------------

describe('URL construction', () => {
  it('should encode key in URL path', async () => {
    const fetchFn = mockFetch({ code: 0, message: 'ok', data: null });
    // Key with dashes and underscores (valid chars that might need URL encoding)
    const client = new BotTalk('my-key_123');
    await client.send('Hi');

    const [url] = fetchFn.mock.calls[0].arguments as [string, RequestInit];
    assert.ok(url.includes('my-key_123.send'));
  });
});
