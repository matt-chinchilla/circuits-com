"""Admin presence — POST /api/admin/presence/ping

Powers the "who else is in the admin right now" avatar bubbles in the topbar.

Deliberately NOT persisted: presence is ephemeral, worthless after ~a minute,
and writing a row per admin per 30s heartbeat would be pure churn. The API runs
as a single uvicorn process (see docker-compose / the api container entrypoint),
so ONE module-level dict is a correct, complete store here. If the API is ever
scaled to multiple workers this needs a shared backend (Redis) — a per-worker
dict would show a different roster depending on which worker answered.

`last_seen` uses time.monotonic(): the TTL is a duration, and monotonic can't
be dragged backwards by an NTP step the way wall-clock time can.

Auth-gated like the rest of /admin/* via Depends(get_current_user).
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.models.user import User
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/api/admin", tags=["admin-presence"])

# A client heartbeats every 30s; 75s tolerates one dropped ping (plus slack)
# before a user is considered gone.
PRESENCE_TTL_SECONDS = 75.0

# {user_id: {"username": str, "name": str | None, "role": str, "last_seen": float}}
_PRESENCE: dict[str, dict] = {}


class PresenceUser(BaseModel):
    user_id: str
    username: str
    name: str | None = None
    role: str


def _now() -> float:
    """Monotonic clock seam — tests monkeypatch this to fast-forward the TTL."""
    return time.monotonic()


def _prune(now: float) -> None:
    """Drop everyone whose last heartbeat is older than the TTL."""
    for user_id in [
        uid for uid, entry in _PRESENCE.items() if now - entry["last_seen"] > PRESENCE_TTL_SECONDS
    ]:
        del _PRESENCE[user_id]


@router.post("/presence/ping", response_model=list[PresenceUser])
def presence_ping(
    current_user: User = Depends(get_current_user),
) -> list[PresenceUser]:
    """Heartbeat: record the caller as present, then return everyone active.

    The caller IS included in the response (the frontend filters itself out —
    its own avatar already anchors the topbar pill).
    """
    now = _now()
    _PRESENCE[str(current_user.id)] = {
        "username": current_user.username,
        # `name` is future-proofing: the User model has no display name today,
        # so this is None and the UI falls back to the username.
        "name": getattr(current_user, "name", None),
        "role": current_user.role,
        "last_seen": now,
    }
    _prune(now)
    return [
        PresenceUser(
            user_id=user_id,
            username=entry["username"],
            name=entry["name"],
            role=entry["role"],
        )
        # Stable order so the bubble row doesn't reshuffle between polls.
        for user_id, entry in sorted(_PRESENCE.items(), key=lambda kv: kv[1]["username"].lower())
    ]
