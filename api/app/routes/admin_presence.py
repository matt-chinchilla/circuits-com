"""Admin presence — POST /api/admin/presence/ping

Powers the "who else is in the admin right now" avatar bubbles in the topbar.

DB-backed via `users.last_seen_at` (alembic 021): prod runs
`uvicorn --workers 4` (docker-compose.prod.yml), so the original module-level
dict was PER-WORKER — the roster changed depending on which worker answered a
poll and peers flickered in and out (2026-07-31 review finding). One nullable
timestamp on the existing users row is the smallest store every worker shares;
the cost is one UPDATE per open admin tab per 30s, which the demo-scale DB
does not notice.

Wall-clock (timezone-aware UTC) rather than time.monotonic(): monotonic is
per-process, meaningless across workers. An NTP step can wobble the 75s TTL by
its skew — harmless for a presence indicator.

Auth-gated like the rest of /admin/* via Depends(get_current_user).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.user import User
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/api/admin", tags=["admin-presence"])

# A client heartbeats every 30s; 75s tolerates one dropped ping (plus slack)
# before a user is considered gone.
PRESENCE_TTL_SECONDS = 75.0


class PresenceUser(BaseModel):
    user_id: str
    username: str
    name: str | None = None
    role: str


def _now() -> datetime:
    """Clock seam — tests monkeypatch this to fast-forward the TTL."""
    return datetime.now(timezone.utc)


@router.post("/presence/ping", response_model=list[PresenceUser])
def presence_ping(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[PresenceUser]:
    """Heartbeat: record the caller as present, then return everyone active.

    The caller IS included in the response (the frontend filters itself out —
    its own avatar already anchors the topbar pill).
    """
    now = _now()
    current_user.last_seen_at = now
    db.commit()
    cutoff = now - timedelta(seconds=PRESENCE_TTL_SECONDS)
    active = (
        db.query(User)
        .filter(User.last_seen_at.isnot(None), User.last_seen_at > cutoff)
        # Stable order so the bubble row doesn't reshuffle between polls.
        .order_by(User.username)
        .all()
    )
    return [
        PresenceUser(
            user_id=str(u.id),
            username=u.username,
            # `name` is future-proofing: the User model has no display name
            # today, so this is None and the UI falls back to the username.
            name=getattr(u, "name", None),
            role=u.role,
        )
        for u in active
    ]
