"""Lead outcome recording — the ONE writer of lead_contacts + the denorms.

History is append-only; the denormalized columns on `leads` (last_outcome,
last_contacted_at, contact_attempts) exist so the checklist renders without a
per-row aggregate, and they are written HERE in the same transaction as the
history row — nowhere else, or they drift.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.models import Lead, LeadContact

VALID_OUTCOMES = frozenset({"converted", "maybe", "rejected"})


def record_outcome(
    db: Session,
    lead: Lead,
    outcome: str,
    sale_tier: str | None,
    note: str | None,
    recorded_by: str,
) -> LeadContact:
    if outcome not in VALID_OUTCOMES:
        raise ValueError(f"invalid outcome: {outcome!r}")
    now = datetime.now(UTC)
    contact = LeadContact(
        id=uuid.uuid4(), lead_id=lead.id, outcome=outcome,
        # sale_tier is a LABEL (owner decision L7) — never writes a sponsor row.
        sale_tier=sale_tier, note=note, recorded_by=recorded_by, created_at=now,
    )
    db.add(contact)
    lead.last_outcome = outcome
    lead.last_contacted_at = now
    lead.contact_attempts = (lead.contact_attempts or 0) + 1
    db.commit()
    return contact
