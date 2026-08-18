"""Persisting a live feed run — one `activity_events` row per wire event.

Three callers produce the same event stream and need the same rule about what
becomes a row: the sync route, the import route, and the nightly import job,
which has no socket at all and only exists as its rows in the dashboard. So the
rule lives here rather than in whichever route was written first.

`activity_events` is append-only and the dashboard reads it newest-first; each
row gets its OWN commit, so an abort (client disconnect, provider blowing up)
keeps everything already reported.
"""

import logging
import uuid

from sqlalchemy.orm import Session

from app.models import ActivityEvent

logger = logging.getLogger(__name__)

# Which `part_synced` actions become a row, and under WHICH stored kind.
#
# Only an action that WROTE something is persisted. `ActivityEvent` has no
# action column, so the kind is all the dashboard has to go on afterwards, and
# a `not_found` / `no_data` row would render as a change that never happened.
# Both still travel the live stream, where the operator sees exactly what the
# feed did and did not answer.
#
# `created` (an import's whole product) maps to its own kind for the same
# reason the transient actions are dropped: the wire's `action` does not
# survive into the table, and the `part_synced` template — "Synced X into Y" —
# would describe a part that did not exist before this run as a refresh of one
# that did. `routes/dashboard.py::_event_description` holds the other half.
_PART_ACTION_KINDS: dict[str, str] = {
    "updated": "part_synced",
    "media_filled": "part_synced",
    "created": "part_imported",
}


def record_stream_event(db: Session, supplier_id: uuid.UUID, event: dict) -> None:
    """Append one activity row for `event` — its own commit (see module docs).

    Values are clamped to their columns here rather than trusted: `title` is
    the feed's own `sku — manufacturer` string and nothing upstream bounds the
    manufacturer, and Postgres answers an over-long value with
    StringDataRightTruncation, which would kill the run mid-stream. SQLite
    accepts it silently, so the test suite alone would never catch it.
    """
    kind = str(event.get("kind"))
    if kind == "part_synced":
        action = event.get("action")
        stored_kind = _PART_ACTION_KINDS.get(action) if isinstance(action, str) else None
        if stored_kind is None:
            return
        kind = stored_kind
    detail = event.get("detail")
    # ONLY the event's own image (a feed part photo, already bounded to 500 by
    # the importer's `_safe_image`). Never `supplier.logo_url` — that column is
    # Text and routinely holds a 64KB data URL from the admin's cropper.
    image_url = event.get("image_url")
    if image_url and len(image_url) > 500:
        # Unreachable through the importer; a dropped thumbnail still beats a
        # truncated (broken) URL, and beats aborting the run.
        image_url = None
    try:
        db.add(
            ActivityEvent(
                id=uuid.uuid4(),
                kind=kind[:40],
                supplier_id=supplier_id,
                title=str(event.get("title") or "")[:255],
                detail=detail[:500] if detail else None,
                image_url=image_url,
            )
        )
        db.commit()
    except Exception:  # noqa: BLE001
        # An activity row is bookkeeping. If the DB hiccups mid-run, losing
        # one row must not cut the NDJSON stream off mid-line — roll back and
        # let the stream keep reporting. It still gets logged: silently
        # dropping rows is how "the dashboard is missing runs" becomes
        # unexplainable. NEVER log the event's contents — `title`/`detail`
        # are unbounded feed strings, and the traceback is the actual signal.
        logger.warning("activity event persist failed for supplier %s", supplier_id, exc_info=True)
        db.rollback()
