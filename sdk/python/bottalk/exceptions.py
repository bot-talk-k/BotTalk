"""Exception classes for the BotTalk SDK."""


class BotTalkError(Exception):
    """Base exception for all BotTalk SDK errors."""

    def __init__(self, message: str, code: int = -1):
        self.code = code
        self.message = message
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
    """Raised when all push channels fail."""

    def __init__(self, message: str = "All push channels failed"):
        super().__init__(message, code=50001)


class NetworkError(BotTalkError):
    """Raised when a network-level error occurs (timeout, DNS, etc.)."""

    def __init__(self, message: str = "Network error"):
        super().__init__(message, code=-1)
