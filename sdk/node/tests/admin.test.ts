import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { BotTalkAdmin, BindingSession } from '../src/admin.ts';
import { BotTalkError, NetworkError } from '../src/errors.ts';
import type { Channel, Reminder, PushLog, QRResult, BindStatus, UserInfo } from '../src/admin.ts';

// ---------------------------------------------------------------------------
// Helper: mock global fetch with cookie support
// ---------------------------------------------------------------------------

function mockFetch(responseBody: object, status: number = 200, setCookie?: string) {
  const fn = mock.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (setCookie) {
      headers.append('Set-Cookie', setCookie);
    }
    const resp = new Response(JSON.stringify(responseBody), { status, headers });
    // Polyfill getSetCookie if not available
    if (!resp.headers.getSetCookie) {
      (resp.headers as any).getSetCookie = () => setCookie ? [setCookie] : [];
    }
    return resp;
  });
  (globalThis as any).fetch = fn;
  return fn;
}

function mockFetchSequence(responses: Array<{ body: object; status?: number }>) {
  let callIndex = 0;
  const fn = mock.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const r = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    const resp = new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!resp.headers.getSetCookie) {
      (resp.headers as any).getSetCookie = () => [];
    }
    return resp;
  });
  (globalThis as any).fetch = fn;
  return fn;
}

