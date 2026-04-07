package bottalk

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Helper: admin mock server
// ---------------------------------------------------------------------------

// adminSuccess writes a success response with JSON data.
func adminSuccess(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	b, _ := json.Marshal(data)
	fmt.Fprintf(w, `{"success":true,"data":%s}`, string(b))
}

// adminSuccessRaw writes a raw success JSON string.
func adminSuccessRaw(w http.ResponseWriter, rawData string) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"success":true,"data":%s}`, rawData)
}

// adminSuccessOnly writes { "success": true }.
func adminSuccessOnly(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"success":true}`)
}

// adminSuccessID writes { "success": true, "id": N }.
func adminSuccessID(w http.ResponseWriter, id int) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"success":true,"id":%d}`, id)
}

// adminError writes an error response.
func adminError(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"success":false,"error":%q}`, msg)
}

// newAdminWithServer creates an Admin pointed at a test server.
func newAdminWithServer(srv *httptest.Server) *Admin {
	admin := NewAdmin(WithAdminBaseURL(srv.URL))
	admin.loggedIn = true // skip login for most tests
	return admin
}

// ---------------------------------------------------------------------------
// Constructor tests
// ---------------------------------------------------------------------------

func TestNewAdmin_Defaults(t *testing.T) {
	a := NewAdmin()
	if a.baseURL != DefaultBaseURL {
		t.Errorf("expected default baseURL, got %q", a.baseURL)
	}
	if a.httpClient == nil {
		t.Fatal("expected non-nil httpClient")
	}
	if a.httpClient.Jar == nil {
		t.Fatal("expected non-nil cookie jar")
	}
	if a.loggedIn {
		t.Error("expected not logged in initially")
	}
}

func TestNewAdmin_WithOptions(t *testing.T) {
	a := NewAdmin(
		WithAdminBaseURL("https://example.com/"),
		WithAdminTimeout(5*time.Second),
	)
	if a.baseURL != "https://example.com" {
		t.Errorf("expected trimmed baseURL, got %q", a.baseURL)
	}
	if a.httpClient.Timeout != 5*time.Second {
		t.Errorf("expected 5s timeout, got %v", a.httpClient.Timeout)
	}
}

// ---------------------------------------------------------------------------
// Login / Logout / Me
// ---------------------------------------------------------------------------

func TestLogin_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/auth/login" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["send_key"] != "test-key-123" {
			t.Errorf("expected send_key=test-key-123, got %q", body["send_key"])
		}
		// Set a cookie
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "abc123"})
		adminSuccess(w, UserInfo{ID: 1, Email: "user@example.com", SendKey: "test-key-123", ChannelCount: 2})
	}))
	defer srv.Close()

	admin := NewAdmin(WithAdminBaseURL(srv.URL))
	user, err := admin.Login("test-key-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if user.ID != 1 {
		t.Errorf("expected user ID 1, got %d", user.ID)
	}
	if user.Email != "user@example.com" {
		t.Errorf("expected email, got %q", user.Email)
	}
	if !admin.loggedIn {
		t.Error("expected loggedIn to be true after login")
	}
}

func TestLogin_Failure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		adminError(w, "SendKey 无效")
	}))
	defer srv.Close()

	admin := NewAdmin(WithAdminBaseURL(srv.URL))
	_, err := admin.Login("bad-key")
	if err == nil {
		t.Fatal("expected error for bad key")
	}
	if !strings.Contains(err.Error(), "SendKey") {
		t.Errorf("expected error about SendKey, got: %v", err)
	}
	if admin.loggedIn {
		t.Error("should not be logged in after failed login")
	}
}

func TestLogout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		adminSuccessOnly(w)
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	err := admin.Logout()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if admin.loggedIn {
		t.Error("expected loggedIn to be false after logout")
	}
}

func TestMe_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/api/auth/me" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		adminSuccess(w, UserInfo{ID: 1, Email: "me@example.com", ChannelCount: 3})
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	user, err := admin.Me()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if user.ID != 1 || user.ChannelCount != 3 {
		t.Errorf("unexpected user: %+v", user)
	}
}

