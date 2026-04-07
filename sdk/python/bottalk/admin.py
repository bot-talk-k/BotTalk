"""BotTalk Admin client -- Tier 2 management SDK.

Provides session-based access to channel management, reminders,
push logs, key management, and QR binding workflows.
"""

import http.cookiejar
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from .exceptions import NetworkError, BotTalkError

# ---------------------------------------------------------------------------
# Binding session helper
# ---------------------------------------------------------------------------


class BindingSession:
    """Represents an in-progress QR binding flow.

    Attributes:
        qr_url: URL of the QR code image to display / scan.
        qrcode: The qrcode token used to poll status.
    """

    def __init__(self, admin: "BotTalkAdmin", qrcode: str, qr_url: str):
        self.qr_url = qr_url
        self.qrcode = qrcode
        self._admin = admin

    def wait(self, timeout: int = 120, interval: float = 2.0) -> dict:
        """Block until the QR code is scanned and binding completes.

        Args:
            timeout: Maximum seconds to wait (default 120, max 300).
            interval: Seconds between polls (default 2).

        Returns:
            The binding result dict from the server.

        Raises:
            TimeoutError: If binding is not completed within *timeout*.
            BotTalkError: On server errors.
        """
        if timeout > 300:
            timeout = 300
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = self._admin.check_bind_status(self.qrcode)
            status = result.get("status", "")
            # When bot_token appears or status indicates completion
            if result.get("id") or result.get("send_key") or status in ("active", "pending"):
                return result
            if status == "expired":
                raise BotTalkError("QR code expired")
            time.sleep(interval)
        raise TimeoutError(f"Binding not completed within {timeout}s")

    def __repr__(self) -> str:
        return f"BindingSession(qrcode={self.qrcode!r})"


# ---------------------------------------------------------------------------
# Admin client
# ---------------------------------------------------------------------------


