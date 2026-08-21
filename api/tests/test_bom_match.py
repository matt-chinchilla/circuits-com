"""BOM matcher — schema facts, normalization, and the match ladder."""

from sqlalchemy import text

from app.models import Part


class TestPartFactColumns:
    def test_package_column_holds_a_normalized_token(self):
        col = Part.__table__.c.package
        assert col.nullable
        assert col.type.length >= 60  # SQLite ignores VARCHAR len — assert metadata

    def test_lifecycle_verified_at_is_the_truth_bit(self):
        col = Part.__table__.c.lifecycle_verified_at
        assert col.nullable  # NULL == unverified (hatched), the honest default

    def test_upper_sku_index_is_declared_on_the_model(self, db):
        # Declared in __table_args__ (not migration-only) so SQLite create_all
        # reproduces it — the uq_users_email_lower precedent.
        assert "ix_parts_sku_upper" in {ix.name for ix in Part.__table__.indexes}
        # ...and really exists in the created DB. Reflection can't see it
        # (SQLAlchemy skips expression-based indexes), so read the catalog.
        rows = db.execute(
            text("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'parts'")
        ).scalars()
        assert "ix_parts_sku_upper" in set(rows)
