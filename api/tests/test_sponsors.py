"""Regression tests for GET /api/sponsors/keyword/{keyword}.

Backs the frontend `AvailabilityCheck` component on the new /keyword landing
page (Wave 2): a 200 means the keyword is CLAIMED (sponsor exists), and a
404 means the keyword is AVAILABLE (no sponsor owns it). Both branches are
load-bearing for the UX.

Pre-Wave-2 the endpoint existed but had zero pytest coverage. A refactor
of `routes/sponsors.py` could silently flip the 200/404 contract and break
the landing page's keyword check without any test catching it.
"""

import uuid

from app.models import Sponsor, Supplier


def _make_supplier(
    db, name: str = "Test Co", website: str | None = None, phone: str | None = None
) -> Supplier:
    supplier = Supplier(
        id=uuid.uuid4(),
        name=name,
        website=website,
        phone=phone,
    )
    db.add(supplier)
    db.flush()
    return supplier


def _make_keyword_sponsor(db, supplier: Supplier, keyword: str, tier: str = "gold") -> Sponsor:
    sponsor = Sponsor(
        id=uuid.uuid4(),
        supplier_id=supplier.id,
        keyword=keyword,
        description=f"Sponsor card body for {keyword}",
        image_url=f"/logos/{keyword}.svg",
        tier=tier,
    )
    db.add(sponsor)
    db.flush()
    return sponsor


class TestGetSponsorByKeyword:
    def test_returns_200_with_sponsor_for_claimed_keyword(self, db, client):
        supplier = _make_supplier(db, "Raspberry Pi")
        _make_keyword_sponsor(db, supplier, "rp2040", tier="platinum")
        db.commit()

        resp = client.get("/api/sponsors/keyword/rp2040")
        assert resp.status_code == 200
        body = resp.json()
        assert body["supplier_name"] == "Raspberry Pi"
        assert body["tier"] == "platinum"
        assert "rp2040" in body["description"]

    def test_returns_404_for_available_keyword(self, client):
        # No sponsor created — the keyword is "available". The `client` fixture
        # transitively sets up `db`, so no `db` parameter is needed here.
        resp = client.get("/api/sponsors/keyword/never-claimed-keyword")
        assert resp.status_code == 404

    def test_returns_404_distinct_from_2xx_so_frontend_can_branch(self, db, client):
        # The frontend AvailabilityCheck distinguishes 200 (taken) from 404
        # (available). Anything else is treated as "error". This test pins
        # the contract that a missing keyword returns 404 specifically — NOT
        # 200 with a null body, NOT 422, NOT 500.
        supplier = _make_supplier(db, "Texas Instruments")
        _make_keyword_sponsor(db, supplier, "low-noise-op-amps")
        db.commit()

        claimed = client.get("/api/sponsors/keyword/low-noise-op-amps")
        available = client.get("/api/sponsors/keyword/spi-flash")

        assert claimed.status_code == 200
        assert available.status_code == 404

    def test_keyword_lookup_is_exact_match_not_substring(self, db, client):
        # Sponsoring "rp2040" must NOT also serve "rp2040-foo" or "rp" requests.
        # Substring matching would cause adjacent-keyword pollution where
        # close variants conflict in the admin sponsor table.
        supplier = _make_supplier(db, "Raspberry Pi")
        _make_keyword_sponsor(db, supplier, "rp2040")
        db.commit()

        assert client.get("/api/sponsors/keyword/rp2040").status_code == 200
        assert client.get("/api/sponsors/keyword/rp2040-foo").status_code == 404
        assert client.get("/api/sponsors/keyword/rp").status_code == 404

    def test_response_shape_matches_frontend_Sponsor_type(self, db, client):
        # The frontend `Sponsor` TS type expects: supplier_name, image_url,
        # description, tier, website, phone. AvailabilityCheck reads
        # supplier_name and description in its "taken" card; a refactor
        # that drops either field would silently break the rendered card.
        supplier = _make_supplier(
            db,
            "STMicroelectronics",
            website="https://www.st.com",
            phone="+33-1-58-07-77-77",
        )
        _make_keyword_sponsor(db, supplier, "stm32")
        db.commit()

        resp = client.get("/api/sponsors/keyword/stm32")
        body = resp.json()
        for field in ("supplier_name", "image_url", "description", "tier", "website", "phone"):
            assert field in body, f"missing {field} from sponsor response shape"
        assert body["supplier_name"] == "STMicroelectronics"
        assert body["website"] == "https://www.st.com"
