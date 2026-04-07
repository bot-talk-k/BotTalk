# BotTalk Node.js SDK

Official Node.js SDK for [bot-talk.com](https://bot-talk.com) push service.

## Features

- Zero external dependencies (uses built-in `fetch`)
- Full TypeScript support with complete type definitions
- 3 lines of code to send a message
- Supports custom self-hosted servers
- Named exceptions for each error code
- async/await API

## Installation

```bash
npm install bottalk
```

## Quick Start

```typescript
import { BotTalk } from 'bottalk';

const os = new BotTalk('YOUR_KEY');
await os.send('Hello!', { desp: 'Message body in **Markdown**' });
```

## Usage

### Basic send

```typescript
const result = await os.send('Title');
console.log(result.isSuccess); // true
```

### Send with options

```typescript
const result = await os.send('Title', {
  desp: 'Message body',       // Markdown supported
  channel: 'all',             // "default", "all", or comma-separated IDs
  method: 'GET',              // Default is "POST"
});
```

### Custom server (self-hosted)

```typescript
const os = new BotTalk('YOUR_KEY', {
  baseUrl: 'https://your-server.com',
  timeout: 10000, // ms
});
```

### Error handling

```typescript
import {
  BotTalk,
  InvalidKeyError,
  RateLimitError,
  NetworkError,
} from 'bottalk';

try {
  await os.send('Hello');
} catch (err) {
  if (err instanceof RateLimitError) {
    console.log('Too many requests, wait and retry');
  } else if (err instanceof InvalidKeyError) {
    console.log('Check your SendKey');
  } else if (err instanceof NetworkError) {
    console.log('Network issue:', err.message);
  }
}
```

### Inspect channel results

```typescript
const result = await os.send('Hello');
for (const ch of result.results) {
  console.log(`${ch.channelId}: ${ch.status}`);
  if (ch.tokenInvalid) console.log('  Token expired!');
}
```

## Error Codes

| Code  | Exception          | Description                    |
|-------|--------------------|--------------------------------|
| 40001 | `InvalidKeyError`  | SendKey is invalid             |
| 40002 | `NoChannelError`   | No active push channel         |
| 40003 | `EmptyMessageError`| Title and content both empty   |
| 42901 | `RateLimitError`   | Rate limit exceeded            |
| 50001 | `PushFailedError`  | All push channels failed       |
| -1    | `NetworkError`     | Network / timeout error        |

## Requirements

- Node.js >= 18.0.0 (uses built-in `fetch`)

## Development

```bash
# Run tests (requires Node.js >= 22 with --experimental-strip-types)
node --experimental-strip-types --test tests/client.test.ts

# Build
npx tsc
```

## License

MIT
