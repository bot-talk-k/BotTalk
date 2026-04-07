package bottalk

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// --- Helper: mock server ---

func mockServer(handler http.HandlerFunc) *httptest.Server {
	return httptest.NewServer(handler)
}

func successHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{
		"code": 0,
		"message": "success",
		"data": {
			"results": [
				{"channel_id": 1, "status": "success", "token_invalid": false}
			]
		}
	}`)
}

func errorHandler(code int, message string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"code": %d, "message": %q}`, code, message)
	}
}

// --- Constructor tests ---

func TestNew_ValidKey(t *testing.T) {
	c := New("abc123")
	if c == nil {
		t.Fatal("expected non-nil client")
	}
	if c.baseURL != DefaultBaseURL {
		t.Errorf("expected default baseURL, got %q", c.baseURL)
	}
}

func TestNew_WithOptions(t *testing.T) {
	c := New("abc123",
		WithBaseURL("https://example.com/"),
		WithTimeout(5*time.Second),
	)
	if c.baseURL != "https://example.com" {
		t.Errorf("expected trimmed baseURL, got %q", c.baseURL)
	}
	if c.timeout != 5*time.Second {
		t.Errorf("expected 5s timeout, got %v", c.timeout)
	}
}

func TestNew_EmptyKey_Panics(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected panic for empty key")
		}
	}()
	New("")
}

func TestNew_InvalidKey_Panics(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected panic for invalid key")
		}
	}()
	New("key with spaces!")
}

func TestNew_LongKey_Panics(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected panic for key > 256 chars")
		}
	}()
	New(strings.Repeat("a", 257))
}

func TestNew_MaxLengthKey(t *testing.T) {
	// 256 chars should be fine
	c := New(strings.Repeat("a", 256))
	if c == nil {
		t.Fatal("expected non-nil client for 256-char key")
	}
}

// --- Send: success ---

