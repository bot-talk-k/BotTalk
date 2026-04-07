"""Unit tests for the BotTalk Python SDK."""

import json
import unittest
import urllib.error
from io import BytesIO
from unittest.mock import MagicMock, patch

from bottalk import (
    ChannelResult,
    EmptyMessageError,
    InvalidKeyError,
    NetworkError,
    NoChannelError,
    BotTalk,
    BotTalkError,
    PushFailedError,
    PushResult,
    RateLimitError,
)


def _mock_response(data: dict, status: int = 200):
    """Create a mock urllib response."""
    body = json.dumps(data).encode("utf-8")
    resp = MagicMock()
    resp.read.return_value = body
    resp.status = status
    resp.__enter__ = MagicMock(return_value=resp)
    resp.__exit__ = MagicMock(return_value=False)
    return resp


class TestBotTalkInit(unittest.TestCase):
    """Constructor validation."""

    def test_valid_key(self):
        client = BotTalk("abc123")
        self.assertIn("abc***", repr(client))

    def test_empty_key_raises(self):
        with self.assertRaises(ValueError):
            BotTalk("")

    def test_none_key_raises(self):
        with self.assertRaises(ValueError):
            BotTalk(None)

    def test_invalid_chars_raises(self):
        with self.assertRaises(ValueError):
            BotTalk("key with spaces")

    def test_injection_in_key_raises(self):
        with self.assertRaises(ValueError):
            BotTalk("../../../etc/passwd")

    def test_slash_in_key_raises(self):
        with self.assertRaises(ValueError):
            BotTalk("key/inject")

    def test_custom_base_url(self):
        client = BotTalk("mykey", base_url="https://self.example.com/")
        self.assertEqual(client.base_url, "https://self.example.com")

    def test_repr_masks_key(self):
        client = BotTalk("secret_key_12345")
        r = repr(client)
        self.assertNotIn("secret_key_12345", r)
        self.assertIn("sec***", r)

    def test_short_key_fully_masked(self):
        client = BotTalk("ab")
        self.assertIn("***", repr(client))


class TestSendValidation(unittest.TestCase):
    """Parameter validation before HTTP request."""

    def setUp(self):
        self.client = BotTalk("testkey123")

    def test_empty_title_and_desp_raises(self):
        with self.assertRaises(EmptyMessageError):
            self.client.send("", "")

    def test_invalid_method_raises(self):
        with self.assertRaises(ValueError):
            self.client.send("hello", method="DELETE")


class TestSendSuccess(unittest.TestCase):
    """Successful push scenarios."""

    def setUp(self):
        self.client = BotTalk("testkey123", base_url="https://example.com")

    @patch("bottalk.client.urllib.request.urlopen")
    def test_post_success(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({
            "code": 0,
            "message": "success",
            "data": {"results": [{"channel_id": "1", "status": "success"}]},
        })

        result = self.client.send("Hello", desp="World")
        self.assertIsInstance(result, PushResult)
        self.assertTrue(result.is_success)
        self.assertEqual(result.code, 0)
        self.assertTrue(bool(result))
        self.assertEqual(len(result.results), 1)
        self.assertTrue(result.results[0].is_success)

        # Verify POST was used
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertEqual(req.method, "POST")
        self.assertIn(b"title=Hello", req.data)
        self.assertIn(b"desp=World", req.data)

    @patch("bottalk.client.urllib.request.urlopen")
    def test_get_success(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({
            "code": 0,
            "message": "success",
            "data": {"results": []},
        })

        result = self.client.send("Title only", method="GET")
        self.assertTrue(result.is_success)

        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.method, "GET")
        self.assertIn("title=Title+only", req.full_url)

    @patch("bottalk.client.urllib.request.urlopen")
    def test_title_only(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"code": 0, "message": "success", "data": None})
        result = self.client.send("Just a title")
        self.assertTrue(result.is_success)

    @patch("bottalk.client.urllib.request.urlopen")
    def test_desp_only(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"code": 0, "message": "success", "data": None})
        result = self.client.send(desp="Body only, no title")
        self.assertTrue(result.is_success)

    @patch("bottalk.client.urllib.request.urlopen")
    def test_channel_param(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"code": 0, "message": "success", "data": None})
        self.client.send("Hi", channel="all")

        req = mock_urlopen.call_args[0][0]
        self.assertIn(b"channel=all", req.data)

    @patch("bottalk.client.urllib.request.urlopen")
    def test_url_path_contains_key(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"code": 0, "message": "success", "data": None})
        self.client.send("Test")

        req = mock_urlopen.call_args[0][0]
        self.assertIn("/testkey123.send", req.full_url)

    @patch("bottalk.client.urllib.request.urlopen")
    def test_unicode_content(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"code": 0, "message": "success", "data": None})
        result = self.client.send("中文标题", desp="中文内容 🎉")
        self.assertTrue(result.is_success)


