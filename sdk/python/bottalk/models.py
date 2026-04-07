"""Data models for the BotTalk SDK."""

from typing import Any, Dict, List, Optional


class ChannelResult:
    """Result for a single channel push attempt."""

    def __init__(self, channel_id: str, status: str, token_invalid: bool = False, reason: Optional[str] = None):
        self.channel_id = channel_id
        self.status = status
        self.token_invalid = token_invalid
        self.reason = reason

    @property
    def is_success(self) -> bool:
        return self.status == "success"

    def __repr__(self) -> str:
        return f"ChannelResult(channel_id={self.channel_id!r}, status={self.status!r})"


class PushResult:
    """Result of a push operation.

    Attributes:
        code: Response code. 0 means success.
        message: Human-readable status message.
        results: Per-channel results (if available).
    """

    def __init__(self, code: int, message: str, data: Optional[Dict[str, Any]] = None):
        self.code = code
        self.message = message
        self._data = data or {}
        self.results: List[ChannelResult] = []

        if "results" in self._data:
            for r in self._data["results"]:
                self.results.append(ChannelResult(
                    channel_id=r.get("channel_id", ""),
                    status=r.get("status", "unknown"),
                    token_invalid=r.get("token_invalid", False),
                    reason=r.get("reason"),
                ))

    @property
    def is_success(self) -> bool:
        """True if the push succeeded (code == 0)."""
        return self.code == 0

    def __repr__(self) -> str:
        return f"PushResult(code={self.code}, message={self.message!r})"

    def __bool__(self) -> bool:
        return self.is_success