func TestSend_POST_Success(t *testing.T) {
	srv := mockServer(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/x-www-form-urlencoded" {
			t.Errorf("expected form content-type, got %q", ct)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.PostFormValue("title") != "Hello" {
			t.Errorf("expected title=Hello, got %q", r.PostFormValue("title"))
		}
		if r.PostFormValue("desp") != "World" {
			t.Errorf("expected desp=World, got %q", r.PostFormValue("desp"))
		}
		successHandler(w, r)
	})
	defer srv.Close()

	c := New("test-key", WithBaseURL(srv.URL))
	result, err := c.Send("Hello", WithDesp("World"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsSuccess() {
		t.Errorf("expected success, got code %d", result.Code)
	}
	if len(result.Results) != 1 {
		t.Fatalf("expected 1 channel result, got %d", len(result.Results))
	}
	if !result.Results[0].IsSuccess() {
		t.Error("expected channel result to be success")
	}
}

func TestSend_GET_Success(t *testing.T) {
	srv := mockServer(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.URL.Query().Get("title") != "Hello" {
			t.Errorf("expected title=Hello in query, got %q", r.URL.Query().Get("title"))
		}
		successHandler(w, r)
	})
	defer srv.Close()

	c := New("test-key", WithBaseURL(srv.URL))
	result, err := c.Send("Hello", WithMethod("GET"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsSuccess() {
		t.Errorf("expected success, got code %d", result.Code)
	}
}

func TestSend_WithChannel(t *testing.T) {
	srv := mockServer(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.PostFormValue("channel") != "all" {
			t.Errorf("expected channel=all, got %q", r.PostFormValue("channel"))
		}
		successHandler(w, r)
	})
	defer srv.Close()

	c := New("test-key", WithBaseURL(srv.URL))
	_, err := c.Send("Hello", WithChannel("all"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSend_DespOnly(t *testing.T) {
	srv := mockServer(func(w http.ResponseWriter, r *http.Request) {
		successHandler(w, r)
	})
	defer srv.Close()

	c := New("test-key", WithBaseURL(srv.URL))
	result, err := c.Send("", WithDesp("body only"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsSuccess() {
		t.Error("expected success")
	}
}

// --- Send: validation errors ---

func TestSend_EmptyTitleAndDesp(t *testing.T) {
	c := New("test-key")
	_, err := c.Send("")
	if err == nil {
		t.Fatal("expected error for empty title and desp")
	}
	if !IsEmptyMessage(err) {
		t.Errorf("expected EmptyMessageError, got %T: %v", err, err)
	}
}

func TestSend_InvalidMethod(t *testing.T) {
	c := New("test-key")
	_, err := c.Send("Hello", WithMethod("PUT"))
	if err == nil {
		t.Fatal("expected error for invalid method")
	}
	if !strings.Contains(err.Error(), "PUT") {
		t.Errorf("expected error to mention PUT, got: %v", err)
	}
}

// --- Server error responses ---

func TestSend_InvalidKeyError(t *testing.T) {
	srv := mockServer(errorHandler(40001, "SendKey is invalid"))
	defer srv.Close()

	c := New("test-key", WithBaseURL(srv.URL))
	_, err := c.Send("Hello")
	if err == nil {
		t.Fatal("expected error")
	}
	if !IsInvalidKey(err) {
		t.Errorf("expected InvalidKeyError, got %T: %v", err, err)
	}
}

func TestSend_NoChannelError(t *testing.T) {
	srv := mockServer(errorHandler(40002, "No channel"))
	defer srv.Close()

	c := New("test-key", WithBaseURL(srv.URL))
	_, err := c.Send("Hello")
	if !IsNoChannel(err) {
		t.Errorf("expected NoChannelError, got %T: %v", err, err)
	}
}

func TestSend_RateLimitError(t *testing.T) {
	srv := mockServer(errorHandler(42901, "Rate limit exceeded"))
	defer srv.Close()

	c := New("test-key", WithBaseURL(srv.URL))
	_, err := c.Send("Hello")
	if !IsRateLimit(err) {
		t.Errorf("expected RateLimitError, got %T: %v", err, err)
	}
}

func TestSend_PushFailedError(t *testing.T) {
	srv := mockServer(errorHandler(50001, "All channels failed"))
	defer srv.Close()

	c := New("test-key", WithBaseURL(srv.URL))
	_, err := c.Send("Hello")
	if !IsPushFailed(err) {
		t.Errorf("expected PushFailedError, got %T: %v", err, err)
	}
}

func TestSend_UnknownErrorCode(t *testing.T) {
	srv := mockServer(errorHandler(99999, "Unknown error"))
	defer srv.Close()

	c := New("test-key", WithBaseURL(srv.URL))
	_, err := c.Send("Hello")
	if err == nil {
		t.Fatal("expected error")
	}
	var osErr *BotTalkError
	if !isBaseBotTalkError(err, &osErr) {
		t.Errorf("expected BotTalkError, got %T", err)
	}
}

func isBaseBotTalkError(err error, target **BotTalkError) bool {
	// errors.As would also match subtypes; we check the concrete type
	switch e := err.(type) {
	case *BotTalkError:
		*target = e
		return true
	default:
		return false
	}
}

// --- Network errors ---

func TestSend_NetworkError_InvalidURL(t *testing.T) {
	c := New("test-key", WithBaseURL("http://127.0.0.1:1")) // port 1 should fail
	c.client.Timeout = 2 * time.Second
	_, err := c.Send("Hello")
	if err == nil {
		t.Fatal("expected network error")
	}
	if !IsNetwork(err) {
		t.Errorf("expected NetworkError, got %T: %v", err, err)
	}
}

func TestSend_NetworkError_InvalidJSON(t *testing.T) {
	srv := mockServer(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("not json"))
	})
	defer srv.Close()

	c := New("test-key", WithBaseURL(srv.URL))
	_, err := c.Send("Hello")
	if !IsNetwork(err) {
		t.Errorf("expected NetworkError for invalid JSON, got %T: %v", err, err)
	}
}

// --- Security tests ---

func TestString_KeyMasked(t *testing.T) {
	c := New("my-secret-key-12345")
	s := c.String()
	if strings.Contains(s, "my-secret-key-12345") {
		t.Error("String() should not expose the full key")
	}
	if !strings.Contains(s, "my-***") {
		t.Errorf("String() should show masked key, got: %s", s)
	}
}

func TestString_ShortKey(t *testing.T) {
	c := New("ab")
	s := c.String()
	if strings.Contains(s, `"ab"`) {
		t.Error("String() should not expose a short key either")
	}
	if !strings.Contains(s, "***") {
		t.Error("String() should contain ***")
	}
}

func TestSend_URLEncoding_SpecialChars(t *testing.T) {
	srv := mockServer(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		// Verify the values come through properly decoded
		if r.PostFormValue("title") != "Hello <world> & \"friends\"" {
			t.Errorf("title not properly encoded/decoded: %q", r.PostFormValue("title"))
		}
		if r.PostFormValue("desp") != "测试中文 & emoji 🎉" {
			t.Errorf("desp not properly encoded/decoded: %q", r.PostFormValue("desp"))
		}
		successHandler(w, r)
	})
	defer srv.Close()

	c := New("test-key", WithBaseURL(srv.URL))
	_, err := c.Send("Hello <world> & \"friends\"", WithDesp("测试中文 & emoji 🎉"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSend_KeyInURL_PathEscaped(t *testing.T) {
	// Key with special URL characters (within allowed set: dashes, underscores)
	srv := mockServer(func(w http.ResponseWriter, r *http.Request) {
		// The path should contain the key properly
		if !strings.Contains(r.URL.Path, "key-with_dashes") {
			t.Errorf("URL path should contain key, got %q", r.URL.Path)
		}
		successHandler(w, r)
	})
	defer srv.Close()

	c := New("key-with_dashes", WithBaseURL(srv.URL))
	_, err := c.Send("test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- Key validation edge cases ---

func TestNew_KeyValidation(t *testing.T) {
	validKeys := []string{"a", "ABC", "123", "a-b_c", strings.Repeat("x", 256)}
	for _, k := range validKeys {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("valid key %q caused panic: %v", k, r)
				}
			}()
			New(k)
		}()
	}

	invalidKeys := []string{
		"key with space",
		"key@special",
		"key/slash",
		"key.dot",
		strings.Repeat("x", 257),
	}
	for _, k := range invalidKeys {
		func() {
			defer func() {
				if r := recover(); r == nil {
					t.Errorf("invalid key %q should have caused panic", k)
				}
			}()
			New(k)
		}()
	}
}

// --- Error type assertions ---

func TestErrorTypes_ImplementError(t *testing.T) {
	errs := []error{
		&BotTalkError{Code: -1, Message: "test"},
		&InvalidKeyError{BotTalkError{Code: 40001, Message: "test"}},
		&NoChannelError{BotTalkError{Code: 40002, Message: "test"}},
		&EmptyMessageError{BotTalkError{Code: 40003, Message: "test"}},
		&RateLimitError{BotTalkError{Code: 42901, Message: "test"}},
		&PushFailedError{BotTalkError{Code: 50001, Message: "test"}},
		&NetworkError{BotTalkError{Code: -1, Message: "test"}},
	}
	for _, e := range errs {
		if e.Error() == "" {
			t.Errorf("error %T should have non-empty Error() string", e)
		}
	}
}

func TestNewErrorFromCode(t *testing.T) {
	tests := []struct {
		code int
		fn   func(error) bool
	}{
		{40001, IsInvalidKey},
		{40002, IsNoChannel},
		{40003, IsEmptyMessage},
		{42901, IsRateLimit},
		{50001, IsPushFailed},
	}
	for _, tt := range tests {
		err := newErrorFromCode(tt.code, "test")
		if !tt.fn(err) {
			t.Errorf("newErrorFromCode(%d) returned %T, expected matching Is function", tt.code, err)
		}
	}
}

// --- HTTP error body parsing ---

func TestSend_HTTPErrorWithJSONBody(t *testing.T) {
	srv := mockServer(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		fmt.Fprint(w, `{"code": 42901, "message": "Rate limit exceeded"}`)
	})
	defer srv.Close()

	c := New("test-key", WithBaseURL(srv.URL))
	_, err := c.Send("Hello")
	if !IsRateLimit(err) {
		t.Errorf("expected RateLimitError, got %T: %v", err, err)
	}
}
