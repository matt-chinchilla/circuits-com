"""Seed the sales call list (synthesis §5.3 steps 7-8).

INSERT-IF-ABSENT on source_key ONLY — a re-run restores missing roster rows
but NEVER touches CRM state (outcomes, attempts, enrichment edits) on rows
that already exist. That is what makes SEED_LEADS=true safe to leave on
forever (owner decision L6).
"""

from __future__ import annotations

import csv
import uuid
from pathlib import Path

from sqlalchemy.orm import Session

from app.models import Lead, Manufacturer
from app.services.lead_distance import distance_from_hq_miles
from app.services.manufacturer_canon import canon, split_branch

_ENRICHMENT = "ENRICHMENT NEEDED"


def seed_leads(db: Session, csv_path: Path | None = None) -> dict:
    path = csv_path or Path(__file__).parent / "seed_data" / "leads.csv"
    if not path.exists():
        print("Seed: leads.csv not found, skipping leads.")
        return {}

    counts = {
        "leads_rows": 0,
        "leads_created": 0,
        "enrichment_rows": 0,
        "linked": 0,
        "distance_backfilled": 0,
    }

    existing = {l[0] for l in db.query(Lead.source_key).all()}
    mfr_by_canon = {m.canonical_key: m.id for m in db.query(Manufacturer).all()}

    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if (r.get("Company") or "").strip()]
    counts["leads_rows"] = len(rows)

    def clean(r: dict, key: str, cap: int) -> str | None:
        v = (r.get(key) or "").strip()
        return v[:cap] or None

    for r in rows:
        company = r["Company"].strip()
        raw_contact = (r.get("Contact Name") or "").strip()
        is_placeholder = raw_contact.upper() == _ENRICHMENT or not raw_contact
        contact = None if is_placeholder else raw_contact
        source_key = canon(f"{company}|{contact or '__company__'}")[:300]
        if source_key in existing:
            continue
        existing.add(source_key)

        head, branch = split_branch(company)
        company_slug = canon(head)[:220]
        tier = clean(r, "Tier(S/M/L)", 1)
        lead = Lead(
            id=uuid.uuid4(),
            source_key=source_key,
            company_name=company[:200],
            branch_label=branch[:80] if branch else None,
            company_slug=company_slug,
            manufacturer_id=mfr_by_canon.get(company_slug),
            tier=tier,
            ring=clean(r, "Ring", 12),
            street=clean(r, "Street Address", 200),
            city=clean(r, "City", 80),
            state=clean(r, "State", 2),
            postal_code=clean(r, "ZIP", 10),
            main_phone=clean(r, "Main Phone", 24),
            website=clean(r, "Website", 200),
            sales_email=clean(r, "General Sales Email", 200),
            contact_name=contact[:120] if contact else None,
            needs_enrichment=is_placeholder,
            contact_title=clean(r, "Contact Title", 120),
            direct_phone=clean(r, "Direct Phone", 24),
            contact_email=clean(r, "Contact Email", 200),
            linkedin_url=clean(r, "LinkedIn URL", 300),
            hours_tz=clean(r, "Hours/Time Zone", 40),
            notes=clean(r, "Growth Signals/Notes", 4000),
            distance_miles=distance_from_hq_miles(clean(r, "ZIP", 10)),
        )
        db.add(lead)
        counts["leads_created"] += 1
        if is_placeholder:
            counts["enrichment_rows"] += 1
        if lead.manufacturer_id is not None:
            counts["linked"] += 1

    # Distance backfill — geography, not CRM state, so touching existing rows
    # here doesn't violate the INSERT-IF-ABSENT contract above. Retries every
    # NULL each start (359-row roster, one dict lookup per row), so migration
    # 047's un-backfilled rows and any future centroid-dataset fix both heal
    # without a hand-run script. Covers ALL rows including customer-owned ones:
    # distance is measured from OUR HQ either way.
    for lead in (
        db.query(Lead).filter(Lead.distance_miles.is_(None), Lead.postal_code.isnot(None)).all()
    ):
        miles = distance_from_hq_miles(lead.postal_code)
        if miles is not None:
            lead.distance_miles = miles
            counts["distance_backfilled"] += 1

    db.flush()
    print(
        f"Seed: leads — {counts['leads_created']} created of {counts['leads_rows']} rows "
        f"({counts['enrichment_rows']} need enrichment, {counts['linked']} manufacturer-linked, "
        f"{counts['distance_backfilled']} distances backfilled)."
    )
    return counts
