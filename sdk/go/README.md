# BotTalk Go SDK

Zero-dependency Go client for the [bot-talk.com](https://bot-talk.com) push API.

## Install

```bash
go get github.com/bot-talk-k/BotTalk-go
```

## Quick Start

```go
package main

import (
    "fmt"
    "log"

    bottalk "github.com/bot-talk-k/BotTalk-go"
)

func main() {
    client := bottalk.New("YOUR_SEND_KEY")

    result, err := client.Send("Hello!",
        bottalk.WithDesp("Message body in **Markdown**"),
    )
    if err != nil {
        if bottalk.IsRateLimit(err) {
            log.Fatal("Rate limited, try again later")
        }
        log.Fatal(err)
    }

    fmt.Printf("Pushed to %d channel(s)\n", len(result.Results))
}
```

## Options

### Client Options

```go
client := bottalk.New("YOUR_KEY",
    bottalk.WithBaseURL("https://my-server.com"),
    bottalk.WithTimeout(10 * time.Second),
)
```

### Send Options

```go
result, err := client.Send("Title",
    bottalk.WithDesp("Body"),
    bottalk.WithChannel("all"),
    bottalk.WithMethod("GET"),
)
```

## Error Handling

All server errors are returned as typed errors with `Is*` helper functions:

```go
_, err := client.Send("Hello")
if err != nil {
    switch {
    case bottalk.IsInvalidKey(err):
        // 40001: invalid key
    case bottalk.IsNoChannel(err):
        // 40002: no active channel
    case bottalk.IsEmptyMessage(err):
        // 40003: empty message
    case bottalk.IsRateLimit(err):
        // 42901: rate limit exceeded
    case bottalk.IsPushFailed(err):
        // 50001: all channels failed
    case bottalk.IsNetwork(err):
        // network / timeout error
    }
}
```

## Security

- The key is never exposed in `String()` output or logs (masked as `abc***`).
- Key format is validated at construction: `[A-Za-z0-9_-]{1,256}`.
- All URL parameters are properly encoded.
