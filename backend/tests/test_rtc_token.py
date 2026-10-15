import base64
import hashlib
import hmac
import struct
import time

from app.services.rtc.token import generate_rtc_token


def test_rtc_token_contains_real_issue_time_and_verified_room_identity(monkeypatch):
    issued_at = 1790465400
    monkeypatch.setattr(time, "time", lambda: issued_at + 0.75)
    app_id = "test-app-id-24-characters"
    app_key = "isolated-token-test-key"
    room_id = "room_测试"
    user_id = "user_7"

    token = generate_rtc_token(
        app_id=app_id, app_key=app_key, room_id=room_id, user_id=user_id,
        expire_at=issued_at + 3600,
    )
    assert token.startswith("001" + app_id)
    packed = base64.b64decode(token[3 + len(app_id):])
    message_size = struct.unpack_from("<H", packed)[0]
    message = packed[2:2 + message_size]
    signature_size = struct.unpack_from("<H", packed, 2 + message_size)[0]
    signature = packed[4 + message_size:]
    assert signature_size == len(signature) == 32
    assert hmac.compare_digest(signature, hmac.new(app_key.encode(), message, hashlib.sha256).digest())
    nonce, actual_issue_time, expires_at = struct.unpack_from("<III", message)
    assert 0 <= nonce < 2**32
    assert actual_issue_time == issued_at
    assert expires_at - actual_issue_time == 3600

    offset = 12
    for expected in (room_id, user_id):
        size = struct.unpack_from("<H", message, offset)[0]
        offset += 2
        assert message[offset:offset + size].decode("utf-8") == expected
        offset += size
    privilege_count = struct.unpack_from("<H", message, offset)[0]
    offset += 2
    privileges = dict(struct.unpack_from("<HI", message, offset + 6 * index) for index in range(privilege_count))
    assert privileges == {0: 0, 1: 0, 2: 0, 3: 0, 4: 0}
    assert offset + 6 * privilege_count == len(message)
