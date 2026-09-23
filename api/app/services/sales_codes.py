"""Rep discount codes — the core (spec §6). Routes live elsewhere (T4/T7).

A code is 8 Crockford base32 characters (no I, L, O or U), stored upper-case
without its dash and shown ``XXXX-XXXX``. Typing is forgiving: case, spaces,
dashes and the O/0 + I/L/1 confusions all normalise to the same code.

``usable_code`` answers ``None`` for EVERY reason a code cannot be used —
unknown, switched off, expired, used up, or locked to another tier, placement
or email — so no caller can leak which one; the public answer is always
``NOT_VALID_MESSAGE``.
"""

import secrets
import uuid
from datetime import UTC, datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.sales import CheckoutIntent, SalesCode
from app.services.sales_pricing import EXCLUSIVE_TIERS

NOT_VALID_MESSAGE = "This code isn't valid for this purchase."
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32 minus I L O U
CODE_LENGTH = 8

# Crockford's read-side aliases; U has none on purpose (it is simply invalid).
_CONFUSABLES = str.maketrans({"O": "0", "I": "1", "L": "1"})
# Whitespace and every dash a phone or a word processor might paste.
_SEPARATORS = str.maketrans("", "", " \t\r\n-‐‑‒–—−_")
_MAX_RAW_LENGTH = 64


def generate_code() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH))


def normalize_code(raw: str | None) -> str | None:
    if not isinstance(raw, str) or len(raw) > _MAX_RAW_LENGTH:
        return None
    code = raw.translate(_SEPARATORS).upper().translate(_CONFUSABLES)
    if len(code) != CODE_LENGTH or not set(code) <= set(ALPHABET):
        return None
    return code


def display_code(code: str) -> str:
    return f"{code[:4]}-{code[4:]}"


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def usable_code(
    db: Session,
    raw: str | None,
    *,
    tier: str,
    category_id: uuid.UUID | None,
    email: str | None,
    lock: bool = False,
    now: datetime | None = None,
) -> SalesCode | None:
    """The code row when it may be used for THIS purchase, else ``None``.

    Usable = active, not expired, ``uses + open intents < max_uses``, and every
    lock it carries matches: tier (NULL = either exclusive tier), placement
    (``category_id``), and ``email_lock`` — the email lock is checked only when
    ``email`` is not None, so ``/quote`` can price a code before the buyer has
    typed an address (LU-F18). Codes apply to Gold and Platinum only (R8).

    ``lock=True`` takes ``SELECT … FOR UPDATE`` on the code row, so inside the
    intent transaction two buyers cannot both spend its last use (LU-F19);
    run ``checkout_intents.expire_lapsed`` first so a lapsed hold stops
    counting. Never commits.
    """
    code = normalize_code(raw)
    t = tier.strip().lower() if isinstance(tier, str) else None
    if code is None or t not in EXCLUSIVE_TIERS:
        return None

    query = db.query(SalesCode).filter(SalesCode.code == code)
    if lock:
        query = query.with_for_update()
    row = query.one_or_none()
    if row is None or not row.active:
        return None
    if _as_utc(row.expires_at) <= (now or datetime.now(UTC)):
        return None
    if row.tier is not None and row.tier.strip().lower() != t:
        return None
    if row.category_id is not None and row.category_id != category_id:
        return None
    if (
        email is not None
        and row.email_lock
        and email.strip().lower() != row.email_lock.strip().lower()
    ):
        return None

    open_intents = (
        db.query(func.count(CheckoutIntent.id))
        .filter(CheckoutIntent.sales_code_id == row.id, CheckoutIntent.status == "open")
        .scalar()
    )
    if row.uses + open_intents >= row.max_uses:
        return None
    return row