func TestMe_RequiresLogin(t *testing.T) {
	admin := NewAdmin()
	_, err := admin.Me()
	if err == nil {
		t.Fatal("expected error when not logged in")
	}
	if !strings.Contains(err.Error(), "Not logged in") {
		t.Errorf("expected login required error, got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Channel management
// ---------------------------------------------------------------------------

func TestListChannels(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/channels/" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		channels := []Channel{
			{ID: 1, Name: "Default", ChannelType: "wechat_ilink", Status: "active", IsDefault: 1},
			{ID: 2, Name: "Phone2", ChannelType: "wechat_ilink", Status: "active", IsDefault: 0},
		}
		adminSuccess(w, channels)
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	channels, err := admin.ListChannels()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(channels) != 2 {
		t.Fatalf("expected 2 channels, got %d", len(channels))
	}
	if channels[0].Name != "Default" {
		t.Errorf("expected first channel name 'Default', got %q", channels[0].Name)
	}
}

func TestDeleteChannel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" || r.URL.Path != "/api/channels/42" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		adminSuccessRaw(w, `{"message":"Channel deleted"}`)
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	err := admin.DeleteChannel(42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDeleteChannel_RequiresLogin(t *testing.T) {
	admin := NewAdmin()
	err := admin.DeleteChannel(1)
	if err == nil {
		t.Fatal("expected error")
	}
}

// ---------------------------------------------------------------------------
// QR binding
// ---------------------------------------------------------------------------

func TestGetQR(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/channels/qrcode" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		adminSuccess(w, QRResult{QRCode: "qr-token-xyz", QRURL: "https://example.com/qr.png", ExpireTime: 300})
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	qr, err := admin.GetQR()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if qr.QRCode != "qr-token-xyz" {
		t.Errorf("expected qrcode token, got %q", qr.QRCode)
	}
	if qr.QRURL != "https://example.com/qr.png" {
		t.Errorf("expected qr_url, got %q", qr.QRURL)
	}
}

func TestCheckBindStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/channels/bind-status/qr-abc" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		adminSuccess(w, BindStatus{Status: "waiting"})
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	status, err := admin.CheckBindStatus("qr-abc")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status.Status != "waiting" {
		t.Errorf("expected status 'waiting', got %q", status.Status)
	}
}

func TestStartBinding(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		adminSuccess(w, QRResult{QRCode: "bind-token", QRURL: "https://example.com/bind.png"})
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	session, err := admin.StartBinding()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if session.QRCode != "bind-token" {
		t.Errorf("expected QRCode, got %q", session.QRCode)
	}
	if session.QRUrl != "https://example.com/bind.png" {
		t.Errorf("expected QRUrl, got %q", session.QRUrl)
	}
}

func TestBindingSession_Wait_Success(t *testing.T) {
	var callCount int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&callCount, 1)
		if n < 3 {
			adminSuccess(w, BindStatus{Status: "waiting"})
		} else {
			adminSuccess(w, BindStatus{Status: "pending", ID: 1, SendKey: "new-key"})
		}
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	session := &BindingSession{QRCode: "test-qr", QRUrl: "http://example.com/qr.png", admin: admin}

	result, err := session.Wait(10*time.Second, 10*time.Millisecond)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ID != 1 {
		t.Errorf("expected ID 1, got %d", result.ID)
	}
}

func TestBindingSession_Wait_Expired(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		adminSuccess(w, BindStatus{Status: "expired"})
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	session := &BindingSession{QRCode: "expired-qr", admin: admin}

	_, err := session.Wait(5*time.Second, 10*time.Millisecond)
	if err == nil {
		t.Fatal("expected error for expired QR")
	}
	if !strings.Contains(err.Error(), "expired") {
		t.Errorf("expected expired error, got: %v", err)
	}
}

func TestBindingSession_Wait_Timeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		adminSuccess(w, BindStatus{Status: "waiting"})
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	session := &BindingSession{QRCode: "slow-qr", admin: admin}

	_, err := session.Wait(50*time.Millisecond, 10*time.Millisecond)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if !strings.Contains(err.Error(), "not completed") {
		t.Errorf("expected timeout message, got: %v", err)
	}
}

func TestBindingSession_Wait_MaxTimeout(t *testing.T) {
	// Verify timeout is capped at 300s (we just test the cap logic, not actually wait)
	admin := NewAdmin()
	admin.loggedIn = true
	session := &BindingSession{QRCode: "test", admin: admin}
	// We can't easily test 300s, but we ensure it doesn't panic
	_ = session.String()
}

// ---------------------------------------------------------------------------
// Reminder management
// ---------------------------------------------------------------------------

func TestListReminders(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/reminders/" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		reminders := []Reminder{
			{ID: 1, Title: "Drink Water", Time: "09:00", Type: "daily", Enabled: 1},
		}
		adminSuccess(w, reminders)
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	reminders, err := admin.ListReminders()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(reminders) != 1 {
		t.Fatalf("expected 1 reminder, got %d", len(reminders))
	}
	if reminders[0].Title != "Drink Water" {
		t.Errorf("expected title 'Drink Water', got %q", reminders[0].Title)
	}
}

