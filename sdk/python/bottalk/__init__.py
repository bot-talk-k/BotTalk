"""BotTalk Python SDK -- push messages to WeChat via bot-talk.com."""

from .client import BotTalk
from .admin import BotTalkAdmin, BindingSession
from .exceptions import (
    EmptyMessageError,
    InvalidKeyError,
    NetworkError,
    NoChannelError,
    BotTalkError,
    PushFailedError,
    RateLimitError,
)
from .models import ChannelResult, PushResult

__version__ = "0.1.0"

__all__ = [
    "BotTalk",
    "BotTalkAdmin",
    "BindingSession",
    "PushResult",
    "ChannelResult",
    "BotTalkError",
    "InvalidKeyError",
    "NoChannelError",
    "EmptyMessageError",
    "RateLimitError",
    "PushFailedError",
    "NetworkError",
]
