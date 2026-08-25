import jwt
import pytest

from app.services.auth_service import (
    VERIFY_EXPIRY_HOURS,
    create_token,
    create_verify_token,
    decode_reset_token,
    decode_verify_token,
    verify_token_matches_email,
)


def test_ttl_is_24_hours():
    # D13. Reset is 30 minutes because it hands over a live credential;
    # this only proves mailbox control.
    assert VERIFY_EXPIRY_HOURS == 24


def test_round_trips():
    token = create_verify_token("abc-123", "Person@Example.com")
    payload = decode_verify_token(token)
    assert payload["sub"] == "abc-123"
    assert payload["purpose"] == "verify"


def test_a_session_token_is_not_a_verify_token():
    with pytest.raises(jwt.InvalidTokenError):
        decode_verify_token(create_token("abc-123", "user"))


def test_a_verify_token_is_not_a_reset_token():
    with pytest.raises(jwt.InvalidTokenError):
        decode_reset_token(create_verify_token("abc-123", "a@test.example"))


def test_email_fingerprint_is_case_insensitive():
    # The address is stored lowercased; a token minted from the typed form
    # must still match.
    payload = decode_verify_token(create_verify_token("abc", "Person@Example.com"))
    assert verify_token_matches_email(payload, "person@example.com") is True


def test_email_fingerprint_rejects_a_different_address():
    payload = decode_verify_token(create_verify_token("abc", "a@test.example"))
    assert verify_token_matches_email(payload, "b@test.example") is False
