# BotTalk Python SDK

Push messages to WeChat via [bot-talk.com](https://bot-talk.com) -- an open-source Server-Chan alternative.

## Install

```bash
pip install bottalk
```

## Quick Start

```python
from bottalk import BotTalk

client = BotTalk("YOUR_SEND_KEY")
result = client.send("Hello from Python!", desp="Message body in **Markdown**")
print(result)  # PushResult(code=0, message='success')
```

## Self-hosted

```python
client = BotTalk("YOUR_KEY", base_url="https://your-server.example.com")
```

## API

### `BotTalk(key, base_url="https://bot-talk.com", timeout=30)`

### `client.send(title="", desp="", channel="", method="POST") -> PushResult`

| Parameter | Description |
|-----------|-------------|
| `title`   | Message title |
| `desp`    | Message body (Markdown) |
| `channel` | `"default"`, `"all"`, or comma-separated channel IDs |
| `method`  | `"GET"` or `"POST"` (default) |

### Exceptions

| Exception | Code | Meaning |
|-----------|------|---------|
| `EmptyMessageError` | 40003 | Both title and desp are empty |
| `InvalidKeyError` | 40001 | SendKey is invalid |
| `NoChannelError` | 40002 | No active channel configured |
| `RateLimitError` | 42901 | Hourly limit exceeded |
| `PushFailedError` | 50001 | All channels failed |
| `NetworkError` | -1 | Connection / timeout error |

## License

MIT