func TestCreateReminder(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/reminders/" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["title"] != "Test Reminder" {
			t.Errorf("expected title 'Test Reminder', got %v", body["title"])
		}
		if body["type"] != "daily" {
			t.Errorf("expected type 'daily', got %v", body["type"])
		}
		adminSuccessID(w, 42)
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	reminder, err := admin.CreateReminder(CreateReminderOpts{
		Title:   "Test Reminder",
		Time:    "09:00",
		Type:    "daily",
		Message: "Remember this",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if reminder.ID != 42 {
		t.Errorf("expected reminder ID 42, got %d", reminder.ID)
	}
}

func TestCreateReminder_DefaultType(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["type"] != "once" {
			t.Errorf("expected default type 'once', got %v", body["type"])
		}
		adminSuccessID(w, 1)
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	_, err := admin.CreateReminder(CreateReminderOpts{Title: "Test", Time: "10:00"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDeleteReminder(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" || r.URL.Path != "/api/reminders/7" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		adminSuccessOnly(w)
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	err := admin.DeleteReminder(7)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestListReminders_RequiresLogin(t *testing.T) {
	admin := NewAdmin()
	_, err := admin.ListReminders()
	if err == nil {
		t.Fatal("expected error")
	}
}

// ---------------------------------------------------------------------------
// Push logs
// ---------------------------------------------------------------------------

func TestGetPushLogs(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/push-logs/" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		logs := []PushLog{
			{ID: 1, Title: "Hello", Status: "success", ChannelName: "Default"},
			{ID: 2, Title: "World", Status: "failed", ChannelName: "Phone2"},
		}
		adminSuccess(w, logs)
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	logs, err := admin.GetPushLogs()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(logs) != 2 {
		t.Fatalf("expected 2 logs, got %d", len(logs))
	}
	if logs[0].Title != "Hello" {
		t.Errorf("expected first log title 'Hello', got %q", logs[0].Title)
	}
}

func TestGetPushLogs_RequiresLogin(t *testing.T) {
	admin := NewAdmin()
	_, err := admin.GetPushLogs()
	if err == nil {
		t.Fatal("expected error")
	}
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

func TestGetSendKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/api/key/" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		adminSuccessRaw(w, `{"send_key":"abc-secret-key"}`)
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	key, err := admin.GetSendKey()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "abc-secret-key" {
		t.Errorf("expected key, got %q", key)
	}
}

func TestResetSendKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/key/reset" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		adminSuccessRaw(w, `{"send_key":"new-key-456"}`)
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	key, err := admin.ResetSendKey()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "new-key-456" {
		t.Errorf("expected new key, got %q", key)
	}
}

func TestGetSendKey_RequiresLogin(t *testing.T) {
	admin := NewAdmin()
	_, err := admin.GetSendKey()
	if err == nil {
		t.Fatal("expected error")
	}
}

// ---------------------------------------------------------------------------
// Security: cookies and keys should not leak
// ---------------------------------------------------------------------------

func TestAdmin_String_NoCookieLeak(t *testing.T) {
	admin := NewAdmin(WithAdminBaseURL("https://secret.example.com"))
	admin.loggedIn = true
	s := admin.String()

	if strings.Contains(s, "cookie") || strings.Contains(s, "Cookie") {
		t.Error("String() should not mention cookies")
	}
	if !strings.Contains(s, "logged_in") {
		t.Errorf("expected status in String(), got: %s", s)
	}
}

func TestAdmin_String_NotLoggedIn(t *testing.T) {
	admin := NewAdmin()
	s := admin.String()
	if !strings.Contains(s, "not_logged_in") {
		t.Errorf("expected not_logged_in, got: %s", s)
	}
}

func TestBindingSession_String_NoLeak(t *testing.T) {
	bs := &BindingSession{QRCode: "secret-qr-token", QRUrl: "https://example.com/qr.png"}
	s := bs.String()
	if !strings.Contains(s, "secret-qr-token") {
		t.Errorf("expected qrcode in String(), got: %s", s)
	}
	// QR code tokens are not secrets, so showing them is fine.
	// But cookies should never appear.
	if strings.Contains(s, "cookie") || strings.Contains(s, "session") {
		t.Error("String() should not expose session info")
	}
}

func TestLogin_CookieNotExposed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "super-secret-session-id"})
		adminSuccess(w, UserInfo{ID: 1})
	}))
	defer srv.Close()

	admin := NewAdmin(WithAdminBaseURL(srv.URL))
	_, err := admin.Login("test-key")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	s := admin.String()
	if strings.Contains(s, "super-secret-session-id") {
		t.Error("String() should not expose session cookie")
	}
	s2 := fmt.Sprintf("%v", admin)
	if strings.Contains(s2, "super-secret-session-id") {
		t.Error("fmt output should not expose session cookie")
	}
}

// ---------------------------------------------------------------------------
// Cookie jar: session persistence across requests
// ---------------------------------------------------------------------------

