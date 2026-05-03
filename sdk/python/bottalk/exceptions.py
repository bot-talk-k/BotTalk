"""Exception classes for the BotTalk SDK."""

from typing import Optional


# data.reason values for code 50001. The most actionable one is
# "context_expired" — ask the receiver to reply to ClawBot in WeChat
# and the message auto-redelivers within minutes.
FailureReason = str  # Literal["context_expired", "channel_dead", "account_restricted", "no_channel", "transient"]


class BotTalkError(Exception):
    """Base exception for all BotTalk SDK errors."""

    def __init__(
        self,
        message: str,
        code: int = -1,
        reason: Optional[FailureReason] = None,
        hint: Optional[str] = None,
    ):
        self.code = code
        self.message = message
        # Sub-classification + recovery hint (only populated for 50001).
        self.reason = reason
        self.hint = hint
        super().__init__(message)

    def __repr__(self) -> str:
        return f"BotTalkError(code={self.code}, message={self.message!r})"


class InvalidKeyError(BotTalkError):
    """Raised when the SendKey is invalid or missing."""

    def __init__(self, message: str = "SendKey is invalid"):
        super().__init__(message, code=40001)


class NoChannelError(BotTalkError):
    """Raised when no active push channel is available."""

    def __init__(self, message: str = "No active push channel available"):
        super().__init__(message, code=40002)


class EmptyMessageError(BotTalkError):
    """Raised when both title and content are empty."""

    def __init__(self, message: str = "Title and content cannot both be empty"):
        super().__init__(message, code=40003)


class RateLimitError(BotTalkError):
    """Raised when the rate limit is exceeded."""

    def __init__(self, message: str = "Rate limit exceeded (max 100 per hour)"):
        super().__init__(message, code=42901)


class PushFailedError(BotTalkError):
    """Raised when all push channels fail.

    For 50001 responses the server returns ``data.reason`` and ``data.hint``
    that pinpoint exactly what the receiver should do. The most common case
    is ``reason='context_expired'`` — just ask the receiver to reply to
    ClawBot in WeChat and the message auto-redelivers within minutes.
    """

    def __init__(
        self,
        message: str = "All push channels failed",
        reason: Optional[FailureReason] = None,
        hint: Optional[str] = None,
    ):
        super().__init__(message, code=50001, reason=reason, hint=hint)

    @property
    def is_recoverable_by_reply(self) -> bool:
        """True when the receiver replying to ClawBot will fix this push.

        Server data shows this path covers ~94% of all successful 50001
        recoveries. When True, no rebinding is needed.
        """
        return self.reason == "context_expired"


class NetworkError(BotTalkError):
    """Raised when a network-level error occurs (timeout, DNS, etc.)."""

    def __init__(self, message: str = "Network error"):
        super().__init__(message, code=-1)
