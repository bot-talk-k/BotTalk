package bottalk

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"time"
)

// ---------------------------------------------------------------------------
// Admin client
// ---------------------------------------------------------------------------

// Admin is a session-based management client for bot-talk.com.
//
// Usage:
//
//	admin := bottalk.NewAdmin()
//	user, err := admin.Login("YOUR_SEND_KEY")
//	channels, err := admin.ListChannels()
type Admin struct {
	baseURL    string
	httpClient *http.Client
	loggedIn   bool
}

// AdminOption configures the Admin constructor.
type AdminOption func(*Admin)

// WithAdminBaseURL sets a custom server URL for the Admin client.
func WithAdminBaseURL(baseURL string) AdminOption {
	return func(a *Admin) {
		a.baseURL = trimTrailingSlash(baseURL)
	}
}

// WithAdminTimeout sets the HTTP request timeout for the Admin client.
func WithAdminTimeout(d time.Duration) AdminOption {
	return func(a *Admin) {
		a.httpClient.Timeout = d
	}
}

// NewAdmin creates a new Admin client with a cookie jar for session management.
func NewAdmin(opts ...AdminOption) *Admin {
	jar, _ := cookiejar.New(nil) // standard library jar never returns error
	a := &Admin{
		baseURL: DefaultBaseURL,
		httpClient: &http.Client{
			Timeout: DefaultTimeout,
			Jar:     jar,
		},
	}
	for _, opt := range opts {
		opt(a)
	}
	return a
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// Login authenticates with a SendKey and stores the session cookie.
func (a *Admin) Login(sendKey string) (*UserInfo, error) {
	body := map[string]string{"send_key": sendKey}
	var user UserInfo
	if err := a.doJSON("POST", "/api/auth/login", body, &user); err != nil {
		return nil, err
	}
	a.loggedIn = true
	return &user, nil
}

// Logout destroys the session.
func (a *Admin) Logout() error {
	err := a.doJSON("POST", "/api/auth/logout", map[string]string{}, nil)
	a.loggedIn = false
	// Clear cookies by replacing the jar
	jar, _ := cookiejar.New(nil)
	a.httpClient.Jar = jar
	return err
}

// Me returns the current user info. Requires a logged-in session.
func (a *Admin) Me() (*UserInfo, error) {
	if err := a.requireLogin(); err != nil {
		return nil, err
	}
	var user UserInfo
	if err := a.doJSON("GET", "/api/auth/me", nil, &user); err != nil {
		return nil, err
	}
	return &user, nil
}

// ---------------------------------------------------------------------------
// Channel management
// ---------------------------------------------------------------------------

// ListChannels returns all channels for the current user.
func (a *Admin) ListChannels() ([]Channel, error) {
	if err := a.requireLogin(); err != nil {
		return nil, err
	}
	var channels []Channel
	if err := a.doJSON("GET", "/api/channels/", nil, &channels); err != nil {
		return nil, err
	}
	return channels, nil
}

// DeleteChannel soft-deletes a channel by ID.
func (a *Admin) DeleteChannel(id int) error {
	if err := a.requireLogin(); err != nil {
		return err
	}
	return a.doJSON("DELETE", fmt.Sprintf("/api/channels/%d", id), nil, nil)
}

// GetQR generates a QR code for channel binding.
func (a *Admin) GetQR() (*QRResult, error) {
	if err := a.requireLogin(); err != nil {
		return nil, err
	}
	var qr QRResult
	if err := a.doJSON("POST", "/api/channels/qrcode", map[string]string{}, &qr); err != nil {
		return nil, err
	}
	return &qr, nil
}

// CheckBindStatus checks the binding status of a QR code.
func (a *Admin) CheckBindStatus(qrcode string) (*BindStatus, error) {
	if err := a.requireLogin(); err != nil {
		return nil, err
	}
	var status BindStatus
	path := "/api/channels/bind-status/" + url.PathEscape(qrcode)
	if err := a.doJSON("GET", path, nil, &status); err != nil {
		return nil, err
	}
	return &status, nil
}

// ---------------------------------------------------------------------------
// BindingSession — high-level QR binding workflow
// ---------------------------------------------------------------------------

// BindingSession represents an in-progress QR binding flow.
type BindingSession struct {
	QRUrl  string // URL of the QR code image to display / scan.
	QRCode string // Token used to poll binding status.
	admin  *Admin
}

// StartBinding starts a QR binding flow and returns a BindingSession.
func (a *Admin) StartBinding() (*BindingSession, error) {
	qr, err := a.GetQR()
	if err != nil {
		return nil, err
	}
	qrURL := qr.QRURL
	if qrURL == "" {
		qrURL = qr.QRCodeURL
	}
	if qrURL == "" {
		qrURL = qr.URL
	}
	return &BindingSession{
		QRUrl:  qrURL,
		QRCode: qr.QRCode,
		admin:  a,
	}, nil
}

// Wait polls until the QR code is scanned and binding completes.
// timeout is capped at 300 seconds. interval defaults to 2 seconds.
func (bs *BindingSession) Wait(timeout time.Duration, interval ...time.Duration) (*BindStatus, error) {
	const maxTimeout = 300 * time.Second
	if timeout > maxTimeout {
		timeout = maxTimeout
	}
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	pollInterval := 2 * time.Second
	if len(interval) > 0 && interval[0] > 0 {
		pollInterval = interval[0]
	}

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		result, err := bs.admin.CheckBindStatus(bs.QRCode)
		if err != nil {
			return nil, err
		}
		// Binding complete when we get an id/send_key or status is active/pending
		if result.ID != 0 || result.SendKey != "" || result.Status == "active" || result.Status == "pending" {
			return result, nil
		}
		if result.Status == "expired" {
			return nil, &BotTalkError{Code: -1, Message: "QR code expired"}
		}
		time.Sleep(pollInterval)
	}
	return nil, &BotTalkError{Code: -1, Message: fmt.Sprintf("Binding not completed within %v", timeout)}
}

