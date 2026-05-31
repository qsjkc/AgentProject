import base64
import hashlib
import hmac
import io
import secrets
import struct


TOKEN_VERSION = "001"
APP_ID_LENGTH = 24


class TokenPrivileges:
    PUBLISH_STREAM = 0
    PUBLISH_AUDIO_STREAM = 1
    PUBLISH_VIDEO_STREAM = 2
    PUBLISH_DATA_STREAM = 3
    SUBSCRIBE_STREAM = 4


def _pack_bytes(payload: bytes) -> bytes:
    return struct.pack("<H", len(payload)) + payload


def _pack_string(value: str) -> bytes:
    return _pack_bytes(value.encode("utf-8"))


def _pack_privileges(privileges: dict[int, int]) -> bytes:
    buffer = io.BytesIO()
    buffer.write(struct.pack("<H", len(privileges)))
    for key, expire_at in privileges.items():
        buffer.write(struct.pack("<H", key))
        buffer.write(struct.pack("<I", expire_at))
    return buffer.getvalue()


def generate_rtc_token(
    *,
    app_id: str,
    app_key: str,
    room_id: str,
    user_id: str,
    expire_at: int,
) -> str:
    issued_at = int(secrets.randbelow(1 << 31))
    nonce = secrets.randbits(32)
    privileges = {
        TokenPrivileges.PUBLISH_STREAM: 0,
        TokenPrivileges.PUBLISH_AUDIO_STREAM: 0,
        TokenPrivileges.PUBLISH_VIDEO_STREAM: 0,
        TokenPrivileges.PUBLISH_DATA_STREAM: 0,
        TokenPrivileges.SUBSCRIBE_STREAM: 0,
    }

    message = (
        struct.pack("<I", nonce)
        + struct.pack("<I", issued_at)
        + struct.pack("<I", expire_at)
        + _pack_string(room_id)
        + _pack_string(user_id)
        + _pack_privileges(privileges)
    )
    signature = hmac.new(app_key.encode("utf-8"), message, hashlib.sha256).digest()
    content = _pack_bytes(message) + _pack_bytes(signature)
    return TOKEN_VERSION + app_id + base64.b64encode(content).decode("utf-8")
