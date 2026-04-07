package bottalk

import "encoding/json"

// ---------------------------------------------------------------------------
// Tier 1: Push API models
// ---------------------------------------------------------------------------

// ChannelResult holds the result of a single channel push attempt.
type ChannelResult struct {
	ChannelID    int    `json:"channel_id"`
	Status       string `json:"status"`
	TokenInvalid bool   `json:"token_invalid"`
	Reason       string `json:"reason,omitempty"`
}

// IsSuccess returns true if this channel push succeeded.
func (c *ChannelResult) IsSuccess() bool {
	return c.Status == "success"
}

// PushResult holds the result of a push operation.
type PushResult struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Results []ChannelResult // Per-channel results (parsed from data.results)
}

// IsSuccess returns true if the push succeeded (code == 0).
func (r *PushResult) IsSuccess() bool {
	return r.Code == 0
}

// apiResponse is the raw JSON response from the push API.
type apiResponse struct {
	Code    int              `json:"code"`
	Message string           `json:"message"`
	Data    *apiResponseData `json:"data,omitempty"`
}

type apiResponseData struct {
	Results []ChannelResult `json:"results,omitempty"`
}

// ---------------------------------------------------------------------------
// Tier 2: Admin API models
// ---------------------------------------------------------------------------

// UserInfo holds user information returned by login and me endpoints.
type UserInfo struct {
	ID           int    `json:"id"`
	Email        string `json:"email,omitempty"`
	SendKey      string `json:"send_key,omitempty"`
	ChannelCount int    `json:"channel_count,omitempty"`
}

// Channel represents a push channel.
type Channel struct {
	ID           int    `json:"id"`
	UserID       int    `json:"user_id"`
	Name         string `json:"name"`
	ChannelType  string `json:"channel_type"`
	WechatOpenID string `json:"wechat_openid,omitempty"`
	BotToken     string `json:"bot_token,omitempty"`
	ContextToken string `json:"context_token,omitempty"`
	Status       string `json:"status"`
	IsDefault    int    `json:"is_default"`
	CreatedAt    string `json:"created_at,omitempty"`
}

// QRResult holds the response from a QR code generation request.
type QRResult struct {
	QRCode    string `json:"qrcode"`
	QRCodeURL string `json:"qrcode_url,omitempty"`
	QRURL     string `json:"qr_url,omitempty"`
	URL       string `json:"url,omitempty"`
	ExpireTime int   `json:"expire_time,omitempty"`
}

// BindStatus holds the response from a bind status check.
type BindStatus struct {
	Status       string `json:"status,omitempty"`
	ID           int    `json:"id,omitempty"`
	SendKey      string `json:"send_key,omitempty"`
	WechatOpenID string `json:"wechat_openid,omitempty"`
	IsNew        bool   `json:"is_new,omitempty"`
	Rebind       bool   `json:"rebind,omitempty"`
	Name         string `json:"name,omitempty"`
	IsDefault    int    `json:"is_default,omitempty"`
}

// Reminder represents a scheduled reminder.
type Reminder struct {
	ID        int    `json:"id"`
	UserID    int    `json:"user_id,omitempty"`
	Title     string `json:"title"`
	Message   string `json:"message,omitempty"`
	Time      string `json:"time"`
	Type      string `json:"type"`
	Enabled   int    `json:"enabled,omitempty"`
	SendCount int    `json:"send_count,omitempty"`
	MaxCount  int    `json:"max_count,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
}

// CreateReminderOpts holds options for creating a reminder.
type CreateReminderOpts struct {
	Title    string `json:"title"`
	Time     string `json:"time"`
	Type     string `json:"type,omitempty"`     // "once" (default), "daily", "every2min"
	Message  string `json:"message,omitempty"`
	MaxCount int    `json:"max_count,omitempty"`
}

// PushLog represents a push log entry.
type PushLog struct {
	ID          int    `json:"id"`
	UserID      int    `json:"user_id,omitempty"`
	Title       string `json:"title,omitempty"`
	Content     string `json:"content,omitempty"`
	Status      string `json:"status,omitempty"`
	IP          string `json:"ip,omitempty"`
	ChannelID   int    `json:"channel_id,omitempty"`
	ChannelName string `json:"channel_name,omitempty"`
	Response    string `json:"response,omitempty"`
	CreatedAt   string `json:"created_at,omitempty"`
}

// adminAPIResponse is the raw JSON response from the admin API.
// Admin API uses { success: bool, data: ..., error: ... } format.
type adminAPIResponse struct {
	Success bool                `json:"success"`
	Data    jsonRawMessageBytes `json:"data,omitempty"`
	Error   string              `json:"error,omitempty"`
	ID      int                 `json:"id,omitempty"` // some endpoints return { success, id }
}

// jsonRawMessageBytes is a raw JSON value that delays unmarshalling.
type jsonRawMessageBytes = json.RawMessage