// String returns a safe representation of the BindingSession.
func (bs *BindingSession) String() string {
	return fmt.Sprintf("BindingSession(qrcode=%q)", bs.QRCode)
}

// ---------------------------------------------------------------------------
// Reminder management
// ---------------------------------------------------------------------------

// ListReminders returns all reminders for the current user.
func (a *Admin) ListReminders() ([]Reminder, error) {
	if err := a.requireLogin(); err != nil {
		return nil, err
	}
	var reminders []Reminder
	if err := a.doJSON("GET", "/api/reminders/", nil, &reminders); err != nil {
		return nil, err
	}
	return reminders, nil
}

// CreateReminder creates a new reminder.
func (a *Admin) CreateReminder(opts CreateReminderOpts) (*Reminder, error) {
	if err := a.requireLogin(); err != nil {
		return nil, err
	}
	if opts.Type == "" {
		opts.Type = "once"
	}
	body := map[string]interface{}{
		"title":     opts.Title,
		"time":      opts.Time,
		"type":      opts.Type,
		"message":   opts.Message,
		"max_count": opts.MaxCount,
	}
	// The server returns { success: true, id: N } for reminder creation
	raw, err := a.doJSONRaw("POST", "/api/reminders/", body)
	if err != nil {
		return nil, err
	}
	// Try to parse full Reminder from data
	var reminder Reminder
	if err := json.Unmarshal(raw.Data, &reminder); err == nil && reminder.ID != 0 {
		return &reminder, nil
	}
	// Fall back: server may return { success, id }
	if raw.ID != 0 {
		reminder = Reminder{
			ID:      raw.ID,
			Title:   opts.Title,
			Time:    opts.Time,
			Type:    opts.Type,
			Message: opts.Message,
		}
		return &reminder, nil
	}
	return &reminder, nil
}

// DeleteReminder deletes a reminder by ID.
func (a *Admin) DeleteReminder(id int) error {
	if err := a.requireLogin(); err != nil {
		return err
	}
	return a.doJSON("DELETE", fmt.Sprintf("/api/reminders/%d", id), nil, nil)
}

// ---------------------------------------------------------------------------
// Push logs
// ---------------------------------------------------------------------------

