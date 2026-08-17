"""/api/admin/feed-credentials — distributor feed API keys, set from Settings.

The supplier sync needs a distributor key. Managing it only through the host
`.env` means every rotation is an ssh + `up -d --force-recreate`; this router
lets an admin paste it into Admin → Settings, where the DB row then WINS over
the environment (`part_feed.registry.get_feed_key`).

THE RULE, and it is the reason this file is small: **the stored value never
leaves the server.** No response, no error detail, no log line. Reads answer
with a status shape — configured / source / last4 / updated_at — and `last4` is
filled ONLY for a database key, because four characters of the server's own
environment secret would be a leak with nothing to gain: the admin cannot
rotate that one from here anyway.

Scope is FEED KEYS ONLY. `STRIPE_SECRET_KEY`, `ADMIN_SECRET_KEY` and the
calendar secret stay in the environment where an admin session cannot reach
them; a key that buys distributor part data is a different blast radius from one
that moves money.

Auth is `get_current_user` on all three verbs — the demo account keeps its READ
(the Settings card must render for a prospect, and the shape carries no secret)
and is refused both writes by the global demo read-only gate in auth_service.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import ProviderCredential, User
from app.services.auth_service import get_current_user
from app.services.part_feed import FEED_PROVIDERS, env_feed_key

router = APIRouter(prefix="/api/admin/feed-credentials", tags=["admin-feed-credentials"])

# slug → display label, straight off the provider registry: adding Digi-Key
# there is the whole edit, and an unknown slug here is a 404 rather than a row
# nothing will ever read.
_LABELS: dict[str, str] = dict(FEED_PROVIDERS)

# What a distributor key can plausibly be. The floor rejects an obvious
# paste-accident, the ceiling keeps an unbounded blob out of the column, and
# printable-ASCII-only stops a smuggled newline from splitting a request header
# at the provider. Deliberately loose otherwise — the format belongs to another
# company and may change without telling us.
_MIN_KEY_LENGTH = 8
_MAX_KEY_LENGTH = 128


class FeedCredentialUpdate(BaseModel):
    api_key: str


def _known_provider(provider: str) -> str:
    if provider not in _LABELS:
        raise HTTPException(status_code=404, detail="Not found")
    return provider


def _validated_key(raw: str) -> str:
    """The key as it will be stored, or 422.

    NEVER quotes the rejected value back: a validation message is the classic
    place a secret escapes into a log or a screenshot. `strip()` first — a
    pasted key routinely carries a trailing newline, and stored raw it would
    travel into the header of every feed call.
    """
    key = (raw or "").strip()
    if not _MIN_KEY_LENGTH <= len(key) <= _MAX_KEY_LENGTH:
        raise HTTPException(status_code=422, detail="invalid_api_key")
    if not (key.isascii() and key.isprintable()):
        raise HTTPException(status_code=422, detail="invalid_api_key")
    return key


def _status(db: Session, provider: str) -> dict:
    """One provider's row of the card. Contains no secret, by construction."""
    row = db.query(ProviderCredential).filter(ProviderCredential.provider == provider).first()
    stored = (row.api_key or "").strip() if row else ""
    if stored:
        return {
            "provider": provider,
            "label": _LABELS[provider],
            "configured": True,
            "source": "database",
            "last4": stored[-4:],
            "updated_at": row.updated_at.isoformat() if row and row.updated_at else None,
        }
    configured = env_feed_key(provider) is not None
    return {
        "provider": provider,
        "label": _LABELS[provider],
        "configured": configured,
        # A blanked-out row is not a source: `get_feed_key` skips it too, so the
        # card must agree with what a sync would actually use.
        "source": "environment" if configured else None,
        "last4": None,
        "updated_at": None,
    }


def _all_statuses(db: Session) -> dict:
    return {"providers": [_status(db, slug) for slug in _LABELS]}


@router.get("/")
def list_feed_credentials(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Every known provider and where its key is coming from — never the key."""
    return _all_statuses(db)


@router.put("/{provider}")
def set_feed_credential(
    provider: str,
    body: FeedCredentialUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Store (or replace) this provider's key. Answers the same status shape as
    GET — the caller has just typed the value and has no use for it back."""
    provider = _known_provider(provider)
    key = _validated_key(body.api_key)
    row = db.query(ProviderCredential).filter(ProviderCredential.provider == provider).first()
    if row is None:
        db.add(ProviderCredential(provider=provider, api_key=key))
    else:
        row.api_key = key
    db.commit()
    return _all_statuses(db)


@router.delete("/{provider}")
def clear_feed_credential(
    provider: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Drop the stored key. 200 whether a row was there or not — two admins on
    the same card, or a double-click, both asked for the state they now have.

    The response may still say configured: removing the DB row hands the feed
    back to the environment variable, which is a source change, not an off
    switch, and the card says which.
    """
    provider = _known_provider(provider)
    db.query(ProviderCredential).filter(ProviderCredential.provider == provider).delete(
        synchronize_session=False
    )
    db.commit()
    return _all_statuses(db)