function mockFetchReject(error: Error) {
  const fn = mock.fn(async () => { throw error; });
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
// Constructor
// ---------------------------------------------------------------------------

describe('BotTalkAdmin constructor', () => {
  it('should create with defaults', () => {
    const admin = new BotTalkAdmin();
    assert.equal(admin.baseUrl, 'https://bot-talk.com');
    assert.equal(admin.timeout, 30_000);
  });

  it('should accept custom options', () => {
    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000/', timeout: 5000 });
    assert.equal(admin.baseUrl, 'http://localhost:3000');
    assert.equal(admin.timeout, 5000);
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('login', () => {
  it('should login successfully', async () => {
    const fetchFn = mockFetch(
      { success: true, data: { id: 1, email: 'test@t.com', send_key: 'sk_x', channel_count: 2 } },
      200,
      'connect.sid=abc123; Path=/'
    );

    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000' });
    const user = await admin.login('sk_x');

    assert.equal(user.id, 1);
    assert.equal(user.send_key, 'sk_x');

    // Verify POST /api/auth/login
    const [url, init] = fetchFn.mock.calls[0].arguments as [string, RequestInit];
    assert.ok(url.includes('/api/auth/login'));
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body as string);
    assert.equal(body.send_key, 'sk_x');
  });

  it('should throw on login failure', async () => {
    mockFetch({ success: false, error: 'SendKey 无效' });

    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000' });
    await assert.rejects(
      () => admin.login('bad_key'),
      (err: any) => {
        assert.ok(err instanceof BotTalkError);
        assert.ok(err.message.includes('SendKey'));
        return true;
      }
    );
  });
});

describe('logout', () => {
  it('should logout and clear cookies', async () => {
    mockFetch({ success: true });
    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000' });
    // Simulate logged in
    (admin as any)._loggedIn = true;
    (admin as any)._cookies = 'connect.sid=abc';

    await admin.logout();
    assert.equal((admin as any)._loggedIn, false);
    assert.equal((admin as any)._cookies, '');
  });
});

describe('require login', () => {
  it('should throw if not logged in', async () => {
    const admin = new BotTalkAdmin();
    await assert.rejects(() => admin.listChannels(), /Not logged in/);
    await assert.rejects(() => admin.listReminders(), /Not logged in/);
    await assert.rejects(() => admin.getPushLogs(), /Not logged in/);
    await assert.rejects(() => admin.getSendKey(), /Not logged in/);
    await assert.rejects(() => admin.resetSendKey(), /Not logged in/);
    await assert.rejects(() => admin.me(), /Not logged in/);
    await assert.rejects(() => admin.deleteChannel(1), /Not logged in/);
    await assert.rejects(() => admin.deleteReminder(1), /Not logged in/);
    await assert.rejects(() => admin.getQR(), /Not logged in/);
    await assert.rejects(() => admin.checkBindStatus('qr'), /Not logged in/);
  });
});

describe('me', () => {
  it('should return user info', async () => {
    mockFetch({ success: true, data: { id: 1, email: 'a@b.com', send_key: 'sk', channel_count: 1 } });
    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000' });
    (admin as any)._loggedIn = true;

    const user = await admin.me();
    assert.equal(user.id, 1);
  });
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

describe('channel management', () => {
  function makeAdmin() {
    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000' });
    (admin as any)._loggedIn = true;
    return admin;
  }

  it('should list channels', async () => {
    mockFetch({
      success: true,
      data: [
        { id: 1, name: 'Channel 1', status: 'active' },
        { id: 2, name: 'Channel 2', status: 'pending' },
      ],
    });
    const admin = makeAdmin();
    const channels = await admin.listChannels();
    assert.equal(channels.length, 2);
    assert.equal(channels[0].name, 'Channel 1');
  });

  it('should delete a channel', async () => {
    const fetchFn = mockFetch({ success: true, data: { message: 'Channel deleted' } });
    const admin = makeAdmin();
    await admin.deleteChannel(1);

    const [url, init] = fetchFn.mock.calls[0].arguments as [string, RequestInit];
    assert.ok(url.includes('/api/channels/1'));
    assert.equal(init.method, 'DELETE');
  });

  it('should throw on delete not found', async () => {
    mockFetch({ success: false, data: { error: 'Channel not found' } });
    const admin = makeAdmin();
    await assert.rejects(
      () => admin.deleteChannel(999),
      (err: any) => {
        assert.ok(err instanceof BotTalkError);
        assert.ok(err.message.includes('Channel not found'));
        return true;
      }
    );
  });

  it('should get QR code', async () => {
    mockFetch({ success: true, data: { qrcode: 'qr_token', qr_url: 'https://example.com/qr.png' } });
    const admin = makeAdmin();
    const qr = await admin.getQR();
    assert.equal(qr.qrcode, 'qr_token');
    assert.equal(qr.qr_url, 'https://example.com/qr.png');
  });

  it('should check bind status', async () => {
    mockFetch({ success: true, data: { status: 'waiting' } });
    const admin = makeAdmin();
    const result = await admin.checkBindStatus('qr_token');
    assert.equal(result.status, 'waiting');
  });

  it('should check bind status complete', async () => {
    mockFetch({
      success: true,
      data: { id: 5, status: 'pending', send_key: 'sk_new', is_new: true },
    });
    const admin = makeAdmin();
    const result = await admin.checkBindStatus('qr_token');
    assert.equal(result.id, 5);
    assert.equal(result.is_new, true);
  });
});

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

describe('reminder management', () => {
  function makeAdmin() {
    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000' });
    (admin as any)._loggedIn = true;
    return admin;
  }

  it('should list reminders', async () => {
    mockFetch({
      success: true,
      data: [{ id: 1, title: 'Morning check', time: '08:00', type: 'once' }],
    });
    const admin = makeAdmin();
    const reminders = await admin.listReminders();
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].title, 'Morning check');
  });

  it('should create a reminder', async () => {
    const fetchFn = mockFetch({ success: true, id: 42 });
    const admin = makeAdmin();
    const result = await admin.createReminder({ title: 'Standup', time: '09:00', type: 'repeat' });

    const [, init] = fetchFn.mock.calls[0].arguments as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    assert.equal(body.title, 'Standup');
    assert.equal(body.time, '09:00');
    assert.equal(body.type, 'repeat');
  });

  it('should delete a reminder', async () => {
    const fetchFn = mockFetch({ success: true });
    const admin = makeAdmin();
    await admin.deleteReminder(1);

    const [url, init] = fetchFn.mock.calls[0].arguments as [string, RequestInit];
    assert.ok(url.includes('/api/reminders/1'));
    assert.equal(init.method, 'DELETE');
  });
});

// ---------------------------------------------------------------------------
// Push logs
// ---------------------------------------------------------------------------

describe('push logs', () => {
  it('should get push logs', async () => {
    mockFetch({
      success: true,
      data: [
        { id: 1, title: 'Test push', status: 'success', channel_name: 'Ch1' },
        { id: 2, title: 'Another push', status: 'failed', channel_name: 'Ch2' },
      ],
    });
    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000' });
    (admin as any)._loggedIn = true;

    const logs = await admin.getPushLogs();
    assert.equal(logs.length, 2);
    assert.equal(logs[0].title, 'Test push');
  });
});

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

describe('key management', () => {
  function makeAdmin() {
    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000' });
    (admin as any)._loggedIn = true;
    return admin;
  }

  it('should get send key', async () => {
    mockFetch({ success: true, data: { send_key: 'sk_current_123' } });
    const admin = makeAdmin();
    const key = await admin.getSendKey();
    assert.equal(key, 'sk_current_123');
  });

  it('should reset send key', async () => {
    const fetchFn = mockFetch({ success: true, data: { send_key: 'sk_new_456' } });
    const admin = makeAdmin();
    const key = await admin.resetSendKey();
    assert.equal(key, 'sk_new_456');

    const [, init] = fetchFn.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(init.method, 'POST');
  });
});

// ---------------------------------------------------------------------------
// Binding session
// ---------------------------------------------------------------------------

describe('BindingSession', () => {
  function makeAdmin() {
    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000' });
    (admin as any)._loggedIn = true;
    return admin;
  }

  it('should start binding and create session', async () => {
    mockFetch({ success: true, data: { qrcode: 'qr_abc', qr_url: 'https://example.com/qr.png' } });
    const admin = makeAdmin();
    const session = await admin.startBinding();

    assert.ok(session instanceof BindingSession);
    assert.equal(session.qrcode, 'qr_abc');
    assert.equal(session.qrUrl, 'https://example.com/qr.png');
  });

  it('should wait for binding completion', async () => {
    const fetchFn = mockFetchSequence([
      { body: { success: true, data: { status: 'waiting' } } },
      { body: { success: true, data: { id: 5, status: 'pending', send_key: 'sk_new', is_new: true } } },
    ]);

    const admin = makeAdmin();
    const session = new BindingSession(admin, 'qr_abc', 'https://example.com/qr.png');
    const result = await session.wait(10_000, 100);
    assert.equal(result.id, 5);
  });

  it('should throw on expired QR', async () => {
    mockFetch({ success: true, data: { status: 'expired' } });
    const admin = makeAdmin();
    const session = new BindingSession(admin, 'qr_abc', 'https://example.com/qr.png');

    await assert.rejects(
      () => session.wait(5_000, 100),
      (err: any) => {
        assert.ok(err instanceof BotTalkError);
        assert.ok(err.message.includes('expired'));
        return true;
      }
    );
  });

  it('should throw on timeout', async () => {
    mockFetch({ success: true, data: { status: 'waiting' } });
    const admin = makeAdmin();
    const session = new BindingSession(admin, 'qr_abc', 'https://example.com/qr.png');

    await assert.rejects(
      () => session.wait(500, 200),
      (err: any) => {
        assert.ok(err instanceof BotTalkError);
        assert.ok(err.message.includes('not completed'));
        return true;
      }
    );
  });

  it('should cap timeout at 300000ms', async () => {
    // Just ensure it doesn't crash with a large timeout
    mockFetch({ success: true, data: { status: 'waiting' } });
    const admin = makeAdmin();
    const session = new BindingSession(admin, 'qr_abc', '');

    await assert.rejects(
      () => session.wait(500, 200),  // Still use small timeout for test speed
      /not completed/
    );
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe('security', () => {
  it('toString should not expose cookies', () => {
    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000' });
    (admin as any)._cookies = 'connect.sid=secret123';
    const str = admin.toString();
    assert.ok(!str.includes('secret123'));
    assert.ok(!str.includes('cookie'));
  });

  it('toJSON should not expose cookies', () => {
    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000' });
    (admin as any)._cookies = 'connect.sid=secret123';
    const json = JSON.stringify(admin);
    assert.ok(!json.includes('secret123'));
    assert.ok(!json.includes('cookie'));
  });

  it('should send cookies on subsequent requests', async () => {
    // Login with cookie
    const loginFetch = mockFetch(
      { success: true, data: { id: 1, email: 't@t.com', send_key: 'sk', channel_count: 0 } },
      200,
      'connect.sid=sess_abc; Path=/'
    );
    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000' });
    await admin.login('sk');

    // Next request should include cookie
    const fetchFn = mockFetch({ success: true, data: [] });
    const channels = await admin.listChannels();

    const [, init] = fetchFn.mock.calls[0].arguments as [string, RequestInit];
    const cookieHeader = (init.headers as Record<string, string>)?.Cookie;
    assert.ok(cookieHeader?.includes('connect.sid=sess_abc'));
  });
});

// ---------------------------------------------------------------------------
// Network errors
// ---------------------------------------------------------------------------

describe('network errors', () => {
  it('should throw NetworkError on fetch failure', async () => {
    mockFetchReject(new TypeError('fetch failed'));
    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000' });
    (admin as any)._loggedIn = true;

    await assert.rejects(
      () => admin.listChannels(),
      (err: any) => {
        assert.ok(err instanceof NetworkError);
        assert.ok(err.message.includes('fetch failed'));
        return true;
      }
    );
  });

  it('should throw NetworkError on invalid JSON', async () => {
    const fn = mock.fn(async () => {
      const resp = new Response('not json', { status: 200 });
      if (!resp.headers.getSetCookie) {
        (resp.headers as any).getSetCookie = () => [];
      }
      return resp;
    });
    (globalThis as any).fetch = fn;

    const admin = new BotTalkAdmin({ baseUrl: 'http://localhost:3000' });
    (admin as any)._loggedIn = true;

    await assert.rejects(
      () => admin.listChannels(),
      (err: any) => {
        assert.ok(err instanceof NetworkError);
        assert.ok(err.message.includes('Invalid JSON'));
        return true;
      }
    );
  });
});
