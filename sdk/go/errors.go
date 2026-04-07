// Package bottalk provides a lightweight client for the bot-talk.com push API.
package bottalk

import (
	"errors"
	"fmt"
)

// BotTalkError is the base error type for all BotTalk SDK errors.
type BotTalkError struct {
	Code    int    // Server error code (0 = success, -1 = network/unknown)
	Message string // Human-readable error message
}

func (e *BotTalkError) Error() string {
	return fmt.Sprintf("BotTalkError(code=%d, message=%q)", e.Code, e.Message)
}

// InvalidKeyError indicates the SendKey is invalid or missing (40001).
type InvalidKeyError struct{ BotTalkError }

// NoChannelError indicates no active push channel is available (40002).
type NoChannelError struct{ BotTalkError }

// EmptyMessageError indicates both title and content are empty (40003).
type EmptyMessageError struct{ BotTalkError }

// RateLimitError indicates the rate limit was exceeded (42901).
type RateLimitError struct{ BotTalkError }

// PushFailedError indicates all push channels failed (50001).
type PushFailedError struct{ BotTalkError }

// NetworkError indicates a network-level error (timeout, DNS, etc.).
type NetworkError struct{ BotTalkError }

// --- Convenience "Is" functions for errors.Is / type-checking ---

// IsInvalidKey returns true if err is an InvalidKeyError.
func IsInvalidKey(err error) bool {
	var target *InvalidKeyError
	return errors.As(err, &target)
}

// IsNoChannel returns true if err is a NoChannelError.
func IsNoChannel(err error) bool {
	var target *NoChannelError
	return errors.As(err, &target)
}

// IsEmptyMessage returns true if err is an EmptyMessageError.
func IsEmptyMessage(err error) bool {
	var target *EmptyMessageError
	return errors.As(err, &target)
}

// IsRateLimit returns true if err is a RateLimitError.
func IsRateLimit(err error) bool {
	var target *RateLimitError
	return errors.As(err, &target)
}

// IsPushFailed returns true if err is a PushFailedError.
func IsPushFailed(err error) bool {
	var target *PushFailedError
	return errors.As(err, &target)
}

// IsNetwork returns true if err is a NetworkError.
func IsNetwork(err error) bool {
	var target *NetworkError
	return errors.As(err, &target)
}

// newErrorFromCode creates the appropriate typed error for a server error code.
func newErrorFromCode(code int, message string) error {
	base := BotTalkError{Code: code, Message: message}
	switch code {
	case 40001:
		return &InvalidKeyError{base}
	case 40002:
		return &NoChannelError{base}
	case 40003:
		return &EmptyMessageError{base}
	case 42901:
		return &RateLimitError{base}
	case 50001:
		return &PushFailedError{base}
	default:
		return &base
	}
}
