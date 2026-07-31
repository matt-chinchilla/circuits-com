"""bcrypt's 72-byte input ceiling must never reach a route as a 500.

bcrypt >= 4 RAISES ``ValueError`` on input longer than 72 bytes instead of
truncating, and ``app/main.py`` registers no exception handler — so an
unclamped ``verify_password`` turns a long password into a 500. Two contracts
follow, and both are security contracts:

1. **No account oracle.** A >72-byte password must return the byte-identical
   generic 401 whether or not the address exists. Unclamped, the known address
   500s (bcrypt is reached) and the unknown one 401s (the not-found path burns
   a fixed-length dummy hash and can never raise) — one request per address
   enumerates every account, defeating the timing equalization the login path
   goes out of its way to preserve.
2. **No 500 on the write side.** The policy caps passwords at 24 CODE POINTS
   while bcrypt counts BYTES, so ``"Aa1!" + 20 emoji`` is policy-VALID at 84
   bytes. ``hash_password`` must accept every password the policy accepts.

The clamp lives in ``auth_service._bcrypt_bytes`` so every call site — login,
change-password, reset-password, the seed — is covered by construction.
"""

import bcrypt
import pytest

from app.services.auth_service import (
    BCRYPT_MAX_BYTES,
    hash_password,
    verify_password,
)
from app.services.password_policy import validate_password

ADMIN_EMAIL = "admin@test.example"
ADMIN_PASSWORD = "testpass123"
GENERIC_401 = {"detail": "Invalid credentials"}

# 24 code points (the policy maximum) but 84 UTF-8 bytes — valid policy, over
# bcrypt's ceiling. This is the exact shape that used to 500 hash_password.
EMOJI_PASSWORD = "Aa1!" + "\U0001f600" * 20
# Comfortably past the ceiling, the shape an attacker would probe /login with.
LONG_PASSWORD = "A" * 200


def _login(client, *, email, password, ip):
    return client.post(
        "/api/auth/login",
        json={"email": email, "password": password},
        headers={"X-Forwarded-For": ip},
    )


class TestBcryptCeilingIsUnreachable:
    def test_raw_bcrypt_still_raises_which_is_why_the_clamp_exists(self):
        """Pin the upstream behaviour this module defends against — if bcrypt
        ever starts truncating again, this test tells us why the clamp can go."""
        with pytest.raises(ValueError):
            bcrypt.hashpw(b"A" * (BCRYPT_MAX_BYTES + 1), bcrypt.gensalt())

    def test_hash_password_accepts_a_policy_valid_multibyte_password(self):
        assert len(EMOJI_PASSWORD) == 24
        assert len(EMOJI_PASSWORD.encode()) > BCRYPT_MAX_BYTES
        assert validate_password(EMOJI_PASSWORD) == []
        assert verify_password(EMOJI_PASSWORD, hash_password(EMOJI_PASSWORD)) is True

    def test_hash_and_verify_are_total_for_an_arbitrarily_long_password(self):
        hashed = hash_password(LONG_PASSWORD)
        assert verify_password(LONG_PASSWORD, hashed) is True
        assert verify_password("wrong" * 100, hashed) is False

    def test_only_the_first_72_bytes_are_significant(self):
        """Documented consequence of the clamp, and of bcrypt itself: bytes past
        72 were never part of the digest, so two passwords sharing a 72-byte
        prefix are the same password. Asserted so it stays a known property
        rather than a surprise."""
        base = "P@ssw0rd" + "a" * 100
        assert verify_password(base + "-different-tail", hash_password(base)) is True


class TestLongPasswordIsNotAnAccountOracle:
    def test_a_known_account_answers_401_not_500(self, client, seeded_db):
        resp = _login(client, email=ADMIN_EMAIL, password=LONG_PASSWORD, ip="10.1.1.1")
        assert resp.status_code == 401
        assert resp.json() == GENERIC_401

    def test_known_and_unknown_addresses_answer_identically(self, client, seeded_db):
        # Distinct IPs so neither response can pick up a Retry-After the other
        # lacks — the comparison must be about the ADDRESS, nothing else.
        known = _login(client, email=ADMIN_EMAIL, password=LONG_PASSWORD, ip="10.2.2.2")
        unknown = _login(client, email="ghost@test.example", password=LONG_PASSWORD, ip="10.3.3.3")
        assert known.status_code == unknown.status_code == 401
        assert known.json() == unknown.json() == GENERIC_401
        assert "Retry-After" not in known.headers
        assert "Retry-After" not in unknown.headers

    def test_a_long_password_still_cannot_sign_in(self, client, seeded_db):
        """The clamp must not become a bypass: truncation happens on BOTH sides,
        so a long wrong password is still wrong."""
        assert (
            _login(
                client, email=ADMIN_EMAIL, password=ADMIN_PASSWORD + "x" * 200, ip="10.4.4.4"
            ).status_code
            == 401
        )


class TestWriteSidePathsAcceptEveryPolicyValidPassword:
    def _token(self, client):
        resp = client.post(
            "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
        )
        assert resp.status_code == 200
        return resp.json()["token"]

    def test_change_password_accepts_a_24_emoji_password(self, client, seeded_db):
        resp = client.post(
            "/api/auth/change-password",
            json={"current_password": ADMIN_PASSWORD, "new_password": EMOJI_PASSWORD},
            headers={"Authorization": f"Bearer {self._token(client)}"},
        )
        assert resp.status_code == 200
        assert (
            client.post(
                "/api/auth/login", json={"email": ADMIN_EMAIL, "password": EMOJI_PASSWORD}
            ).status_code
            == 200
        )

    def test_reset_password_accepts_a_24_emoji_password(self, client, db, seeded_db):
        from app.services import auth_service as svc

        user = seeded_db["admin_user"]
        token = svc.create_reset_token(str(user.id), user.password_hash)
        resp = client.post(
            "/api/auth/reset-password",
            json={"token": token, "new_password": EMOJI_PASSWORD},
        )
        assert resp.status_code == 200
        assert (
            client.post(
                "/api/auth/login", json={"email": ADMIN_EMAIL, "password": EMOJI_PASSWORD}
            ).status_code
            == 200
        )
