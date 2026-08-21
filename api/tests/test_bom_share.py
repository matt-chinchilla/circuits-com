"""BOM share links — schema now, routes in the share task."""

from datetime import UTC, datetime, timedelta

import pytest

from app.models import BomShare


class TestShareSchema:
    def test_columns(self):
        c = BomShare.__table__.c
        assert c.slug.primary_key
        assert c.slug.type.length >= 32
        assert c.user_id.nullable  # future-accounts seam — nothing writes it yet
        assert not c.payload.nullable
        assert not c.expires_at.nullable

    def test_round_trip(self, db):
        share = BomShare(
            slug="a" * 22,
            payload={"rows": [{"sku": "LM317T", "qty": 4}]},
            expires_at=datetime.now(UTC) + timedelta(days=180),
        )
        db.add(share)
        db.commit()
        got = db.query(BomShare).one()
        assert got.payload["rows"][0]["qty"] == 4


@pytest.fixture(autouse=True)
def fresh_share_buckets():
    """The /share limiter is 5/min of PROCESS state — several cases post here,
    so the window is cleared between them (the test_bom_resolve.py pattern).
    Rate limiting itself is exercised where it is the subject."""
    from app.routes import bom as bom_route

    bom_route._share_limiter.buckets.clear()
    yield
    bom_route._share_limiter.buckets.clear()


class TestShareRoutes:
    def test_create_returns_a_22_char_slug(self, client):
        res = client.post("/api/bom/share", json={"payload": {"rows": []}})
        assert res.status_code == 200
        slug = res.json()["slug"]
        assert len(slug) == 22 and "=" not in slug

    def test_round_trip_and_expiry_404(self, client, db):
        slug = client.post("/api/bom/share", json={"payload": {"n": 1}}).json()["slug"]
        assert client.get(f"/api/bom/share/{slug}").json()["payload"] == {"n": 1}
        db.query(BomShare).filter(BomShare.slug == slug).update(
            {"expires_at": datetime.now(UTC) - timedelta(days=1)}
        )
        db.commit()
        assert client.get(f"/api/bom/share/{slug}").status_code == 404

    def test_create_prunes_expired_rows(self, client, db):
        db.add(
            BomShare(slug="x" * 22, payload={}, expires_at=datetime.now(UTC) - timedelta(days=1))
        )
        db.commit()
        client.post("/api/bom/share", json={"payload": {}})
        assert db.query(BomShare).filter(BomShare.slug == "x" * 22).count() == 0

    def test_payload_cap_1mb(self, client):
        big = {"blob": "x" * (1_000_001)}
        assert client.post("/api/bom/share", json={"payload": big}).status_code == 422

    def test_rate_limited(self, client):
        for _ in range(5):
            assert client.post("/api/bom/share", json={"payload": {}}).status_code == 200
        assert client.post("/api/bom/share", json={"payload": {}}).status_code == 429
