"""BOM share links — schema now, routes in the share task."""

from datetime import UTC, datetime, timedelta

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
