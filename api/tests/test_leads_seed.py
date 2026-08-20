"""seed_leads — call-list ingestion (synthesis §5.3 steps 7-8).

Contract: source_key idempotency; ENRICHMENT NEEDED -> contact_name NULL +
needs_enrichment; branch extraction; company_slug groups branches; ring kept
as STRING incl 'UNVERIFIED'; opportunistic manufacturer link via company_slug.
"""

import csv

from app.db.seed_leads import seed_leads
from app.db.seed_manufacturers import seed_manufacturers
from app.models import Lead

HEADERS = ["Company", "Tier(S/M/L)", "Ring", "Street Address", "City", "State", "ZIP",
           "Main Phone", "Website", "General Sales Email", "Contact Name", "Contact Title",
           "Direct Phone", "Contact Email", "LinkedIn URL", "Hours/Time Zone",
           "Growth Signals/Notes"]

ROWS = [
    # two people, one company
    {"Company": "FDH Electronics", "Tier(S/M/L)": "M", "Ring": "1", "City": "Ronkonkoma",
     "State": "NY", "Contact Name": "Ian Locke", "Contact Title": "SVP Sales",
     "Main Phone": "631-555-0142", "Hours/Time Zone": "ET"},
    {"Company": "FDH Electronics", "Tier(S/M/L)": "M", "Ring": "1",
     "Contact Name": "Nathan Little", "Contact Title": "VP of Sales"},
    # branch row
    {"Company": "Bisco Industries (Bohemia)", "Tier(S/M/L)": "S", "Ring": "2",
     "Contact Name": "Pat Doe"},
    # enrichment placeholder
    {"Company": "Acme Interconnect", "Tier(S/M/L)": "L", "Ring": "UNVERIFIED",
     "Contact Name": "ENRICHMENT NEEDED"},
    # matches a manufacturer by company_slug
    {"Company": "Lumissil", "Tier(S/M/L)": "S", "Ring": "3", "Contact Name": "Kim Ray"},
]


def _write(tmp_path, rows):
    p = tmp_path / "leads.csv"
    with open(p, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=HEADERS)
        w.writeheader()
        for r in rows:
            w.writerow({h: r.get(h, "") for h in HEADERS})
    return p


def _mfr_fixture(tmp_path):
    p = tmp_path / "manufacturers.csv"
    with open(p, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["Company", "URL", "Logo", "Number of parts"])
        w.writeheader()
        w.writerow({"Company": "Lumissil", "URL": "https://lumissil.com", "Logo": "", "Number of parts": "1"})
    return p


def test_ingestion(db, seeded_db, tmp_path):
    seed_manufacturers(db, csv_path=_mfr_fixture(tmp_path))
    counts = seed_leads(db, csv_path=_write(tmp_path, ROWS))
    assert counts["leads_created"] == 5

    fdh = db.query(Lead).filter(Lead.company_name == "FDH Electronics").all()
    assert {l.contact_name for l in fdh} == {"Ian Locke", "Nathan Little"}
    assert all(l.company_slug == fdh[0].company_slug for l in fdh)

    bisco = db.query(Lead).filter(Lead.contact_name == "Pat Doe").one()
    assert bisco.company_name == "Bisco Industries (Bohemia)"
    assert bisco.branch_label == "Bohemia"
    assert "bohemia" not in bisco.company_slug  # paren-stripped grouping

    acme = db.query(Lead).filter(Lead.company_name == "Acme Interconnect").one()
    assert acme.contact_name is None
    assert acme.needs_enrichment is True
    assert acme.ring == "UNVERIFIED"
    assert acme.tier == "L"

    kim = db.query(Lead).filter(Lead.contact_name == "Kim Ray").one()
    assert kim.manufacturer_id is not None  # linked via company_slug == canonical_key


def test_idempotent(db, seeded_db, tmp_path):
    path = _write(tmp_path, ROWS)
    seed_leads(db, csv_path=path)
    n = db.query(Lead).count()
    counts2 = seed_leads(db, csv_path=path)
    assert db.query(Lead).count() == n
    assert counts2["leads_created"] == 0


def test_reseed_does_not_reset_outcomes(db, seeded_db, tmp_path):
    """The CSV restores ROWS, never overwrites CRM state (denorm columns)."""
    path = _write(tmp_path, ROWS)
    seed_leads(db, csv_path=path)
    kim = db.query(Lead).filter(Lead.contact_name == "Kim Ray").one()
    kim.last_outcome = "converted"
    kim.contact_attempts = 3
    db.commit()
    seed_leads(db, csv_path=path)
    kim = db.query(Lead).filter(Lead.contact_name == "Kim Ray").one()
    assert kim.last_outcome == "converted"
    assert kim.contact_attempts == 3


def test_missing_csv_quiet(db, seeded_db, tmp_path):
    assert seed_leads(db, csv_path=tmp_path / "absent.csv") == {}
