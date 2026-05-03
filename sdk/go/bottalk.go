// Package bottalk provides a zero-dependency client for the bot-talk.com push API.
//
// Usage:
//
//	client := bottalk.New("YOUR_KEY")
//	result, err := client.Send("Hello!", bottalk.WithDesp("World"))
package bottalk

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Default values.
const (
	DefaultBaseURL = "https://bot-talk.com"
	DefaultTimeout = 30 * time.Second
)

// keyPattern validates SendKey format: alphanumeric, dash, underscore, 1-256 chars.
var keyPattern = regexp.MustCompile(`^[A-Za-z0-9_\-]{1,256}$`)

// Client is the BotTalk push client.
type Client struct {
	key     string
	baseURL string
	timeout time.Duration
	client  *http.Client
}

// --- Client options (functional options pattern) ---

// ClientOption configures the Client constructor.
type ClientOption func(*Client)

// WithBaseURL sets a custom server URL.
func WithBaseURL(baseURL string) ClientOption {
	return func(c *Client) {
		c.baseURL = strings.TrimRight(baseURL, "/")
	}
}

// WithTimeout sets the HTTP request timeout.
func WithTimeout(d time.Duration) ClientOption {
	return func(c *Client) {
		c.timeout = d
		c.client = &http.Client{Timeout: d}
	}
}

// New creates a new BotTalk client.
//
// The key is validated against the pattern [A-Za-z0-9_-]{1,256}.
// Panics if the key is empty or invalid (fail-fast at init time).
func New(key string, opts ...ClientOption) *Client {
	if key == "" {
		panic("bottalk: key must be a non-empty string")
	}
	if !keyPattern.MatchString(key) {
		panic("bottalk: key contains invalid characters (only alphanumeric, dash, underscore allowed)")
	}

	c := &Client{
		key:     key,
		baseURL: DefaultBaseURL,
		timeout: DefaultTimeout,
	}
	c.client = &http.Client{Timeout: c.timeout}

	for _, opt := range opts {
		opt(c)
	}
	return c
}

// --- Send options (functional options pattern) ---

// SendOption configures a Send call.
type SendOption func(*sendConfig)

type sendConfig struct {
	desp    string
	channel string
	method  string // "GET" or "POST"
}

// WithDesp sets the message body / description (Markdown supported).
func WithDesp(desp string) SendOption {
	return func(cfg *sendConfig) {
		cfg.desp = desp
	}
}

// WithChannel sets the target channel(s) -- "default", "all", or comma-separated IDs.
func WithChannel(channel string) SendOption {
	return func(cfg *sendConfig) {
		cfg.channel = channel
	}
}

// WithMethod sets the HTTP method ("GET" or "POST"). Default is "POST".
func WithMethod(method string) SendOption {
	return func(cfg *sendConfig) {
		cfg.method = strings.ToUpper(method)
	}
}

// Send pushes a message.
//
// Returns a *PushResult on success, or an error (typed as *BotTalkError
// or one of its subtypes: *InvalidKeyError, *NoChannelError, etc.).
func (c *Client) Send(title string, opts ...SendOption) (*PushResult, error) {
	cfg := &sendConfig{method: "POST"}
	for _, opt := range opts {
		opt(cfg)
	}

	if title == "" && cfg.desp == "" {
		return nil, &EmptyMessageError{BotTalkError{Code: 40003, Message: "Title and content cannot both be empty"}}
	}

	if cfg.method != "GET" && cfg.method != "POST" {
		return nil, fmt.Errorf("bottalk: method must be 'GET' or 'POST', got %q", cfg.method)
	}

	// Build URL: /{key}.send  (key is URL-encoded for safety)
	endpoint := fmt.Sprintf("%s/%s.send", c.baseURL, url.PathEscape(c.key))

	// Build form params
	params := url.Values{}
	if title != "" {
		params.Set("title", title)
	}
	if cfg.desp != "" {
		params.Set("desp", cfg.desp)
	}
	if cfg.channel != "" {
		params.Set("channel", cfg.channel)
	}

	return c.doRequest(endpoint, params, cfg.method)
}

// doRequest executes the HTTP request and parses the response.
func (c *Client) doRequest(endpoint string, params url.Values, method string) (*PushResult, error) {
	var req *http.Request
	var err error

	if method == "GET" {
		u := endpoint
		if encoded := params.Encode(); encoded != "" {
			u = endpoint + "?" + encoded
		}
		req, err = http.NewRequest("GET", u, nil)
	} else {
		body := params.Encode()
		req, err = http.NewRequest("POST", endpoint, strings.NewReader(body))
		if err == nil {
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
	}
	if err != nil {
		return nil, &NetworkError{BotTalkError{Code: -1, Message: err.Error()}}
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, &NetworkError{BotTalkError{Code: -1, Message: err.Error()}}
	}
	defer resp.Body.Close()

	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &NetworkError{BotTalkError{Code: -1, Message: "failed to read response body: " + err.Error()}}
	}

	var apiResp apiResponse
	if err := json.Unmarshal(rawBody, &apiResp); err != nil {
		return nil, &NetworkError{BotTalkError{Code: -1, Message: "invalid JSON response: " + string(rawBody[:min(len(rawBody), 200)])}}
	}

	if apiResp.Code != 0 {
		// 50001 carries reason + hint that tell the developer exactly what
		// the receiver should do (most often: reply to ClawBot in WeChat).
		if apiResp.Code == 50001 && apiResp.Data != nil {
			return nil, newErrorFromResponse(apiResp.Code, apiResp.Message, apiResp.Data.Reason, apiResp.Data.Hint)
		}
		return nil, newErrorFromCode(apiResp.Code, apiResp.Message)
	}

	result := &PushResult{
		Code:    apiResp.Code,
		Message: apiResp.Message,
	}
	if apiResp.Data != nil {
		result.Results = apiResp.Data.Results
	}

	return result, nil
}

// String returns a safe representation that never exposes the full key.
func (c *Client) String() string {
	masked := "***"
	if len(c.key) > 3 {
		masked = c.key[:3] + "***"
	}
	return fmt.Sprintf("BotTalk(key=%q, baseURL=%q)", masked, c.baseURL)
}
