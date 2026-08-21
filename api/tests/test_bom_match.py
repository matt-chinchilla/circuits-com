"""BOM matcher — schema facts, normalization, and the match ladder."""

from sqlalchemy import text

from app.models import Part
from app.services.bom_match import (
    build_resolve_query,
    footprint_token,
    match_line,
    package_warning,
)


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


def _part(db, sku, package=None, stock=0, verified=False, **kw):
    from datetime import UTC, datetime

    p = Part(
        sku=sku,
        manufacturer_name=kw.pop("manufacturer_name", "Acme"),
        package=package,
        lifecycle_verified_at=datetime.now(UTC) if verified else None,
        **kw,
    )
    db.add(p)
    db.commit()
    return p


class TestFootprintToken:
    def test_lib_footprint_takes_the_tail(self):
        assert footprint_token("Resistor_SMD:R_0805_2012Metric") == "R_0805_2012Metric"

    def test_bare_footprint_passes_through(self):
        assert footprint_token("0805") == "0805"
        assert footprint_token("  ") is None
        assert footprint_token(None) is None


class TestResolveQuery:
    def test_value_plus_footprint_token(self):
        assert build_resolve_query("10k", "Resistor_SMD:R_0805_2012Metric") == (
            "10k R_0805_2012Metric"
        )

    def test_value_alone(self):
        assert build_resolve_query("LM317T", None) == "LM317T"

    def test_no_value_no_query(self):
        assert build_resolve_query(None, "0805") is None
        assert build_resolve_query("  ", "0805") is None


class TestLadder:
    def test_exact_is_case_insensitive(self, db):
        p = _part(db, "1N4148WS-HG3_A-08")
        m = match_line(db, "1n4148ws-hg3_a-08", None, None)
        assert (m.status, m.part.id) == ("exact", p.id)

    def test_approx_forward_prefix(self, db):
        p = _part(db, "1N4148WS-HG3_A-08")
        m = match_line(db, "1N4148WS", None, None)
        assert (m.status, m.part.id) == ("approx", p.id)
        assert m.approx_reason == "ordering-code suffix differs"

    def test_approx_reverse_prefix(self, db):
        # User pasted the LONG ordering code; catalog holds the base part.
        p = _part(db, "GRM188R71C104KA01")
        m = match_line(db, "GRM188R71C104KA01D", None, None)
        assert (m.status, m.part.id) == ("approx", p.id)
        assert m.approx_reason == "base part of the pasted ordering code"

    def test_min_five_chars_gates_approx(self, db):
        _part(db, "1N4148WS")
        m = match_line(db, "1N41", None, None)
        assert m.status == "resolve"  # too short to trust a prefix family

    def test_rank_prefers_shortest_delta_then_verified_then_stock(self, db):
        far = _part(db, "LM317TTTTTTT")
        near = _part(db, "LM317TG")
        m = match_line(db, "LM317T", None, None)
        assert m.part.id == near.id
        assert far.id != near.id

    def test_no_mpn_never_guesses(self, db):
        _part(db, "10K-0805")
        m = match_line(db, None, "10k", "Resistor_SMD:R_0805_2012Metric")
        assert m.status == "resolve"
        assert m.part is None
        assert m.resolve_query == "10k R_0805_2012Metric"

    def test_nothing_at_all_is_none(self, db):
        m = match_line(db, None, None, None)
        assert (m.status, m.resolve_query) == ("none", None)

    def test_miss_with_mpn_resolves_by_mpn(self, db):
        m = match_line(db, "TOTALLY-ABSENT-99", None, None)
        assert (m.status, m.resolve_query) == ("resolve", "TOTALLY-ABSENT-99")


class TestPackageWarning:
    def test_differs_when_both_known(self):
        assert package_warning("0603", "0805") == "package differs: 0603 → 0805"

    def test_silent_when_either_unknown_or_equal(self):
        assert package_warning(None, "0805") is None
        assert package_warning("0805", None) is None
        assert package_warning("0805", "0805") is None
        assert package_warning("r_0805_2012metric", "R_0805_2012Metric") is None


class TestMatchRoute:
    def _post(self, client, lines, ip="198.51.100.7"):
        # A dedicated X-Real-IP per test keeps the per-IP limiter's module
        # state from leaking between cases (client_ip prefers that header).
        return client.post("/api/bom/match", json={"lines": lines}, headers={"X-Real-IP": ip})

    def test_identity_only_contract_and_row_shape(self, client, db):
        _part(db, "LM317T")
        res = self._post(client, [{"index": 0, "mpn": "lm317t"}], ip="198.51.100.1")
        assert res.status_code == 200
        row = res.json()["rows"][0]
        assert row["status"] == "exact"
        assert row["part"]["sku"] == "LM317T"
        assert row["part"]["lifecycle_verified"] is False
        assert "offers" in row

    def test_qty_and_refs_are_rejected_by_the_schema(self, client):
        # D7 is structural: the schema has NO qty/refs fields, and extras 422.
        res = self._post(client, [{"index": 0, "mpn": "X", "qty": 4}], ip="198.51.100.2")
        assert res.status_code == 422

    def test_line_cap_2000(self, client):
        lines = [{"index": i, "mpn": f"P{i}"} for i in range(2001)]
        assert self._post(client, lines, ip="198.51.100.3").status_code == 422

    def test_recommended_supplier_honors_the_band(self, client, db, seeded_db):
        # Smoke over seeded data: every recommended_supplier_id must appear in
        # that row's offers, and offers arrive price-ascending. (seeded_db is a
        # dict of fixture rows, so the session comes from `db`.)
        sku = db.query(Part).filter(Part.listings.any()).first().sku
        res = self._post(client, [{"index": 0, "mpn": sku}], ip="198.51.100.4")
        row = res.json()["rows"][0]
        ids = [o["supplier_id"] for o in row["offers"]]
        if row["recommended_supplier_id"] is not None:
            assert row["recommended_supplier_id"] in ids
        prices = [o["unit_price"] for o in row["offers"]]
        assert prices == sorted(prices)

    def test_rate_limited_per_ip(self, client):
        for _ in range(20):
            assert (
                self._post(client, [{"index": 0, "mpn": "X1234"}], ip="198.51.100.5").status_code
                == 200
            )
        assert (
            self._post(client, [{"index": 0, "mpn": "X1234"}], ip="198.51.100.5").status_code == 429
        )
