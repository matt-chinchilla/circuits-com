"""BOM matcher — schema facts, normalization, and the match ladder."""

from sqlalchemy import event, text

from app.models import Part
from app.services import bom_match
from app.services.bom_match import (
    VALUE_AS_MPN_REASON,
    VALUE_MATCH_REASON,
    build_resolve_query,
    footprint_token,
    line_package,
    match_line,
    match_lines,
    package_warning,
)

R_0805 = "Resistor_SMD:R_0805_2012Metric_Pad1.20x1.40mm_HandSolder"
LED_0805 = "LED_SMD:LED_0805_2012Metric_Pad1.15x1.40mm_HandSolder"


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
    def test_value_plus_the_chip_size_never_the_footprint_name(self):
        # spec §5: "{value} {package_token}", e.g. `10k 0805`.
        assert build_resolve_query("10k", R_0805) == "10k 0805"
        assert build_resolve_query("100n", "Capacitor_SMD:C_0603_1608Metric") == "100n 0603"

    def test_a_footprint_with_no_chip_size_keeps_its_token(self):
        assert build_resolve_query("BSS138", "Package_TO_SOT_SMD:SOT-23") == "BSS138 SOT-23"

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

    def test_reverse_prefix_is_literal_a_catalog_underscore_is_no_wildcard(self, db):
        # `ABCXEF-99 LIKE 'ABC_EF%'` is true in SQL; as a part number it is a
        # different product.
        _part(db, "ABC_EF")
        m = match_line(db, "ABCXEF-99", None, None)
        assert (m.status, m.part) == ("resolve", None)

    def test_reverse_prefix_never_scans_the_table(self, db):
        # The old `:mpn LIKE upper(sku) || '%'` could not use an index: one
        # full scan of `parts` per MPN miss. The IN-list rides ix_parts_sku_upper.
        seen: list[str] = []

        def spy(_conn, _cursor, statement, *_args):
            seen.append(statement)

        engine = db.get_bind()
        event.listen(engine, "before_cursor_execute", spy)
        try:
            match_line(db, "GRM188R71C104KA01D", None, None)
        finally:
            event.remove(engine, "before_cursor_execute", spy)
        assert not any("upper(parts.sku) ||" in s for s in seen)

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

    def test_no_mpn_never_guesses_from_the_sku(self, db):
        # A SKU that merely LOOKS like the value is not evidence: rung 3 reads
        # descriptions and packages, never the SKU column.
        _part(db, "10K-0805")
        m = match_line(db, None, "10k", "Resistor_SMD:R_0805_2012Metric")
        assert m.status == "resolve"
        assert m.part is None
        assert m.resolve_query == "10k 0805"

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

    def test_chip_sizes_compare_by_code_not_spelling(self):
        # A KiCad footprint never spells its package the way a feed does.
        assert package_warning(line_package(R_0805), "0805 (2012 Metric)") is None
        assert package_warning(R_0805, "0805 (2012 Metric)") is None
        assert package_warning(line_package(R_0805), "0603 (1608 Metric)") == (
            "package differs: 0805 → 0603 (1608 Metric)"
        )

    def test_line_package_is_the_chip_code_else_the_footprint_token(self):
        assert line_package(R_0805) == "0805"
        assert line_package("Package_TO_SOT_SMD:SOT-23") == "SOT-23"
        assert line_package(None) is None


def _resistor_catalog(db):
    """Both feed dialects plus every near miss the rung must refuse."""
    best = _part(
        db,
        "RC0805FR-0710KL",
        package="0805 (2012 Metric)",
        description="RES 10K OHM 1% 1/8W 0805",
        total_stock=5_000_000,
    )
    mouser = _part(  # Mouser: no package column, the size lives in the text
        db,
        "CRCW080510K0FKEA",
        description="Thick Film Resistors - SMD 0805 10K Ohms 1% 0.125W",
        total_stock=90_000,
    )
    near_misses = [
        ("RC0805FR-07110KL", "0805 (2012 Metric)", "RES 110K OHM 1% 1/8W 0805"),  # 110K
        ("RC0603FR-0710KL", "0603 (1608 Metric)", "RES 10K OHM 1% 1/10W 0603"),  # 0603
        ("NCP21XH103J03RA", "0805 (2012 Metric)", "THERM NTC 10KOHM 3380K 0805"),  # thermistor
        ("EXB-28V103JX", "0805 (2012 Metric)", "RES ARRAY 4 RES 10K OHM 0805"),  # network
    ]
    for sku, package, description in near_misses:
        _part(db, sku, package=package, description=description, total_stock=9_000_000)
    return best, mouser


