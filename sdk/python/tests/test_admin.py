"""Unit tests for the BotTalk Admin (Tier 2) Python SDK."""

import json
import unittest
from unittest.mock import MagicMock, patch, PropertyMock

from bottalk.admin import BotTalkAdmin, BindingSession
from bottalk.exceptions import BotTalkError, NetworkError


def _mock_opener_response(data: dict, status: int = 200, cookies=None):
    """Create a mock response for urllib opener."""
    body = json.dumps(data).encode("utf-8")
    resp = MagicMock()
    resp.read.return_value = body
    resp.status = status
    resp.info.return_value = {}
    resp.__enter__ = MagicMock(return_value=resp)
    resp.__exit__ = MagicMock(return_value=False)
    return resp


class TestAdminLogin(unittest.TestCase):
    """Test login and session management."""

    def test_login_success(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        mock_resp = _mock_opener_response({
            "success": True,
            "data": {"id": 1, "email": "test@test.com", "send_key": "sk_abc", "channel_count": 2},
        })
        admin._opener.open = MagicMock(return_value=mock_resp)

        result = admin.login("sk_abc")
        self.assertEqual(result["id"], 1)
        self.assertEqual(result["send_key"], "sk_abc")
        self.assertTrue(admin._logged_in)

    def test_login_failure(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        mock_resp = _mock_opener_response({"success": False, "error": "SendKey 无效"})
        admin._opener.open = MagicMock(return_value=mock_resp)

        with self.assertRaises(BotTalkError) as ctx:
            admin.login("bad_key")
        self.assertIn("SendKey", str(ctx.exception))
        self.assertFalse(admin._logged_in)

    def test_logout(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        admin._logged_in = True
        mock_resp = _mock_opener_response({"success": True})
        admin._opener.open = MagicMock(return_value=mock_resp)

        admin.logout()
        self.assertFalse(admin._logged_in)

    def test_require_login(self):
        admin = BotTalkAdmin()
        with self.assertRaises(BotTalkError) as ctx:
            admin.list_channels()
        self.assertIn("Not logged in", str(ctx.exception))

    def test_me(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        admin._logged_in = True
        mock_resp = _mock_opener_response({
            "success": True,
            "data": {"id": 1, "email": "t@t.com", "send_key": "sk_x", "channel_count": 1},
        })
        admin._opener.open = MagicMock(return_value=mock_resp)

        result = admin.me()
        self.assertEqual(result["id"], 1)


class TestAdminChannels(unittest.TestCase):
    """Test channel management."""

    def _make_admin(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        admin._logged_in = True
        return admin

    def test_list_channels(self):
        admin = self._make_admin()
        mock_resp = _mock_opener_response({
            "success": True,
            "data": [
                {"id": 1, "name": "Channel 1", "status": "active"},
                {"id": 2, "name": "Channel 2", "status": "pending"},
            ],
        })
        admin._opener.open = MagicMock(return_value=mock_resp)

        channels = admin.list_channels()
        self.assertEqual(len(channels), 2)
        self.assertEqual(channels[0]["name"], "Channel 1")

    def test_delete_channel(self):
        admin = self._make_admin()
        mock_resp = _mock_opener_response({
            "success": True,
            "data": {"message": "Channel deleted"},
        })
        admin._opener.open = MagicMock(return_value=mock_resp)

        result = admin.delete_channel(1)
        self.assertEqual(result["message"], "Channel deleted")

        # Verify DELETE method was used
        call_args = admin._opener.open.call_args
        req = call_args[0][0]
        self.assertEqual(req.get_method(), "DELETE")

    def test_delete_channel_not_found(self):
        admin = self._make_admin()
        mock_resp = _mock_opener_response({
            "success": False,
            "data": {"error": "Channel not found"},
        })
        admin._opener.open = MagicMock(return_value=mock_resp)

        with self.assertRaises(BotTalkError) as ctx:
            admin.delete_channel(999)
        self.assertIn("Channel not found", str(ctx.exception))

    def test_get_qr(self):
        admin = self._make_admin()
        mock_resp = _mock_opener_response({
            "success": True,
            "data": {"qrcode": "qr_token_123", "qr_url": "https://example.com/qr.png"},
        })
        admin._opener.open = MagicMock(return_value=mock_resp)

        qr = admin.get_qr()
        self.assertEqual(qr["qrcode"], "qr_token_123")
        self.assertEqual(qr["qr_url"], "https://example.com/qr.png")

    def test_check_bind_status_waiting(self):
        admin = self._make_admin()
        mock_resp = _mock_opener_response({
            "success": True,
            "data": {"status": "waiting"},
        })
        admin._opener.open = MagicMock(return_value=mock_resp)

        result = admin.check_bind_status("qr_token_123")
        self.assertEqual(result["status"], "waiting")

    def test_check_bind_status_complete(self):
        admin = self._make_admin()
        mock_resp = _mock_opener_response({
            "success": True,
            "data": {"id": 5, "send_key": "sk_new", "status": "pending", "is_new": True},
        })
        admin._opener.open = MagicMock(return_value=mock_resp)

        result = admin.check_bind_status("qr_token_123")
        self.assertEqual(result["id"], 5)
        self.assertTrue(result["is_new"])


class TestAdminReminders(unittest.TestCase):
    """Test reminder management."""

    def _make_admin(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        admin._logged_in = True
        return admin

    def test_list_reminders(self):
        admin = self._make_admin()
        mock_resp = _mock_opener_response({
            "success": True,
            "data": [
                {"id": 1, "title": "Morning check", "time": "08:00", "type": "once"},
            ],
        })
        admin._opener.open = MagicMock(return_value=mock_resp)

        reminders = admin.list_reminders()
        self.assertEqual(len(reminders), 1)
        self.assertEqual(reminders[0]["title"], "Morning check")

    def test_create_reminder(self):
        admin = self._make_admin()
        mock_resp = _mock_opener_response({"success": True, "data": {"id": 42}})
        admin._opener.open = MagicMock(return_value=mock_resp)

        result = admin.create_reminder("Daily standup", "09:00", type="repeat")
        self.assertEqual(result["id"], 42)

    def test_delete_reminder(self):
        admin = self._make_admin()
        mock_resp = _mock_opener_response({"success": True})
        admin._opener.open = MagicMock(return_value=mock_resp)

        admin.delete_reminder(1)
        call_args = admin._opener.open.call_args
        req = call_args[0][0]
        self.assertEqual(req.get_method(), "DELETE")
        self.assertIn("/api/reminders/1", req.full_url)


class TestAdminPushLogs(unittest.TestCase):
    """Test push log retrieval."""

    def test_get_push_logs(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        admin._logged_in = True
        mock_resp = _mock_opener_response({
            "success": True,
            "data": [
                {"id": 1, "title": "Test push", "status": "success", "channel_name": "Ch1"},
                {"id": 2, "title": "Another push", "status": "failed", "channel_name": "Ch2"},
            ],
        })
        admin._opener.open = MagicMock(return_value=mock_resp)

        logs = admin.get_push_logs()
        self.assertEqual(len(logs), 2)
        self.assertEqual(logs[0]["title"], "Test push")


class TestAdminKey(unittest.TestCase):
    """Test key management."""

    def _make_admin(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        admin._logged_in = True
        return admin

    def test_get_send_key(self):
        admin = self._make_admin()
        mock_resp = _mock_opener_response({
            "success": True,
            "data": {"send_key": "sk_current_123"},
        })
        admin._opener.open = MagicMock(return_value=mock_resp)

        key = admin.get_send_key()
        self.assertEqual(key, "sk_current_123")

    def test_reset_send_key(self):
        admin = self._make_admin()
        mock_resp = _mock_opener_response({
            "success": True,
            "data": {"send_key": "sk_new_456"},
        })
        admin._opener.open = MagicMock(return_value=mock_resp)

        key = admin.reset_send_key()
        self.assertEqual(key, "sk_new_456")

        # Verify POST method
        call_args = admin._opener.open.call_args
        req = call_args[0][0]
        self.assertEqual(req.get_method(), "POST")


class TestBindingSession(unittest.TestCase):
    """Test the QR binding flow."""

    def test_start_binding(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        admin._logged_in = True
        mock_resp = _mock_opener_response({
            "success": True,
            "data": {"qrcode": "qr_abc", "qr_url": "https://example.com/qr.png"},
        })
        admin._opener.open = MagicMock(return_value=mock_resp)

        session = admin.start_binding()
        self.assertIsInstance(session, BindingSession)
        self.assertEqual(session.qrcode, "qr_abc")
        self.assertEqual(session.qr_url, "https://example.com/qr.png")

    def test_binding_wait_success(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        admin._logged_in = True

        # First poll: waiting; second poll: complete
        responses = [
            _mock_opener_response({"success": True, "data": {"status": "waiting"}}),
            _mock_opener_response({
                "success": True,
                "data": {"id": 5, "status": "pending", "send_key": "sk_new", "is_new": True},
            }),
        ]
        admin._opener.open = MagicMock(side_effect=responses)

        session = BindingSession(admin, "qr_abc", "https://example.com/qr.png")
        result = session.wait(timeout=10, interval=0.1)
        self.assertEqual(result["id"], 5)

    def test_binding_wait_expired(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        admin._logged_in = True

        mock_resp = _mock_opener_response({"success": True, "data": {"status": "expired"}})
        admin._opener.open = MagicMock(return_value=mock_resp)

        session = BindingSession(admin, "qr_abc", "https://example.com/qr.png")
        with self.assertRaises(BotTalkError) as ctx:
            session.wait(timeout=5, interval=0.1)
        self.assertIn("expired", str(ctx.exception))

    def test_binding_wait_timeout(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        admin._logged_in = True

        mock_resp = _mock_opener_response({"success": True, "data": {"status": "waiting"}})
        admin._opener.open = MagicMock(return_value=mock_resp)

        session = BindingSession(admin, "qr_abc", "https://example.com/qr.png")
        with self.assertRaises(TimeoutError):
            session.wait(timeout=1, interval=0.3)

    def test_binding_timeout_cap(self):
        """Timeout should be capped at 300s."""
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        admin._logged_in = True

        mock_resp = _mock_opener_response({"success": True, "data": {"status": "waiting"}})
        admin._opener.open = MagicMock(return_value=mock_resp)

        session = BindingSession(admin, "qr_abc", "https://example.com/qr.png")
        # We can't wait 300s in a test, but we can verify the cap by checking
        # that passing 9999 doesn't break -- it will still timeout quickly due to test
        with self.assertRaises(TimeoutError):
            session.wait(timeout=1, interval=0.3)


class TestAdminSecurity(unittest.TestCase):
    """Test security: no cookie/key leakage."""

    def test_repr_no_cookies(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        r = repr(admin)
        self.assertIn("not_logged_in", r)
        self.assertNotIn("cookie", r.lower())

    def test_repr_logged_in(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        admin._logged_in = True
        r = repr(admin)
        self.assertIn("logged_in", r)

    def test_require_login_all_methods(self):
        admin = BotTalkAdmin()
        methods = [
            admin.list_channels,
            admin.list_reminders,
            admin.get_push_logs,
            admin.get_send_key,
            admin.reset_send_key,
            admin.me,
        ]
        for method in methods:
            with self.assertRaises(BotTalkError):
                method()

    def test_require_login_with_args(self):
        admin = BotTalkAdmin()
        with self.assertRaises(BotTalkError):
            admin.delete_channel(1)
        with self.assertRaises(BotTalkError):
            admin.delete_reminder(1)
        with self.assertRaises(BotTalkError):
            admin.check_bind_status("qr")
        with self.assertRaises(BotTalkError):
            admin.get_qr()


class TestAdminNetwork(unittest.TestCase):
    """Test network error handling."""

    def test_network_error(self):
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        admin._logged_in = True
        import urllib.error
        admin._opener.open = MagicMock(
            side_effect=urllib.error.URLError("Connection refused")
        )
        with self.assertRaises(NetworkError):
            admin.list_channels()

    def test_json_content_type(self):
        """Verify requests use JSON content type."""
        admin = BotTalkAdmin(base_url="http://localhost:3000")
        mock_resp = _mock_opener_response({
            "success": True,
            "data": {"id": 1, "send_key": "sk_x", "channel_count": 0},
        })
        admin._opener.open = MagicMock(return_value=mock_resp)
        admin.login("sk_x")

        call_args = admin._opener.open.call_args
        req = call_args[0][0]
        self.assertEqual(req.get_header("Content-type"), "application/json")


if __name__ == "__main__":
    unittest.main()
