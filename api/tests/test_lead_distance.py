"""The Leads Location column measures miles from HQ (migration 047).

Distance = straight-line HQ (79 Creighton Ave, Lake Ronkonkoma) → ZIP-centroid
miles from the committed Census gazetteer (services/lead_distance.py), stamped
by the seed and served by /api/admin/leads/ as a float with a `distance` sort
key and min_miles/max_miles filters.

Mutation-proven 2026-08-28: dropping the seed backfill loop reddens
test_backfill_drains_null_distances; dropping the route's max_miles filter
reddens test_max_miles_keeps_only_nearby_rows; removing the row's float() cast
reddens test_distance_serializes_as_a_number on Postgres paths (kept anyway —
SQLite hands floats back and would pass silently).
"""

import uuid

from app.db.seed_leads import seed_leads
from app.models import Lead
from app.services.lead_distance import (
    HQ_LAT,
    HQ_LON,
    distance_from_hq_miles,
    haversine_miles,
    normalize_zip,
)

CSV_HEADER = (
    "Company,Tier(S/M/L),Ring,Street Address,City,State,ZIP,Main Phone,Website,"
    "General Sales Email,Contact Name,Contact Title,Direct Phone,Contact Email,"
    "LinkedIn URL,Hours/Time Zone,Growth Signals/Notes\n"
)


def _lead(db, company, *, postal_code=None, distance=None, city=None, state=None):
    lead = Lead(
        id=uuid.uuid4(),
        source_key=f"test|{company}|{uuid.uuid4().hex[:8]}",
        company_name=company,
        company_slug=company.lower().replace(" ", "-"),
        postal_code=postal_code,
        distance_miles=distance,
        city=city,
        state=state,
    )
    db.add(lead)
    db.commit()
    return lead


class TestTheMath:
    def test_zero_distance_to_self(self):
        assert haversine_miles(HQ_LAT, HQ_LON, HQ_LAT, HQ_LON) == 0

    def test_hq_to_san_clemente_is_cross_country(self):
        # The feature's motivating example: San Clemente, CA. Great-circle
        # HQ→92672 is ~2,440 mi; a broken radians/miles constant lands far
        # outside this band.
        miles = distance_from_hq_miles("92672")
        assert miles is not None and 2300 < miles < 2600

    def test_hq_own_zip_is_single_digit_miles(self):
        # 11779's centroid is ~1.2 mi from the building — small but NONZERO,
        # which is the honest read of centroid resolution.
        miles = distance_from_hq_miles("11779")
        assert miles is not None and 0 < miles < 10

    def test_one_decimal_stored(self):
        miles = distance_from_hq_miles("92672")
        assert miles is not None and miles == round(miles, 1)


class TestZipNormalization:
    def test_zip_plus_four(self):
        assert normalize_zip("11779-1234") == "11779"

    def test_spreadsheet_stripped_leading_zero(self):
        # Excel's classic mangling: NJ 07001 arrives as '7001'.
        assert normalize_zip("7001") == "07001"
        assert distance_from_hq_miles("7001") is not None

    def test_garbage_is_none_not_zero(self):
        for bad in (None, "", "  ", "AB", "12"):
            assert normalize_zip(bad) is None
            assert distance_from_hq_miles(bad) is None

    def test_unknown_zip_is_none(self):
        assert distance_from_hq_miles("00000") is None


class TestSeedStampsDistance:
    def _csv(self, tmp_path, rows):
        path = tmp_path / "leads.csv"
        path.write_text(CSV_HEADER + "".join(rows), encoding="utf-8")
        return path

    def test_created_rows_carry_distance(self, db, tmp_path):
        path = self._csv(
            tmp_path,
            ["Distance Seed Co,S,1,1 Ocean Ave,San Clemente,CA,92672,,,,Pat Test,,,,,,\n"],
        )
        seed_leads(db, csv_path=path)
        lead = db.query(Lead).filter(Lead.company_name == "Distance Seed Co").one()
        assert lead.distance_miles is not None and 2300 < float(lead.distance_miles) < 2600

    def test_backfill_drains_null_distances(self, db, tmp_path):
        """Pre-047 rows (and future dataset fixes) heal on the next seed run
        without being re-inserted — geography is not CRM state."""
        stale = _lead(db, "Backfill Target", postal_code="11779", distance=None)
        path = self._csv(tmp_path, [])
        seed_leads(db, csv_path=path)
        db.commit()
        db.expire_all()
        refreshed = db.query(Lead).filter(Lead.id == stale.id).one()
        assert refreshed.distance_miles is not None
        assert 0 < float(refreshed.distance_miles) < 10

    def test_backfill_leaves_unknown_zips_null(self, db, tmp_path):
        mystery = _lead(db, "Nowhere Inc", postal_code="00000", distance=None)
        seed_leads(db, csv_path=self._csv(tmp_path, []))
        db.commit()
        db.expire_all()
        assert db.query(Lead).filter(Lead.id == mystery.id).one().distance_miles is None


class TestListEndpoint:
    """Three rows under a unique search token so the seeded roster can't
    contaminate the assertions: 5.5 mi, 120 mi, and unknown."""

    def _rows(self, db):
        _lead(db, "Distprobe Near", distance=5.5, city="Ronkonkoma", state="NY")
        _lead(db, "Distprobe Far", distance=120, city="Newark", state="NJ")
        _lead(db, "Distprobe Unknown", distance=None)

    def _fetch(self, client, auth_header, params=""):
        r = client.get(f"/api/admin/leads/?q=Distprobe{params}", headers=auth_header())
        assert r.status_code == 200
        return r.json()["leads"]

    def test_distance_serializes_as_a_number(self, client, db, seeded_db, auth_header):
        self._rows(db)
        leads = {row["company_name"]: row for row in self._fetch(client, auth_header)}
        assert leads["Distprobe Near"]["distance_miles"] == 5.5
        assert isinstance(leads["Distprobe Near"]["distance_miles"], float)
        assert leads["Distprobe Unknown"]["distance_miles"] is None

    def test_sort_nearest_first_sinks_unknowns(self, client, db, seeded_db, auth_header):
        self._rows(db)
        names = [row["company_name"] for row in self._fetch(client, auth_header, "&sort=distance")]
        assert names == ["Distprobe Near", "Distprobe Far", "Distprobe Unknown"]

    def test_sort_farthest_first_also_sinks_unknowns(self, client, db, seeded_db, auth_header):
        self._rows(db)
        names = [
            row["company_name"]
            for row in self._fetch(client, auth_header, "&sort=distance&desc=true")
        ]
        assert names == ["Distprobe Far", "Distprobe Near", "Distprobe Unknown"]

    def test_max_miles_keeps_only_nearby_rows(self, client, db, seeded_db, auth_header):
        self._rows(db)
        names = {row["company_name"] for row in self._fetch(client, auth_header, "&max_miles=50")}
        # The unknown row is EXCLUDED, not treated as nearby: "within 50 miles"
        # is a claim a placeless row cannot make.
        assert names == {"Distprobe Near"}

    def test_min_miles_is_the_beyond_bucket(self, client, db, seeded_db, auth_header):
        self._rows(db)
        names = {row["company_name"] for row in self._fetch(client, auth_header, "&min_miles=50")}
        assert names == {"Distprobe Far"}

    def test_negative_miles_is_a_422(self, client, db, seeded_db, auth_header):
        r = client.get("/api/admin/leads/?max_miles=-1", headers=auth_header())
        assert r.status_code == 422