class BotTalkAdmin:
    """Session-based management client for bot-talk.com.

    Usage::

        from bottalk import BotTalkAdmin

        admin = BotTalkAdmin("https://bot-talk.com")
        admin.login("YOUR_SEND_KEY")
        channels = admin.list_channels()
    """

    def __init__(self, base_url: str = "https://bot-talk.com", timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

        # Cookie jar for session management
        self._cookie_jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._cookie_jar)
        )
        self._logged_in = False

    # ------------------------------------------------------------------
    # Auth
    # ------------------------------------------------------------------

    def login(self, send_key: str) -> dict:
        """Log in with a SendKey. Stores session cookie internally.

        Args:
            send_key: The user's SendKey.

        Returns:
            User info dict (id, email, send_key, channel_count).

        Raises:
            BotTalkError: If login fails.
        """
        data = self._post("/api/auth/login", {"send_key": send_key})
        self._logged_in = True
        return data

    def logout(self) -> None:
        """Log out and destroy the session."""
        self._post("/api/auth/logout", {})
        self._logged_in = False
        self._cookie_jar.clear()

    def me(self) -> dict:
        """Get current user info."""
        self._require_login()
        return self._get("/api/auth/me")

    # ------------------------------------------------------------------
    # Channel management
    # ------------------------------------------------------------------

    def list_channels(self) -> List[dict]:
        """List all channels for the current user."""
        self._require_login()
        return self._get("/api/channels/")

    def delete_channel(self, channel_id: int) -> dict:
        """Delete (soft-delete) a channel.

        Args:
            channel_id: ID of the channel to delete.
        """
        self._require_login()
        return self._delete(f"/api/channels/{channel_id}")

    def start_binding(self) -> BindingSession:
        """Start a QR binding flow (high-level).

        Returns a BindingSession with a ``qr_url`` to display and a
        ``wait()`` method that polls until binding completes.
        """
        qr = self.get_qr()
        qrcode = qr.get("qrcode", "")
        qr_url = qr.get("qr_url", qr.get("url", ""))
        return BindingSession(self, qrcode, qr_url)

    def get_qr(self) -> dict:
        """Get a QR code for channel binding (low-level).

        Returns:
            Dict with ``qrcode`` token and ``qr_url`` / ``url``.
        """
        self._require_login()
        return self._post("/api/channels/qrcode", {})

    def check_bind_status(self, qrcode: str) -> dict:
        """Check the binding status of a QR code (low-level).

        Args:
            qrcode: The qrcode token from ``get_qr()``.

        Returns:
            Status dict from the server.
        """
        self._require_login()
        return self._get(f"/api/channels/bind-status/{urllib.parse.quote(qrcode, safe='')}")

    # ------------------------------------------------------------------
    # Reminder management
    # ------------------------------------------------------------------

    def list_reminders(self) -> List[dict]:
        """List all reminders for the current user."""
        self._require_login()
        return self._get("/api/reminders/")

    def create_reminder(
        self,
        title: str,
        time_str: str,
        type: str = "once",
        message: str = "",
        max_count: int = 0,
        **kwargs: Any,
    ) -> dict:
        """Create a new reminder.

        Args:
            title: Reminder title.
            time_str: Time expression (e.g. "08:00" or cron).
            type: "once" or "repeat".
            message: Optional message body.
            max_count: Max trigger count (0 = unlimited).

        Returns:
            Dict with ``success`` and ``id``.
        """
        self._require_login()
        body: Dict[str, Any] = {
            "title": title,
            "time": time_str,
            "type": type,
            "message": message,
            "max_count": max_count,
        }
        body.update(kwargs)
        return self._post("/api/reminders/", body)

    def delete_reminder(self, reminder_id: int) -> dict:
        """Delete a reminder.

        Args:
            reminder_id: ID of the reminder to delete.
        """
        self._require_login()
        return self._delete(f"/api/reminders/{reminder_id}")

    # ------------------------------------------------------------------
    # Push logs
    # ------------------------------------------------------------------

    def get_push_logs(self, limit: int = 50) -> List[dict]:
        """Get recent push logs.

        Args:
            limit: Number of logs to return (server default 50).

        Returns:
            List of push log dicts.
        """
        self._require_login()
        return self._get("/api/push-logs/")

    # ------------------------------------------------------------------
    # Key management
    # ------------------------------------------------------------------

    def get_send_key(self) -> str:
        """Get the current SendKey.

        Returns:
            The SendKey string.
        """
        self._require_login()
        data = self._get("/api/key/")
        return data.get("send_key", "") if isinstance(data, dict) else ""

    def reset_send_key(self) -> str:
        """Reset the SendKey and return the new one.

        Returns:
            The new SendKey string.
        """
        self._require_login()
        data = self._post("/api/key/reset", {})
        return data.get("send_key", "") if isinstance(data, dict) else ""

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _require_login(self) -> None:
        if not self._logged_in:
            raise BotTalkError("Not logged in. Call login() first.")

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> Any:
        """Execute an HTTP request and return the ``data`` field."""
        url = f"{self.base_url}{path}"

        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=payload,
                method=method,
                headers={"Content-Type": "application/json"},
            )
        else:
            req = urllib.request.Request(url, method=method)

        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                result = json.loads(raw)
        except urllib.error.HTTPError as exc:
            try:
                raw = exc.read().decode("utf-8")
                result = json.loads(raw)
            except Exception:
                raise NetworkError(f"HTTP {exc.code}: {exc.reason}") from exc
        except urllib.error.URLError as exc:
            raise NetworkError(str(exc.reason)) from exc
        except (OSError, TimeoutError) as exc:
            raise NetworkError(str(exc)) from exc

        if not result.get("success", False):
            error_msg = result.get("error") or result.get("data", {}).get("error", "Unknown error")
            raise BotTalkError(str(error_msg))

        return result.get("data")

    def _get(self, path: str) -> Any:
        return self._request("GET", path)

    def _post(self, path: str, body: dict) -> Any:
        return self._request("POST", path, body)

    def _delete(self, path: str) -> Any:
        return self._request("DELETE", path)

    # ------------------------------------------------------------------
    # Repr (never exposes cookies or keys)
    # ------------------------------------------------------------------

    def __repr__(self) -> str:
        status = "logged_in" if self._logged_in else "not_logged_in"
        return f"BotTalkAdmin(base_url={self.base_url!r}, status={status})"
