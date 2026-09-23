"""Card-update links a rep hands a customer (spec §9, R14).

A link is ``{APP_BASE_URL}/api/billing/card/{token}``; the token signs
(sponsor id, link version, expiry) with an HMAC keyed off ``ADMIN_SECRET_KEY``
(domain-separated, so no other token in the app can be replayed as one).

* **Revocation is the version:** ``sponsor_billing.card_link_version`` is
  bumped every time a rep mints a link, and a token whose version is not the
  CURRENT one is dead — a new link revokes the old one, with no table of
  issued tokens.
* **Expiry** is ``SALES_CARD_LINK_DAYS`` (7) from minting, inside the token.
* The token is URL-path safe (base64url + ``.`` + hex) and carries no secret:
  the sponsor id in it is not a credential, the signature is.

``token = base64url(f"{sponsor_id}|{version}|{exp}") + "." + hmac_sha256(key, payload)[:32]``
with ``key = sha256(ADMIN_SECRET_KEY + ":card-link")``.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import uuid
from datetime import UTC, datetime, timedelta

from app.config import settings

_SIG_HEX = 32
# A real token is ~100 chars; anything far longer is not ours.
_MAX_TOKEN = 256


def _key() -> bytes:
    return hashlib.sha256(f"{settings.ADMIN_SECRET_KEY}:card-link".encode()).digest()


def _sign(payload: bytes) -> str:
    return hmac.new(_key(), payload, hashlib.sha256).hexdigest()[:_SIG_HEX]


def make_token(sponsor_id: uuid.UUID, version: int, expires_at: datetime) -> str:
    exp = int(expires_at.timestamp())
    payload = f"{sponsor_id}|{int(version)}|{exp}".encode()
    body = base64.urlsafe_b64encode(payload).rstrip(b"=").decode()
    return f"{body}.{_sign(payload)}"


def read_token(token: str, now: datetime | None = None) -> tuple[uuid.UUID, int] | None:
    """``(sponsor_id, version)`` for a genuine, unexpired token; else None.
    Whether that version is still CURRENT is the caller's check (it needs
    the billing row)."""
    if not isinstance(token, str) or len(token) > _MAX_TOKEN or token.count(".") != 1:
        return None
    body, sig = token.split(".")
    try:
        payload = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
    except (binascii.Error, ValueError):
        return None
    if not hmac.compare_digest(_sign(payload), sig):
        return None
    try:
        raw_id, raw_version, raw_exp = payload.decode().split("|")
        sponsor_id, version, exp = uuid.UUID(raw_id), int(raw_version), int(raw_exp)
    except (UnicodeDecodeError, ValueError):
        return None
    if exp <= int((now or datetime.now(UTC)).timestamp()):
        return None
    return sponsor_id, version


def link_expiry(now: datetime | None = None) -> datetime:
    return (now or datetime.now(UTC)) + timedelta(days=settings.SALES_CARD_LINK_DAYS)


def link_url(token: str) -> str:
    return f"{settings.APP_BASE_URL.rstrip('/')}/api/billing/card/{token}"


def done_url(token: str) -> str:
    """Where the portal returns the customer once the card is saved."""
    return f"{link_url(token)}/done"