class TestSendErrors(unittest.TestCase):
    """Server-side error responses."""

    def setUp(self):
        self.client = BotTalk("testkey123")

    @patch("bottalk.client.urllib.request.urlopen")
    def test_invalid_key_error(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"code": 40001, "message": "SendKey 无效", "data": None})
        with self.assertRaises(InvalidKeyError) as ctx:
            self.client.send("test")
        self.assertEqual(ctx.exception.code, 40001)

    @patch("bottalk.client.urllib.request.urlopen")
    def test_no_channel_error(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"code": 40002, "message": "没有可用的推送通道", "data": None})
        with self.assertRaises(NoChannelError):
            self.client.send("test")

    @patch("bottalk.client.urllib.request.urlopen")
    def test_rate_limit_error(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"code": 42901, "message": "发送频率超限", "data": None})
        with self.assertRaises(RateLimitError):
            self.client.send("test")

    @patch("bottalk.client.urllib.request.urlopen")
    def test_push_failed_error(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"code": 50001, "message": "全部推送失败", "data": None})
        with self.assertRaises(PushFailedError):
            self.client.send("test")

    @patch("bottalk.client.urllib.request.urlopen")
    def test_unknown_error_code(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"code": 99999, "message": "Unknown", "data": None})
        with self.assertRaises(BotTalkError):
            self.client.send("test")


class TestNetworkErrors(unittest.TestCase):
    """Network-level failures."""

    def setUp(self):
        self.client = BotTalk("testkey123")

    @patch("bottalk.client.urllib.request.urlopen")
    def test_url_error(self, mock_urlopen):
        mock_urlopen.side_effect = urllib.error.URLError("DNS lookup failed")
        with self.assertRaises(NetworkError):
            self.client.send("test")

    @patch("bottalk.client.urllib.request.urlopen")
    def test_timeout_error(self, mock_urlopen):
        mock_urlopen.side_effect = TimeoutError("Connection timed out")
        with self.assertRaises(NetworkError):
            self.client.send("test")

    @patch("bottalk.client.urllib.request.urlopen")
    def test_os_error(self, mock_urlopen):
        mock_urlopen.side_effect = OSError("Connection refused")
        with self.assertRaises(NetworkError):
            self.client.send("test")

    @patch("bottalk.client.urllib.request.urlopen")
    def test_http_error_with_json_body(self, mock_urlopen):
        body = json.dumps({"code": 40001, "message": "SendKey 无效", "data": None}).encode()
        exc = urllib.error.HTTPError(
            url="http://example.com",
            code=400,
            msg="Bad Request",
            hdrs={},
            fp=BytesIO(body),
        )
        mock_urlopen.side_effect = exc
        with self.assertRaises(InvalidKeyError):
            self.client.send("test")

    @patch("bottalk.client.urllib.request.urlopen")
    def test_http_error_without_json_body(self, mock_urlopen):
        exc = urllib.error.HTTPError(
            url="http://example.com",
            code=500,
            msg="Internal Server Error",
            hdrs={},
            fp=BytesIO(b"not json"),
        )
        mock_urlopen.side_effect = exc
        with self.assertRaises(NetworkError):
            self.client.send("test")


class TestModels(unittest.TestCase):
    """PushResult and ChannelResult."""

    def test_push_result_bool_true(self):
        r = PushResult(code=0, message="success")
        self.assertTrue(r)

    def test_push_result_bool_false(self):
        r = PushResult(code=50001, message="failed")
        self.assertFalse(r)

    def test_push_result_with_channels(self):
        r = PushResult(code=0, message="success", data={
            "results": [
                {"channel_id": "1", "status": "success"},
                {"channel_id": "2", "status": "failed", "token_invalid": True},
                {"channel_id": "3", "status": "skipped", "reason": "no context_token"},
            ]
        })
        self.assertEqual(len(r.results), 3)
        self.assertTrue(r.results[0].is_success)
        self.assertFalse(r.results[1].is_success)
        self.assertTrue(r.results[1].token_invalid)
        self.assertEqual(r.results[2].reason, "no context_token")

    def test_push_result_repr(self):
        r = PushResult(code=0, message="ok")
        self.assertIn("code=0", repr(r))


class TestExceptions(unittest.TestCase):
    """Exception hierarchy."""

    def test_all_inherit_from_base(self):
        for exc_cls in (InvalidKeyError, NoChannelError, EmptyMessageError, RateLimitError, PushFailedError, NetworkError):
            self.assertTrue(issubclass(exc_cls, BotTalkError))

    def test_exception_repr(self):
        e = BotTalkError("test error", code=123)
        self.assertIn("123", repr(e))
        self.assertIn("test error", repr(e))


class TestURLEncoding(unittest.TestCase):
    """Ensure proper URL encoding of parameters."""

    def setUp(self):
        self.client = BotTalk("testkey123")

    @patch("bottalk.client.urllib.request.urlopen")
    def test_special_chars_in_title(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"code": 0, "message": "success", "data": None})
        self.client.send("title&param=inject", desp="<script>alert(1)</script>")

        req = mock_urlopen.call_args[0][0]
        # & and = should be encoded in form data, not treated as param separators
        self.assertNotIn(b"&param=inject", req.data.split(b"&desp=")[0])

    @patch("bottalk.client.urllib.request.urlopen")
    def test_special_chars_in_get(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"code": 0, "message": "success", "data": None})
        self.client.send("a&b=c", method="GET")

        req = mock_urlopen.call_args[0][0]
        # The & should be encoded as %26 in the query string value
        self.assertIn("%26", req.full_url)


if __name__ == "__main__":
    unittest.main()
