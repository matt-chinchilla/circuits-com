"""Public derived manufacturers — GET /api/manufacturers/ (spec §1.4).

The list is DERIVED from parts.manufacturer_name and nothing else: the route
module must import nothing from the CRM models, and the response carries
names + counts only. The in-process 600s TTL cache ships with a reset seam
(cleared by an autouse conftest fixture between tests).
"""

import uuid
from pathlib import Path

from app.models import Part
from app.services import search_service
from app.services.search_service import (
    clear_public_manufacturers_cache,
    get_public_manufacturers,
)

ROUTE_SOURCE = Path(__file__).parent.parent / "app" / "routes" / "manufacturers.py"


def _add_part(db, sku, manufacturer):
    db.add(Part(id=uuid.uuid4(), sku=sku, manufacturer_name=manufacturer))
    db.commit()


class TestDerivation:
    def test_names_and_counts(self, client, seeded_db):
        data = client.get("/api/manufacturers/").json()
        assert data["total"] == 2
        assert {"name": "STMicroelectronics", "parts_count": 1} in data["manufacturers"]
        assert {"name": "Texas Instruments", "parts_count": 1} in data["manufacturers"]

    def test_excludes_empty_manufacturer(self, client, db, seeded_db):
        _add_part(db, "NONAME-1", "")
        data = client.get("/api/manufacturers/").json()
        assert data["total"] == 2
        assert "" not in [m["name"] for m in data["manufacturers"]]

    def test_ordered_by_count_desc_then_name(self, client, db, seeded_db):
        _add_part(db, "TI-SECOND", "Texas Instruments")
        names = [m["name"] for m in client.get("/api/manufacturers/").json()["manufacturers"]]
        assert names == ["Texas Instruments", "STMicroelectronics"]

    def test_no_crm_fields_in_response(self, client, seeded_db):
        data = client.get("/api/manufacturers/").json()
        assert set(data.keys()) == {"manufacturers", "total"}
        for m in data["manufacturers"]:
            assert set(m.keys()) == {"name", "parts_count"}


class TestLimit:
    def test_limit_caps_list_not_total(self, client, seeded_db):
        data = client.get("/api/manufacturers/", params={"limit": 1}).json()
        assert len(data["manufacturers"]) == 1
        assert data["total"] == 2

    def test_limit_ceiling_is_200(self, client, seeded_db):
        assert client.get("/api/manufacturers/", params={"limit": 200}).status_code == 200
        assert client.get("/api/manufacturers/", params={"limit": 201}).status_code == 422


class TestRouteModulePurity:
    def test_imports_nothing_from_crm_models(self):
        src = ROUTE_SOURCE.read_text()
        assert "from app.models" not in src, "route must not touch model classes at all"
        assert "Manufacturer" not in src.replace("manufacturers", ""), (
            "route must not reference the CRM Manufacturer model"
        )
        assert "manufacturer_aliases" not in src
        assert "merge_candidates" not in src


class TestTtlCache:
    def test_second_read_is_cached(self, db, seeded_db):
        first = get_public_manufacturers(db)
        _add_part(db, "NEW-1", "Brand New Corp")
        assert get_public_manufacturers(db) == first  # still inside the TTL

    def test_expires_after_ttl(self, db, seeded_db, monkeypatch):
        base = search_service._now()
        get_public_manufacturers(db)
        _add_part(db, "NEW-1", "Brand New Corp")
        monkeypatch.setattr(search_service, "_now", lambda: base + 601.0)
        names = [m["name"] for m in get_public_manufacturers(db)]
        assert "Brand New Corp" in names

    def test_clear_resets_immediately(self, db, seeded_db):
        get_public_manufacturers(db)
        _add_part(db, "NEW-1", "Brand New Corp")
        clear_public_manufacturers_cache()
        names = [m["name"] for m in get_public_manufacturers(db)]
        assert "Brand New Corp" in names

    def test_clear_resets_sibling_caches(self, db, seeded_db):
        """The zero-result vocab + popular-backfill pool share the reset seam
        (same autouse fixture) — a stale sibling would leak one test's catalog
        into the next suite's suggestions."""
        search_service._suggestion_vocab(db)
        search_service._popular_backfill_ids(db)
        assert search_service._vocab_cache is not None
        assert search_service._backfill_ids_cache is not None
        clear_public_manufacturers_cache()
        assert search_service._vocab_cache is None
        assert search_service._backfill_ids_cache is None