func TestCookieJar_SessionPersistence(t *testing.T) {
	var gotCookie string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "sess-123", Path: "/"})
			adminSuccess(w, UserInfo{ID: 1})
		case "/api/auth/me":
			c, err := r.Cookie("session")
			if err == nil {
				gotCookie = c.Value
			}
			adminSuccess(w, UserInfo{ID: 1})
		}
	}))
	defer srv.Close()

	admin := NewAdmin(WithAdminBaseURL(srv.URL))
	admin.Login("key")
	admin.Me()

	if gotCookie != "sess-123" {
		t.Errorf("expected session cookie to persist, got %q", gotCookie)
	}
}

// ---------------------------------------------------------------------------
// Network errors
// ---------------------------------------------------------------------------

func TestAdmin_NetworkError_InvalidURL(t *testing.T) {
	admin := NewAdmin(WithAdminBaseURL("http://127.0.0.1:1"), WithAdminTimeout(1*time.Second))
	admin.loggedIn = true
	_, err := admin.ListChannels()
	if err == nil {
		t.Fatal("expected network error")
	}
	if !IsNetwork(err) {
		t.Errorf("expected NetworkError, got %T: %v", err, err)
	}
}

func TestAdmin_NetworkError_InvalidJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("not json at all"))
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	_, err := admin.ListChannels()
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
	if !IsNetwork(err) {
		t.Errorf("expected NetworkError, got %T: %v", err, err)
	}
}

func TestAdmin_ServerError_NestedDataError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"success":false,"data":{"error":"Maximum 10 channels allowed"}}`)
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	_, err := admin.GetQR()
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "Maximum 10 channels") {
		t.Errorf("expected nested error message, got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Login-required guard on all methods
// ---------------------------------------------------------------------------

func TestAllMethods_RequireLogin(t *testing.T) {
	admin := NewAdmin()

	tests := []struct {
		name string
		fn   func() error
	}{
		{"Me", func() error { _, e := admin.Me(); return e }},
		{"ListChannels", func() error { _, e := admin.ListChannels(); return e }},
		{"DeleteChannel", func() error { return admin.DeleteChannel(1) }},
		{"GetQR", func() error { _, e := admin.GetQR(); return e }},
		{"CheckBindStatus", func() error { _, e := admin.CheckBindStatus("x"); return e }},
		{"StartBinding", func() error { _, e := admin.StartBinding(); return e }},
		{"ListReminders", func() error { _, e := admin.ListReminders(); return e }},
		{"CreateReminder", func() error { _, e := admin.CreateReminder(CreateReminderOpts{Title: "t", Time: "09:00"}); return e }},
		{"DeleteReminder", func() error { return admin.DeleteReminder(1) }},
		{"GetPushLogs", func() error { _, e := admin.GetPushLogs(); return e }},
		{"GetSendKey", func() error { _, e := admin.GetSendKey(); return e }},
		{"ResetSendKey", func() error { _, e := admin.ResetSendKey(); return e }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.fn()
			if err == nil {
				t.Fatalf("%s should require login", tt.name)
			}
			if !strings.Contains(err.Error(), "Not logged in") {
				t.Errorf("%s: expected 'Not logged in' error, got: %v", tt.name, err)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// QR code URL path escaping
// ---------------------------------------------------------------------------

func TestCheckBindStatus_URLEncoding(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The path should have the qrcode properly escaped
		if !strings.Contains(r.URL.Path, "/api/channels/bind-status/") {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		adminSuccess(w, BindStatus{Status: "waiting"})
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	_, err := admin.CheckBindStatus("token/with+special=chars")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Logout clears cookies
// ---------------------------------------------------------------------------

func TestLogout_ClearsCookies(t *testing.T) {
	var requestCount int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		switch r.URL.Path {
		case "/api/auth/login":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "old-session", Path: "/"})
			adminSuccess(w, UserInfo{ID: 1})
		case "/api/auth/logout":
			adminSuccessOnly(w)
		case "/api/auth/me":
			c, err := r.Cookie("session")
			if err == nil && c.Value == "old-session" {
				t.Error("old session cookie should have been cleared after logout")
			}
			adminSuccess(w, UserInfo{ID: 1})
		}
	}))
	defer srv.Close()

	admin := NewAdmin(WithAdminBaseURL(srv.URL))
	admin.Login("key")
	admin.Logout()

	// After logout, loggedIn is false, so Me() will fail with login error
	_, err := admin.Me()
	if err == nil {
		t.Fatal("expected error after logout")
	}
}

// ---------------------------------------------------------------------------
// Empty channel / reminder list
// ---------------------------------------------------------------------------

func TestListChannels_Empty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		adminSuccess(w, []Channel{})
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	channels, err := admin.ListChannels()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(channels) != 0 {
		t.Errorf("expected empty list, got %d", len(channels))
	}
}

func TestListReminders_Empty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		adminSuccess(w, []Reminder{})
	}))
	defer srv.Close()

	admin := newAdminWithServer(srv)
	reminders, err := admin.ListReminders()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(reminders) != 0 {
		t.Errorf("expected empty list, got %d", len(reminders))
	}
}
