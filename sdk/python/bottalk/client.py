"""BotTalk push client -- Tier 1 SDK.

Zero external dependencies (uses only urllib from the standard library).
"""

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

from .exceptions import (
    EmptyMessageError,
    InvalidKeyError,
    NetworkError,
    NoChannelError,
    BotTalkError,
    PushFailedError,
    RateLimitError,
)
from .models import PushResult

# Map server error codes to SDK exceptions
_CODE_TO_EXCEPTION = {
    40001: InvalidKeyError,
    40002: NoChannelError,
    40003: EmptyMessageError,
    42901: RateLimitError,
    50001: PushFailedError,
}

# Allowed characters in a SendKey (alphanumeric, dash, underscore)
_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_\-]{1,256}$")


class BotTalk:
    """Lightweight client for the bot-talk.com push API.

    Usage::

        from bottalk import BotTalk
        os = BotTalk("YOUR_KEY")
        result = os.send("Hello!")
    """

    def __init__(
        self,
        key: str,
        base_url: str = "https://bot-talk.com",
        timeout: int = 30,
    ):
        if not key or not isinstance(key, str):
            raise ValueError("key must be a non-empty string")
        if not _KEY_PATTERN.match(key):
            raise ValueError(
                "key contains invalid characters (only alphanumeric, dash, underscore allowed)"
            )

        self._key = key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def send(
        self,
        title: str = "",
        desp: str = "",
        channel: str = "",
        method: str = "POST",
    ) -> PushResult:
        """Push a message.

        Args:
            title: Message title.
            desp: Message body / description (Markdown supported).
            channel: Target channel(s) -- "default", "all", or comma-separated IDs.
            method: HTTP method, "GET" or "POST" (default POST).

        Returns:
            A :class:`PushResult` object.

        Raises:
            EmptyMessageError: If both *title* and *desp* are empty.
            InvalidKeyError: If the server rejects the key.
            NoChannelError: If no active channel is configured.
            RateLimitError: If the hourly limit is exceeded.
            PushFailedError: If all channels fail.
            NetworkError: On connection / timeout errors.
        """
        if not title and not desp:
            raise EmptyMessageError()

        method = method.upper()
        if method not in ("GET", "POST"):
            raise ValueError("method must be 'GET' or 'POST'")

        url = f"{self.base_url}/{urllib.parse.quote(self._key, safe='')}.send"

        params = {}
        if title:
            params["title"] = title
        if desp:
            params["desp"] = desp
        if channel:
            params["channel"] = channel

        return self._request(url, params, method)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _request(self, url: str, params: dict, method: str) -> PushResult:
        """Execute an HTTP request and return a PushResult."""
        try:
            if method == "GET":
                qs = urllib.parse.urlencode(params)
                full_url = f"{url}?{qs}" if qs else url
                req = urllib.request.Request(full_url, method="GET")
            else:
                body = urllib.parse.urlencode(params).encode("utf-8")
                req = urllib.request.Request(
                    url,
                    data=body,
                    method="POST",
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )

            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                data = json.loads(raw)

        except urllib.error.HTTPError as exc:
            # Try to parse JSON error body
            try:
                raw = exc.read().decode("utf-8")
                data = json.loads(raw)
            except Exception:
                raise NetworkError(f"HTTP {exc.code}: {exc.reason}") from exc
        except urllib.error.URLError as exc:
            raise NetworkError(str(exc.reason)) from exc
        except (OSError, TimeoutError) as exc:
            raise NetworkError(str(exc)) from exc

        code = data.get("code", -1)
        message = data.get("message", "")
        result_data = data.get("data")

        if code != 0:
            exc_cls = _CODE_TO_EXCEPTION.get(code, BotTalkError)
            raise exc_cls(message)

        return PushResult(code=code, message=message, data=result_data)

    # ------------------------------------------------------------------
    # Repr (never exposes the key)
    # ------------------------------------------------------------------

    def __repr__(self) -> str:
        masked = self._key[:3] + "***" if len(self._key) > 3 else "***"
        return f"BotTalk(key={masked!r}, base_url={self.base_url!r})"
