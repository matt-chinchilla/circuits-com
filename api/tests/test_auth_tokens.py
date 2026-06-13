"""Unit tests for auth_service token helpers (login TTL + reset tokens).

Covers the security-sensitive bits of the 2026-06-13 account-recovery work:
  - variable session-token TTL (the 30-day "keep me signed in")
  - tableless single-use password-reset tokens (purpose-tagged, fingerprinted,
    30-minute expiry)
These are pure-function tests — no DB, no HTTP.
"""

from datetime import datetime, timedelta, timezone

import jwt
import pytest

from app.config import settings
from app.services import auth_service as svc


def _decode_raw(token: str) -> dict:
    return jwt.decode(token, settings.ADMIN_SECRET_KEY, algorithms=["HS256"])


class TestSessionTokenTTL:
    def test_default_ttl_is_24h(self):
        token = svc.create_token("user-1", "admin")
        p = _decode_raw(token)
        delta = p["exp"] - p["iat"]
        assert abs(delta - svc.TOKEN_EXPIRY_HOURS * 3600) <= 5

    def test_remember_ttl_is_30_days(self):
        token = svc.create_token("user-1", "admin", expires_hours=svc.REMEMBER_EXPIRY_HOURS)
        p = _decode_raw(token)
        delta = p["exp"] - p["iat"]
        assert svc.REMEMBER_EXPIRY_HOURS == 24 * 30
        assert abs(delta - svc.REMEMBER_EXPIRY_HOURS * 3600) <= 5

    def test_session_token_carries_no_purpose(self):
        # get_current_user rejects any token with a purpose claim, so the login
        # token must NOT carry one.
        p = _decode_raw(svc.create_token("user-1", "admin"))
        assert "purpose" not in p


class TestResetToken:
    def test_round_trip_returns_payload(self):
        token = svc.create_reset_token("user-9", "bcrypt$hashvalue")
        payload = svc.decode_reset_token(token)
        assert payload["sub"] == "user-9"
        assert payload["purpose"] == "pwreset"
        assert payload["pwfp"] == svc._pw_fingerprint("bcrypt$hashvalue")

    def test_fingerprint_tracks_password_hash(self):
        # The whole single-use mechanism: change the hash, fingerprint changes,
        # so an old token's pwfp no longer matches → route rejects it.
        assert svc._pw_fingerprint("hash-A") != svc._pw_fingerprint("hash-B")

    def test_session_token_is_not_a_valid_reset_token(self):
        session = svc.create_token("user-9", "admin")
        with pytest.raises(jwt.InvalidTokenError):
            svc.decode_reset_token(session)

    def test_expired_reset_token_raises(self):
        payload = {
            "sub": "user-9",
            "purpose": "pwreset",
            "pwfp": svc._pw_fingerprint("h"),
            "exp": datetime.now(timezone.utc) - timedelta(minutes=1),
            "iat": datetime.now(timezone.utc) - timedelta(minutes=31),
        }
        expired = jwt.encode(payload, settings.ADMIN_SECRET_KEY, algorithm="HS256")
        with pytest.raises(jwt.ExpiredSignatureError):
            svc.decode_reset_token(expired)

    def test_reset_token_expiry_is_30_minutes(self):
        p = _decode_raw(svc.create_reset_token("user-9", "h"))
        delta = p["exp"] - p["iat"]
        assert abs(delta - svc.RESET_EXPIRY_MINUTES * 60) <= 5
        assert svc.RESET_EXPIRY_MINUTES == 30