class TestValueRung:
    """Rung 3 — an MPN-less line matched on what the design DOES say."""

    def test_a_passive_matches_its_value_and_chip_size_in_both_dialects(self, db):
        best, mouser = _resistor_catalog(db)
        m = match_line(db, None, "10k", R_0805)
        assert (m.status, m.part.id) == ("approx", best.id)
        assert m.approx_reason == VALUE_MATCH_REASON
        assert [c.id for c in m.candidates] == [mouser.id]  # nothing else qualifies

    def test_active_outranks_obsolete_whatever_the_stock(self, db):
        best, mouser = _resistor_catalog(db)
        best.lifecycle_status = "obsolete"
        db.commit()
        m = match_line(db, None, "10k", R_0805)
        assert m.part.id == mouser.id

    def test_an_led_with_no_colour_takes_any_colour_a_named_colour_is_required(self, db):
        red = _part(
            db,
            "LS R976",
            package="0805 (2012 Metric)",
            description="LED RED DIFFUSED 0805 SMD",
            total_stock=10,
        )
        green = _part(
            db,
            "LG R971",
            package="0805 (2012 Metric)",
            description="LED GREEN DIFFUSED 0805 SMD",
            total_stock=20,
        )
        _part(db, "SFH 4056", package="0805 (2012 Metric)", description="EMITTER IR INFRARED 0805")
        assert match_line(db, None, "LED", LED_0805).part.id == green.id
        assert match_line(db, None, "LED_Red", LED_0805).part.id == red.id

    def test_a_value_that_is_a_part_number_takes_the_mpn_ladder(self, db):
        family = _part(db, "BSS138-G", total_stock=1_000)
        m = match_line(db, None, "BSS138", "Package_TO_SOT_SMD:SOT-23")
        assert (m.status, m.part.id) == ("approx", family.id)
        assert m.approx_reason == f"{VALUE_AS_MPN_REASON}; ordering-code suffix differs"

    def test_an_exact_value_part_number_is_still_approx(self, db):
        # The design never SAID it was a part number, so it is never EXACT.
        p = _part(db, "NE555")
        m = match_line(db, None, "NE555", None)
        assert (m.status, m.part.id, m.approx_reason) == ("approx", p.id, VALUE_AS_MPN_REASON)

    def test_a_part_number_the_catalog_lacks_is_never_swapped_for_a_lookalike(self, db):
        # An LED named by part number must go to the provider by that number,
        # not become "any 0805 LED".
        _part(db, "LS R976", package="0805 (2012 Metric)", description="LED RED DIFFUSED 0805 SMD")
        m = match_line(db, None, "APT2012SURCK", LED_0805)
        assert (m.status, m.part) == ("resolve", None)

    def test_nothing_in_the_catalog_falls_through_to_resolve(self, db):
        m = match_line(db, None, "4k99", R_0805)
        assert (m.status, m.part) == ("resolve", None)
        assert m.resolve_query is not None

    def test_the_whole_bom_is_one_catalog_scan(self, db):
        best, _ = _resistor_catalog(db)
        led = _part(db, "LS R976", package="0805 (2012 Metric)", description="LED RED 0805 SMD")
        scans: list[str] = []

        def spy(_conn, _cursor, statement, *_args):
            if "bom_value_pool" in statement:
                scans.append(statement)

        engine = db.get_bind()
        event.listen(engine, "before_cursor_execute", spy)
        try:
            out = match_lines(
                db, [(None, "10k", R_0805), (None, "LED", LED_0805), (None, "10K", R_0805)]
            )
        finally:
            event.remove(engine, "before_cursor_execute", spy)
        assert len(scans) == 1
        # The two lines that say the same thing share one answer.
        assert [m.part.id for m in out] == [best.id, led.id, best.id]

    def test_batches_split_without_changing_the_answer(self, db, monkeypatch):
        best, _ = _resistor_catalog(db)
        led = _part(db, "LS R976", package="0805 (2012 Metric)", description="LED RED 0805 SMD")
        monkeypatch.setattr(bom_match, "VALUE_BATCH", 1)
        out = match_lines(db, [(None, "10k", R_0805), (None, "LED", LED_0805)])
        assert [m.part.id for m in out] == [best.id, led.id]


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


class TestSimilarOptions:
    """The Matches column's picker: approx rows carry ranked comparable
    options; a perfect match carries none (owner spec 2026-08-21)."""

    def test_approx_row_lists_the_runner_ups_without_the_chosen(self, client, db):
        for suffix in ("", "WS", "WS-HG3", "WS-HG3_A-08", "TR"):
            _part(db, f"1N4148{suffix}")
        res = client.post("/api/bom/match", json={"lines": [{"index": 0, "mpn": "1N4148W"}]})
        row = res.json()["rows"][0]
        assert row["status"] == "approx"
        skus = [s["sku"] for s in row["similar"]]
        assert row["part"]["sku"] not in skus
        assert skus, "runner-ups must be offered as comparable options"
        assert all(
            s["sku"].upper().startswith("1N4148") or "1N4148W".startswith(s["sku"].upper())
            for s in row["similar"]
        )

    def test_similar_stub_shape_is_identity_only(self, client, db):
        _part(db, "GRM188R71C104KA01")
        _part(db, "GRM188R71C104KA88", package="0603")
        res = client.post("/api/bom/match", json={"lines": [{"index": 0, "mpn": "GRM188R71C"}]})
        row = res.json()["rows"][0]
        assert row["similar"], "second family member should be a comparable option"
        stub = row["similar"][0]
        assert set(stub) == {
            "id",
            "sku",
            "manufacturer_name",
            "description",
            "package",
            "lifecycle_status",
            "lifecycle_verified",
        }

    def test_exact_match_offers_no_menu(self, client, db):
        _part(db, "LM317T")
        _part(db, "LM317TG")
        res = client.post("/api/bom/match", json={"lines": [{"index": 0, "mpn": "LM317T"}]})
        row = res.json()["rows"][0]
        assert row["status"] == "exact"
        assert row["similar"] == []

    def test_similar_capped_at_eight(self, client, db):
        for i in range(12):
            _part(db, f"CAPTEST{i:02d}")
        res = client.post("/api/bom/match", json={"lines": [{"index": 0, "mpn": "CAPTEST"}]})
        row = res.json()["rows"][0]
        assert len(row["similar"]) <= 8