// GetPushLogs returns recent push logs.
func (a *Admin) GetPushLogs() ([]PushLog, error) {
	if err := a.requireLogin(); err != nil {
		return nil, err
	}
	var logs []PushLog
	if err := a.doJSON("GET", "/api/push-logs/", nil, &logs); err != nil {
		return nil, err
	}
	return logs, nil
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

// GetSendKey returns the current SendKey.
func (a *Admin) GetSendKey() (string, error) {
	if err := a.requireLogin(); err != nil {
		return "", err
	}
	var data struct {
		SendKey string `json:"send_key"`
	}
	if err := a.doJSON("GET", "/api/key/", nil, &data); err != nil {
		return "", err
	}
	return data.SendKey, nil
}

// ResetSendKey resets the SendKey and returns the new one.
func (a *Admin) ResetSendKey() (string, error) {
	if err := a.requireLogin(); err != nil {
		return "", err
	}
	var data struct {
		SendKey string `json:"send_key"`
	}
	if err := a.doJSON("POST", "/api/key/reset", map[string]string{}, &data); err != nil {
		return "", err
	}
	return data.SendKey, nil
}

// ---------------------------------------------------------------------------
// String (safe — never exposes cookies or keys)
// ---------------------------------------------------------------------------

// String returns a safe representation of the Admin client.
func (a *Admin) String() string {
	status := "not_logged_in"
	if a.loggedIn {
		status = "logged_in"
	}
	return fmt.Sprintf("BotTalkAdmin(baseURL=%q, status=%s)", a.baseURL, status)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

func (a *Admin) requireLogin() error {
	if !a.loggedIn {
		return &BotTalkError{Code: -1, Message: "Not logged in. Call Login() first."}
	}
	return nil
}

// doJSON executes an HTTP request and unmarshals the "data" field into dest.
// If dest is nil, only success is checked.
func (a *Admin) doJSON(method, path string, body interface{}, dest interface{}) error {
	raw, err := a.doJSONRaw(method, path, body)
	if err != nil {
		return err
	}
	if dest != nil && len(raw.Data) > 0 {
		if err := json.Unmarshal(raw.Data, dest); err != nil {
			return &NetworkError{BotTalkError{Code: -1, Message: "failed to unmarshal response data: " + err.Error()}}
		}
	}
	return nil
}

// doJSONRaw executes the request and returns the parsed adminAPIResponse.
func (a *Admin) doJSONRaw(method, path string, body interface{}) (*adminAPIResponse, error) {
	reqURL := a.baseURL + path

	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, &NetworkError{BotTalkError{Code: -1, Message: "failed to marshal request body: " + err.Error()}}
		}
		reqBody = bytes.NewReader(b)
	}

	req, err := http.NewRequest(method, reqURL, reqBody)
	if err != nil {
		return nil, &NetworkError{BotTalkError{Code: -1, Message: err.Error()}}
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return nil, &NetworkError{BotTalkError{Code: -1, Message: err.Error()}}
	}
	defer resp.Body.Close()

	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &NetworkError{BotTalkError{Code: -1, Message: "failed to read response body: " + err.Error()}}
	}

	var apiResp adminAPIResponse
	if err := json.Unmarshal(rawBody, &apiResp); err != nil {
		return nil, &NetworkError{BotTalkError{Code: -1, Message: "invalid JSON response: " + string(rawBody[:minInt(len(rawBody), 200)])}}
	}

	if !apiResp.Success {
		// Try to extract error from data.error (nested)
		errMsg := apiResp.Error
		if errMsg == "" && len(apiResp.Data) > 0 {
			var nested struct {
				Error   string `json:"error"`
				Message string `json:"message"`
			}
			if json.Unmarshal(apiResp.Data, &nested) == nil {
				if nested.Error != "" {
					errMsg = nested.Error
				} else if nested.Message != "" {
					errMsg = nested.Message
				}
			}
		}
		if errMsg == "" {
			errMsg = "Unknown error"
		}
		return nil, &BotTalkError{Code: -1, Message: errMsg}
	}

	return &apiResp, nil
}

func trimTrailingSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
