"""Tests for the per-listing routes on an EXISTING part.

# Why these exist

"Add an already-existing part to a supplier's catalog" is the second-most
common sales-desk action after creating a part: a distributor picks up a SKU
the directory already carries. Before these routes the only way to wire a
PartListing was POST /api/parts/ with `initial_listing`, which also creates a
Part — so attaching an existing SKU meant a duplicate part row.

The 409 guard is load-bearing: part_listings has no UNIQUE(part_id,
supplier_id), so a double-submit would silently create two listings for the
same distributor, double-counting total_stock and making best_price ambiguous
on the public part page.
"""

import uuid
from typing import get_args


def _auth_header(client):
    resp = client.post(
        "/api/auth/login",
        json={
            "username": "admin",
            "password": "testpass123",
        },
    )
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


class TestAddPartListing:
    def test_attach_existing_part_to_supplier(self, client, seeded_db):
        """part2 (STM32F407VGT6) starts with zero listings. Attaching
        supplier1 must return the new listing AND surface it under the part.
        """
        headers = _auth_header(client)
        part_id = str(seeded_db["part2"].id)
        supplier_id = str(seeded_db["supplier1"].id)

        resp = client.post(
            f"/api/parts/{part_id}/listings",
            json={
                "supplier_id": supplier_id,
                "stock_quantity": 4200,
                "unit_price": 8.75,
                "listing_sku": "AVN-STM32F407VGT6",
                "lead_time_days": 5,
            },
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["supplier_id"] == supplier_id
        assert body["supplier_name"] == "Avnet"
        assert body["sku"] == "AVN-STM32F407VGT6"
        assert body["stock_quantity"] == 4200
        assert body["lead_time_days"] == 5
        assert body["unit_price"] == 8.75
        assert body["currency"] == "USD"
        assert body["price_breaks"] == []

        # The part detail endpoint now carries it
        detail = client.get(f"/api/parts/{part_id}").json()
        assert len(detail["listings"]) == 1
        assert detail["listings"][0]["id"] == body["id"]
        # Aggregates roll up off the new listing
        assert detail["best_price"] == 8.75
        assert detail["total_stock"] == 4200

    def test_attach_defaults_stock_price_and_currency(self, client, seeded_db):
        """Only supplier_id is required. Stock defaults to 0 and unit_price to
        Decimal('0') — the Numeric(10, 4) column is NOT NULL, so a None price
        would be an IntegrityError rather than a free listing.
        """
        headers = _auth_header(client)
        part_id = str(seeded_db["part2"].id)
        resp = client.post(
            f"/api/parts/{part_id}/listings",
            json={"supplier_id": str(seeded_db["supplier2"].id)},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["stock_quantity"] == 0
        assert body["unit_price"] == 0.0
        assert body["currency"] == "USD"
        assert body["sku"] is None
        assert body["lead_time_days"] is None

    def test_attach_duplicate_supplier_409s(self, client, seeded_db):
        """part1 already has a listing from supplier1 (Avnet). A second one
        must be rejected — there's no DB-level UNIQUE to fall back on.
        """
        headers = _auth_header(client)
        part_id = str(seeded_db["part1"].id)
        resp = client.post(
            f"/api/parts/{part_id}/listings",
            json={"supplier_id": str(seeded_db["supplier1"].id), "unit_price": 0.41},
            headers=headers,
        )
        assert resp.status_code == 409, resp.text
        # detail is a STRING so the admin form can surface it via apiErrorDetail
        detail = resp.json()["detail"]
        assert isinstance(detail, str)
        assert "Avnet" in detail

        # And no extra listing was written
        listings = client.get(f"/api/parts/{part_id}").json()["listings"]
        assert len(listings) == 2

    def test_attach_unknown_part_404s(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.post(
            f"/api/parts/{uuid.uuid4()}/listings",
            json={"supplier_id": str(seeded_db["supplier1"].id)},
            headers=headers,
        )
        assert resp.status_code == 404

    def test_attach_unknown_supplier_404s(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.post(
            f"/api/parts/{seeded_db['part2'].id}/listings",
            json={"supplier_id": str(uuid.uuid4())},
            headers=headers,
        )
        assert resp.status_code == 404

    def test_attach_malformed_ids_404(self, client, seeded_db):
        """_to_uuid turns un-parseable ids into a 404 rather than a 500."""
        headers = _auth_header(client)
        resp = client.post(
            "/api/parts/not-a-uuid/listings",
            json={"supplier_id": str(seeded_db["supplier1"].id)},
            headers=headers,
        )
        assert resp.status_code == 404

        resp = client.post(
            f"/api/parts/{seeded_db['part2'].id}/listings",
            json={"supplier_id": "not-a-uuid"},
            headers=headers,
        )
        assert resp.status_code == 404

    def test_attach_requires_auth(self, client, seeded_db):
        resp = client.post(
            f"/api/parts/{seeded_db['part2'].id}/listings",
            json={"supplier_id": str(seeded_db["supplier1"].id)},
        )
        assert resp.status_code == 401


class TestDeletePartListing:
    def test_delete_listing_removes_it_and_its_price_breaks(self, client, db, seeded_db):
        """listing1 (Avnet on part1) has 3 price breaks. Deleting the listing
        must take the breaks with it — orphaned price_breaks rows would keep
        a NOT NULL FK pointing at a gone listing.
        """
        from app.models import PriceBreak

        headers = _auth_header(client)
        part_id = str(seeded_db["part1"].id)
        listing_id = str(seeded_db["listing1"].id)
        listing_uuid = seeded_db["listing1"].id

        assert db.query(PriceBreak).filter(PriceBreak.listing_id == listing_uuid).count() == 3

        resp = client.delete(f"/api/parts/{part_id}/listings/{listing_id}", headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"status": "ok"}

        # Listing gone from the part, sibling listing untouched
        detail = client.get(f"/api/parts/{part_id}").json()
        assert [x["supplier_name"] for x in detail["listings"]] == ["Kennedy Electronics"]

        # Price breaks gone
        assert db.query(PriceBreak).filter(PriceBreak.listing_id == listing_uuid).count() == 0

        # The PART itself survives — these controls are listing-scoped
        assert detail["sku"] == "LM7805CT"

    def test_delete_listing_twice_404s(self, client, seeded_db):
        headers = _auth_header(client)
        part_id = str(seeded_db["part1"].id)
        listing_id = str(seeded_db["listing2"].id)
        first = client.delete(f"/api/parts/{part_id}/listings/{listing_id}", headers=headers)
        assert first.status_code == 200
        second = client.delete(f"/api/parts/{part_id}/listings/{listing_id}", headers=headers)
        assert second.status_code == 404

    def test_delete_listing_under_wrong_part_404s(self, client, seeded_db):
        """The listing id is scoped by part_id, so a mismatched pair is a 404
        rather than a cross-part delete.
        """
        headers = _auth_header(client)
        resp = client.delete(
            f"/api/parts/{seeded_db['part2'].id}/listings/{seeded_db['listing1'].id}",
            headers=headers,
        )
        assert resp.status_code == 404

    def test_delete_listing_unknown_id_404s(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.delete(
            f"/api/parts/{seeded_db['part1'].id}/listings/{uuid.uuid4()}",
            headers=headers,
        )
        assert resp.status_code == 404

    def test_delete_listing_requires_auth(self, client, seeded_db):
        resp = client.delete(
            f"/api/parts/{seeded_db['part1'].id}/listings/{seeded_db['listing1'].id}"
        )
        assert resp.status_code == 401


class TestAddPartListingValidation:
    """`_ListingNumbers`' bounds mirror the part_listings column constraints.

    Without them a fat-finger or hostile payload reaches Postgres and comes
    back as an opaque 500 ('value too long for type character varying(3)',
    'numeric field overflow'), which the admin form can only render as a
    generic failure. Negative numbers are worse than a 500 — Postgres accepts
    them (no CHECK constraint) and they roll straight into the public
    best_price / total_stock aggregates.

    The bounds live on a shared base because THREE schemas write a
    part_listings row; the two sibling classes below cover the other two.
    """

    def _attach(self, client, seeded_db, **listing):
        """POST one listing onto part2, which starts with none — so `_listings`
        below reads exactly what this call wrote, and `== []` means the payload
        was rejected at the schema boundary.
        """
        return client.post(
            f"/api/parts/{seeded_db['part2'].id}/listings",
            json={"supplier_id": str(seeded_db["supplier1"].id), **listing},
            headers=_auth_header(client),
        )

    def _listings(self, client, seeded_db):
        return client.get(f"/api/parts/{seeded_db['part2'].id}").json()["listings"]

    def test_currency_longer_than_three_chars_422s(self, client, seeded_db):
        """currency is String(3) — "DOLLARS" must 422, not overflow the column."""
        resp = self._attach(client, seeded_db, currency="DOLLARS")
        assert resp.status_code == 422, resp.text
        assert self._listings(client, seeded_db) == []

    def test_unit_price_over_column_precision_422s(self, client, seeded_db):
        """Numeric(10, 4) leaves 6 integer digits — 1234567.89 needs 7."""
        resp = self._attach(client, seeded_db, unit_price=1234567.89)
        assert resp.status_code == 422, resp.text
        assert self._listings(client, seeded_db) == []

    def test_unit_price_just_under_the_ceiling_is_accepted(self, client, seeded_db):
        """The bound must not be tighter than the column: 6 integer digits fit."""
        resp = self._attach(client, seeded_db, unit_price=999999.99)
        assert resp.status_code == 200, resp.text
        assert resp.json()["unit_price"] == 999999.99

    def test_unit_price_rounding_past_the_column_scale_422s(self, client, seeded_db):
        """The boundary case a naive `lt=1_000_000` lets through.

        Numeric(10, 4) rounds to 4 decimals BEFORE checking precision, so
        999999.99999 becomes 1000000.0000 — 7 integer digits into a
        6-integer-digit column, i.e. the same 'numeric field overflow' 500 the
        bound exists to prevent. `le=999999.9999` is the real ceiling.
        """
        resp = self._attach(client, seeded_db, unit_price=999999.99999)
        assert resp.status_code == 422, resp.text
        assert self._listings(client, seeded_db) == []

    def test_unit_price_at_the_exact_ceiling_is_accepted(self, client, seeded_db):
        """...and the largest value the column CAN hold still gets through, so
        the tightened bound didn't start rejecting legitimate prices.
        """
        resp = self._attach(client, seeded_db, unit_price=999999.9999)
        assert resp.status_code == 200, resp.text
        assert resp.json()["unit_price"] == 999999.9999

    def test_negative_unit_price_422s(self, client, seeded_db):
        """A negative price would undercut every real listing in best_price."""
        resp = self._attach(client, seeded_db, unit_price=-1.5)
        assert resp.status_code == 422, resp.text
        assert self._listings(client, seeded_db) == []

    def test_negative_stock_quantity_422s(self, client, seeded_db):
        """Negative stock would subtract from the part's total_stock rollup."""
        resp = self._attach(client, seeded_db, stock_quantity=-500)
        assert resp.status_code == 422, resp.text
        assert self._listings(client, seeded_db) == []

    def test_negative_lead_time_days_422s(self, client, seeded_db):
        resp = self._attach(client, seeded_db, lead_time_days=-3)
        assert resp.status_code == 422, resp.text
        assert self._listings(client, seeded_db) == []

    def test_stock_quantity_over_int4_422s(self, client, seeded_db):
        """part_listings.stock_quantity is a Postgres int4 (max 2147483647), and
        `ge=0` alone left the ceiling open — a fat-fingered or pasted
        12345678901 reached the column as 'integer out of range', the same
        opaque 500 the unit_price bound exists to prevent.
        """
        resp = self._attach(client, seeded_db, stock_quantity=12345678901)
        assert resp.status_code == 422, resp.text
        assert self._listings(client, seeded_db) == []

    def test_stock_quantity_at_the_bound_is_accepted(self, client, seeded_db):
        """The cap must stay well clear of any real inventory count."""
        resp = self._attach(client, seeded_db, stock_quantity=2_000_000_000)
        assert resp.status_code == 200, resp.text
        assert resp.json()["stock_quantity"] == 2_000_000_000

    def test_lead_time_days_over_the_bound_422s(self, client, seeded_db):
        """Same int4 column class, same missing ceiling. 100000 days is ~274
        years, so nothing legitimate is rejected.
        """
        resp = self._attach(client, seeded_db, lead_time_days=12345678901)
        assert resp.status_code == 422, resp.text
        assert self._listings(client, seeded_db) == []

    def test_lead_time_days_at_the_bound_is_accepted(self, client, seeded_db):
        resp = self._attach(client, seeded_db, lead_time_days=100_000)
        assert resp.status_code == 200, resp.text
        assert resp.json()["lead_time_days"] == 100_000

    def test_listing_sku_longer_than_the_column_422s(self, client, seeded_db):
        """`listing_sku` is the one bound that lives per-schema rather than on
        `_ListingNumbers` (initial_listing never writes the column), which is
        exactly how it got missed: part_listings.sku is String(100), so a
        101-char distributor SKU was still reaching Postgres as 'value too long
        for type character varying(100)'.
        """
        resp = self._attach(client, seeded_db, unit_price=1.25, listing_sku="A" * 101)
        assert resp.status_code == 422, resp.text
        assert self._listings(client, seeded_db) == []

    def test_listing_sku_at_the_column_limit_is_accepted(self, client, seeded_db):
        """The bound must not be tighter than the column: 100 chars fit."""
        sku = "A" * 100
        resp = self._attach(client, seeded_db, listing_sku=sku)
        assert resp.status_code == 200, resp.text
        assert resp.json()["sku"] == sku

    def test_currency_length_contract_on_column_metadata(self):
        """Tests run on SQLite, which IGNORES String(N) length — so the
        contract the max_length=3 validator mirrors has to be asserted on the
        SQLAlchemy metadata, not by round-tripping an over-long value.
        """
        from app.models import PartListing

        assert PartListing.__table__.c.currency.type.length == 3

    def test_listing_sku_length_contract_on_column_metadata(self):
        from app.models import PartListing

        assert PartListing.__table__.c.sku.type.length == 100


class TestInitialListingValidation:
    """POST /api/parts/ builds a part_listings row too, via `initial_listing`.

    It shares `_ListingNumbers` with ListingCreate, so the same fat-finger
    payload that 422s on /{part_id}/listings must 422 here. Before the bounds
    were hoisted this door was wide open: a 7-integer-digit price or a
    negative stock count went straight into the Numeric(10, 4) column.

    Validation happens at the schema boundary, ahead of the handler, so a
    rejected payload leaves NO Part row either — worth asserting, because the
    part and its listing are created in one transaction.
    """

    def _create(self, client, seeded_db, sku, **listing):
        headers = _auth_header(client)
        return client.post(
            "/api/parts/",
            json={
                "sku": sku,
                "manufacturer_name": "Texas Instruments",
                "initial_listing": {
                    "supplier_id": str(seeded_db["supplier1"].id),
                    **listing,
                },
            },
            headers=headers,
        )

    def _part_count(self, client, sku):
        return client.get("/api/parts/", params={"search": sku}).json()["total"]

    def test_unit_price_over_column_precision_422s(self, client, seeded_db):
        resp = self._create(client, seeded_db, "IL-OVERFLOW", unit_price=1234567.89)
        assert resp.status_code == 422, resp.text
        assert self._part_count(client, "IL-OVERFLOW") == 0

    def test_unit_price_rounding_past_the_column_scale_422s(self, client, seeded_db):
        resp = self._create(client, seeded_db, "IL-ROUNDUP", unit_price=999999.99999)
        assert resp.status_code == 422, resp.text
        assert self._part_count(client, "IL-ROUNDUP") == 0

    def test_negative_unit_price_422s(self, client, seeded_db):
        resp = self._create(client, seeded_db, "IL-NEGPRICE", unit_price=-1.5)
        assert resp.status_code == 422, resp.text
        assert self._part_count(client, "IL-NEGPRICE") == 0

    def test_negative_stock_quantity_422s(self, client, seeded_db):
        resp = self._create(client, seeded_db, "IL-NEGSTOCK", stock_quantity=-500)
        assert resp.status_code == 422, resp.text
        assert self._part_count(client, "IL-NEGSTOCK") == 0

    def test_negative_lead_time_days_422s(self, client, seeded_db):
        resp = self._create(client, seeded_db, "IL-NEGLEAD", lead_time_days=-3)
        assert resp.status_code == 422, resp.text
        assert self._part_count(client, "IL-NEGLEAD") == 0

    def test_stock_quantity_over_int4_422s(self, client, seeded_db):
        """The int4 ceiling rides the shared base, so this door is closed too —
        and because validation precedes the handler, no Part row survives either.
        """
        resp = self._create(client, seeded_db, "IL-BIGSTOCK", stock_quantity=12345678901)
        assert resp.status_code == 422, resp.text
        assert self._part_count(client, "IL-BIGSTOCK") == 0

    def test_lead_time_days_over_the_bound_422s(self, client, seeded_db):
        resp = self._create(client, seeded_db, "IL-BIGLEAD", lead_time_days=12345678901)
        assert resp.status_code == 422, resp.text
        assert self._part_count(client, "IL-BIGLEAD") == 0

    def test_currency_longer_than_three_chars_422s(self, client, seeded_db):
        resp = self._create(client, seeded_db, "IL-CURRENCY", currency="DOLLARS")
        assert resp.status_code == 422, resp.text
        assert self._part_count(client, "IL-CURRENCY") == 0

    def test_in_bounds_payload_still_creates_both_rows(self, client, seeded_db):
        """The guard rails must not narrow the happy path — and the two fields
        the shared base ADDS to this schema (lead_time_days, currency) have to
        reach the row, not be silently accepted and dropped.
        """
        resp = self._create(
            client,
            seeded_db,
            "IL-OK",
            stock_quantity=250,
            unit_price=999999.9999,
            lead_time_days=14,
            currency="EUR",
        )
        assert resp.status_code == 200, resp.text

        detail = client.get(f"/api/parts/{resp.json()['id']}").json()
        assert len(detail["listings"]) == 1
        listing = detail["listings"][0]
        assert listing["stock_quantity"] == 250
        assert listing["unit_price"] == 999999.9999
        assert listing["lead_time_days"] == 14
        assert listing["currency"] == "EUR"


class TestBatchImportListingValidation:
    """POST /api/parts/batch is the third — and highest-volume — writer.

    The CSV import fans one upload out into many part_listings rows, so it is
    the likeliest source of a mistyped price. batch_import wraps EACH row in its
    own SAVEPOINT (`with db.begin_nested()`) and counts a row only once that
    savepoint releases cleanly, so a row that fails at runtime rolls back just
    itself and the partial-success response ({"created": N, "errors": [...]}) is
    honest about what persisted.

    That per-row isolation is still no substitute for bounding the schema, for
    two reasons. Pydantic validates the whole request BEFORE the handler runs, so
    an out-of-bounds cell 422s the ENTIRE upload with nothing written — the admin
    fixes the cell and re-uploads, rather than finding out afterwards that row 40
    of 200 landed in `errors`. And the DataError a savepoint would be isolating
    here ('numeric field overflow', 'integer out of range') is a Postgres error
    that never fires on the SQLite test DB at all, so without these bounds the
    bad payload would be both untested here and unrejected in prod.
    """

    def _import(self, client, seeded_db, rows):
        headers = _auth_header(client)
        return client.post(
            "/api/parts/batch",
            json={"supplier_id": str(seeded_db["supplier1"].id), "parts": rows},
            headers=headers,
        )

    def _row(self, sku="CSV-1", **extra):
        return {"sku": sku, "manufacturer_name": "Batch Corp", **extra}

    def test_unit_price_over_column_precision_422s(self, client, seeded_db):
        resp = self._import(client, seeded_db, [self._row(unit_price=1234567.89)])
        assert resp.status_code == 422, resp.text
        assert client.get("/api/parts/", params={"search": "CSV-1"}).json()["total"] == 0

    def test_unit_price_rounding_past_the_column_scale_422s(self, client, seeded_db):
        resp = self._import(client, seeded_db, [self._row(unit_price=999999.99999)])
        assert resp.status_code == 422, resp.text

    def test_negative_unit_price_422s(self, client, seeded_db):
        resp = self._import(client, seeded_db, [self._row(unit_price=-0.01)])
        assert resp.status_code == 422, resp.text

    def test_negative_stock_quantity_422s(self, client, seeded_db):
        resp = self._import(client, seeded_db, [self._row(unit_price=1.0, stock_quantity=-5)])
        assert resp.status_code == 422, resp.text

    def test_negative_lead_time_days_422s(self, client, seeded_db):
        resp = self._import(client, seeded_db, [self._row(unit_price=1.0, lead_time_days=-1)])
        assert resp.status_code == 422, resp.text

    def test_stock_quantity_over_int4_422s(self, client, seeded_db):
        """A pasted-in-the-wrong-column figure is exactly the CSV failure mode
        the int4 ceiling exists for — and here it must not half-apply the sheet.
        """
        resp = self._import(
            client, seeded_db, [self._row(unit_price=1.0, stock_quantity=12345678901)]
        )
        assert resp.status_code == 422, resp.text
        assert client.get("/api/parts/", params={"search": "CSV-1"}).json()["total"] == 0

    def test_lead_time_days_over_the_bound_422s(self, client, seeded_db):
        resp = self._import(
            client, seeded_db, [self._row(unit_price=1.0, lead_time_days=12345678901)]
        )
        assert resp.status_code == 422, resp.text

    def test_currency_longer_than_three_chars_422s(self, client, seeded_db):
        resp = self._import(client, seeded_db, [self._row(unit_price=1.0, currency="DOLLARS")])
        assert resp.status_code == 422, resp.text

    def test_listing_sku_longer_than_the_column_422s(self, client, seeded_db):
        """The CSV importer is the likeliest source of an over-long distributor
        SKU (a pasted description in the wrong column), and BatchPartItem is the
        second of the two schemas that must carry the String(100) bound.
        """
        resp = self._import(client, seeded_db, [self._row(unit_price=1.0, listing_sku="A" * 101)])
        assert resp.status_code == 422, resp.text
        assert client.get("/api/parts/", params={"search": "CSV-1"}).json()["total"] == 0

    def test_one_bad_row_rejects_the_whole_upload(self, client, seeded_db):
        """A single out-of-bounds row 422s the request, so the importer never
        half-applies a spreadsheet — the admin fixes the cell and re-uploads.
        """
        resp = self._import(
            client,
            seeded_db,
            [
                self._row("CSV-GOOD", unit_price=2.25),
                self._row("CSV-BAD", unit_price=-2.25),
            ],
        )
        assert resp.status_code == 422, resp.text
        assert client.get("/api/parts/", params={"search": "CSV-GOOD"}).json()["total"] == 0

    def test_in_bounds_rows_import_with_lead_time_and_currency(self, client, seeded_db):
        resp = self._import(
            client,
            seeded_db,
            [
                self._row(
                    "CSV-OK", unit_price=3.5, stock_quantity=40, lead_time_days=7, currency="GBP"
                )
            ],
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"created": 1, "errors": []}

        found = client.get("/api/parts/", params={"search": "CSV-OK"}).json()["items"]
        assert len(found) == 1
        listing = client.get(f"/api/parts/{found[0]['id']}").json()["listings"][0]
        assert listing["stock_quantity"] == 40
        assert listing["unit_price"] == 3.5
        assert listing["lead_time_days"] == 7
        assert listing["currency"] == "GBP"


def _schema_max_length(model, field: str) -> int | None:
    """The max_length a Pydantic v2 field declares, or None if unbounded.

    `Field(..., max_length=N)` lands in FieldInfo.metadata as an
    annotated_types.MaxLen, not as an attribute — and reading it back is the
    only way to assert the schema bound and the column WIDTH agree without
    hard-coding the number twice.
    """
    for meta in model.model_fields[field].metadata:
        if hasattr(meta, "max_length"):
            return meta.max_length
    return None


def _schema_le(model, field: str) -> float | None:
    """The inclusive upper bound a Pydantic v2 field declares, or None if it has
    none — `Field(le=N)` lands in FieldInfo.metadata as an annotated_types.Le,
    the same way max_length does.
    """
    for meta in model.model_fields[field].metadata:
        if hasattr(meta, "le"):
            return meta.le
    return None


class TestWriteSchemaBoundsMatchColumnWidths:
    """Every bounded column a write path touches needs the matching bound.

    The bounds turn 'value too long for type character varying(N)' — a 500 the
    admin form can only render as a generic failure — into a 422 pointing at the
    offending field. Asserting bound == column width (rather than bound == a
    literal) means widening one side without the other trips here, which is the
    drift that left listing_sku unbounded while its sibling currency was capped.

    The int4 columns are the same contract with a different ceiling: SQLAlchemy's
    Integer carries no width to compare against, so they are checked against
    int4's own limit instead.
    """

    def test_part_write_schemas_mirror_the_parts_columns(self):
        from app.models import Part
        from app.routes.parts import BatchPartItem, PartCreate, PartUpdate

        cols = Part.__table__.c
        # description is Text (unbounded) — deliberately uncapped.
        for field in ("sku", "manufacturer_name", "sub_slug", "datasheet_url"):
            expected = cols[field].type.length
            assert expected is not None, field
            assert _schema_max_length(PartCreate, field) == expected, field
            assert _schema_max_length(PartUpdate, field) == expected, field

        # BatchPartItem only carries the two required columns.
        for field in ("sku", "manufacturer_name"):
            assert _schema_max_length(BatchPartItem, field) == cols[field].type.length, field

    def test_listing_write_schemas_mirror_the_part_listings_columns(self):
        from app.models import PartListing
        from app.routes.parts import BatchPartItem, InitialListing, ListingCreate

        cols = PartListing.__table__.c
        for model in (ListingCreate, BatchPartItem):
            assert _schema_max_length(model, "listing_sku") == cols["sku"].type.length
            assert _schema_max_length(model, "currency") == cols["currency"].type.length

        # initial_listing never writes the row's sku, so it must NOT advertise a
        # listing_sku field it would silently drop.
        assert "listing_sku" not in InitialListing.model_fields

    def test_listing_int_columns_are_capped_inside_int4(self):
        """stock_quantity / lead_time_days are Integer — int4 on Postgres.

        `ge=0` alone left them with a floor and no ceiling, so 12345678901
        reached the column as 'integer out of range': the same opaque 500 the
        String and Numeric bounds exist to prevent. All three writers share
        `_ListingNumbers`, and this asserts none of them can drift off it.
        """
        from sqlalchemy import Integer

        from app.models import PartListing
        from app.routes.parts import BatchPartItem, InitialListing, ListingCreate

        int4_max = 2_147_483_647
        cols = PartListing.__table__.c
        for field in ("stock_quantity", "lead_time_days"):
            assert isinstance(cols[field].type, Integer), field
            for model in (ListingCreate, InitialListing, BatchPartItem):
                bound = _schema_le(model, field)
                assert bound is not None, f"{model.__name__}.{field} has no ceiling"
                assert bound <= int4_max, f"{model.__name__}.{field}"

    def test_part_sku_over_column_length_422s(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.post(
            "/api/parts/",
            json={"sku": "A" * 101, "manufacturer_name": "Texas Instruments"},
            headers=headers,
        )
        assert resp.status_code == 422, resp.text

    def test_part_manufacturer_name_over_column_length_422s(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.post(
            "/api/parts/",
            json={"sku": "PC-LONGMFR", "manufacturer_name": "M" * 201},
            headers=headers,
        )
        assert resp.status_code == 422, resp.text
        assert client.get("/api/parts/", params={"search": "PC-LONGMFR"}).json()["total"] == 0

    def test_batch_part_sku_over_column_length_422s(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.post(
            "/api/parts/batch",
            json={
                "supplier_id": str(seeded_db["supplier1"].id),
                "parts": [{"sku": "A" * 101, "manufacturer_name": "Batch Corp"}],
            },
            headers=headers,
        )
        assert resp.status_code == 422, resp.text

    def test_part_update_sku_over_column_length_422s(self, client, seeded_db):
        """PUT is the third writer of the same columns — an unbounded one still
        500s, so the bound has to be on all three schemas.
        """
        headers = _auth_header(client)
        part_id = str(seeded_db["part1"].id)
        resp = client.put(f"/api/parts/{part_id}", json={"sku": "A" * 101}, headers=headers)
        assert resp.status_code == 422, resp.text
        assert client.get(f"/api/parts/{part_id}").json()["sku"] == "LM7805CT"


def _literal_values(model, field: str) -> tuple[str, ...]:
    """The string members a Pydantic field's Literal annotation accepts.

    Flattens both shapes in play: the bare `Literal[...]` on PartCreate and the
    `Literal[...] | None` on PartUpdate, so one helper covers both writers.
    """
    values: list[str] = []
    for arg in get_args(model.model_fields[field].annotation):
        if isinstance(arg, str):
            values.append(arg)
        else:
            values.extend(v for v in get_args(arg) if isinstance(v, str))
    return tuple(values)


class TestLifecycleStatusMatchesTheColumnEnum:
    """`lifecycle_status` is the same 500-vs-422 story as the String(N) bounds,
    with a different column type.

    parts.lifecycle_status is Enum('active', 'nrnd', 'obsolete', 'unknown'). A
    free `str` on PartCreate / PartUpdate let 'Active' or 'discontinued' through
    the schema, and Postgres answered with 'invalid input value for enum
    lifecycle_status' — an opaque 500 the admin form can only render as a
    generic failure. A Literal moves the membership check to the schema
    boundary, so nothing is written.

    None of this can be caught by round-tripping a bad value in these tests:
    SQLite renders Enum as a bare VARCHAR and SQLAlchemy stopped emitting the
    CHECK constraint by default, so 'bogus' persists happily here. The parity
    test below therefore asserts against the COLUMN METADATA — same technique
    the String(N) bounds use.
    """

    def _post(self, client, sku, status):
        headers = _auth_header(client)
        return client.post(
            "/api/parts/",
            json={
                "sku": sku,
                "manufacturer_name": "Texas Instruments",
                "lifecycle_status": status,
            },
            headers=headers,
        )

    def _total(self, client, sku):
        return client.get("/api/parts/", params={"search": sku}).json()["total"]

    def test_create_with_value_outside_the_enum_422s(self, client, seeded_db):
        resp = self._post(client, "LC-BOGUS", "bogus")
        assert resp.status_code == 422, resp.text
        # Rejected at the schema boundary — no Part row either
        assert self._total(client, "LC-BOGUS") == 0

    def test_create_with_wrong_case_422s(self, client, seeded_db):
        """The enum members are lowercase and Postgres enums are
        case-sensitive, so 'Active' is just as invalid as 'bogus'. The admin
        form's <select> already emits lowercase values.
        """
        resp = self._post(client, "LC-TITLECASE", "Active")
        assert resp.status_code == 422, resp.text
        assert self._total(client, "LC-TITLECASE") == 0

    def test_create_accepts_every_member_of_the_column_enum(self, client, seeded_db):
        """The bound must not be tighter than the column: all four members --
        including 'unknown', which the admin <select> doesn't offer -- still
        round-trip.
        """
        from app.models import Part

        for status in Part.__table__.c.lifecycle_status.type.enums:
            resp = self._post(client, f"LC-OK-{status}", status)
            assert resp.status_code == 200, resp.text
            assert resp.json()["lifecycle_status"] == status

    def test_create_defaults_to_active_when_omitted(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.post(
            "/api/parts/",
            json={"sku": "LC-DEFAULT", "manufacturer_name": "Texas Instruments"},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["lifecycle_status"] == "active"

    def test_update_with_value_outside_the_enum_422s(self, client, seeded_db):
        """PUT is the second writer of the column — an unbounded one still 500s,
        so the Literal has to be on both schemas.
        """
        headers = _auth_header(client)
        part_id = str(seeded_db["part1"].id)
        resp = client.put(
            f"/api/parts/{part_id}",
            json={"lifecycle_status": "discontinued"},
            headers=headers,
        )
        assert resp.status_code == 422, resp.text
        # Nothing written — the part keeps the status it had
        assert client.get(f"/api/parts/{part_id}").json()["lifecycle_status"] == "active"

    def test_update_to_a_real_member_still_works(self, client, seeded_db):
        headers = _auth_header(client)
        part_id = str(seeded_db["part1"].id)
        resp = client.put(
            f"/api/parts/{part_id}",
            json={"lifecycle_status": "obsolete"},
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        assert client.get(f"/api/parts/{part_id}").json()["lifecycle_status"] == "obsolete"

    def test_schema_literals_mirror_the_column_enum_members(self):
        """Asserting schema-members == column-members (rather than == a literal
        list) means widening one side without the other trips here — the same
        drift guard the String(N) bounds get.
        """
        from app.models import Part
        from app.routes.parts import PartCreate, PartUpdate

        members = set(Part.__table__.c.lifecycle_status.type.enums)
        assert members, "column lost its Enum members"
        assert set(_literal_values(PartCreate, "lifecycle_status")) == members
        assert set(_literal_values(PartUpdate, "lifecycle_status")) == members


class TestBatchImportPartialFailureIsolation:
    """A failing row must roll back ONLY itself.

    /batch reports partial success — {"created": N, "errors": [...]} — and the
    CSV importer shows that N to the admin. The contract only holds if each row
    is its own SAVEPOINT. The original per-row `except: db.rollback()` rolled
    back the WHOLE open transaction: every good row already flushed was
    discarded, yet `created` had already counted them, so the upload cheerfully
    reported more parts than it wrote. That is the worst failure mode for a bulk
    tool, because nobody re-checks a success message.
    """

    def _import(self, client, seeded_db, rows):
        headers = _auth_header(client)
        return client.post(
            "/api/parts/batch",
            json={"supplier_id": str(seeded_db["supplier1"].id), "parts": rows},
            headers=headers,
        )

    @staticmethod
    def _rows():
        return [
            {"sku": "SP-ONE", "manufacturer_name": "Batch Corp", "unit_price": 1.5},
            # Schema-valid (a well-formed UUID string), but the categories FK
            # doesn't resolve, so this row blows up INSIDE the loop — after
            # SP-ONE already flushed. Precisely the row a savepoint must contain.
            {
                "sku": "SP-BADFK",
                "manufacturer_name": "Batch Corp",
                "category_id": str(uuid.uuid4()),
                "unit_price": 2.5,
            },
            {"sku": "SP-TWO", "manufacturer_name": "Batch Corp", "unit_price": 3.5},
        ]

    def _total(self, client, sku):
        return client.get("/api/parts/", params={"search": sku}).json()["total"]

    def test_good_bad_good_commits_exactly_the_two_good_rows(self, client, seeded_db):
        resp = self._import(client, seeded_db, self._rows())
        assert resp.status_code == 200, resp.text
        body = resp.json()

        # `created` counts rows that survived to the commit, not rows attempted
        assert body["created"] == 2, body
        assert [e["row"] for e in body["errors"]] == [1], body

        # ...and both good rows are really in the DB. Pre-fix, row 1's rollback
        # wiped SP-ONE while `created` still counted it (reported 2, wrote 1).
        assert self._total(client, "SP-ONE") == 1
        assert self._total(client, "SP-TWO") == 1
        assert self._total(client, "SP-BADFK") == 0

    def test_surviving_rows_keep_their_listings(self, client, seeded_db):
        """The savepoint rollback must not strand the good rows' listings
        either — part and listing are flushed together inside one row's block.
        """
        assert self._import(client, seeded_db, self._rows()).status_code == 200

        for sku, price in (("SP-ONE", 1.5), ("SP-TWO", 3.5)):
            found = client.get("/api/parts/", params={"search": sku}).json()["items"]
            assert len(found) == 1, sku
            listings = client.get(f"/api/parts/{found[0]['id']}").json()["listings"]
            assert len(listings) == 1, sku
            assert listings[0]["unit_price"] == price
            assert listings[0]["supplier_name"] == "Avnet"

    def test_trailing_bad_row_still_commits_the_earlier_good_ones(self, client, seeded_db):
        """The ordering that hid the bug: with the failure LAST, the old code
        looked fine on a manual spot-check because the rollback landed after
        nothing else needed to survive it. Keep both orderings covered.
        """
        rows = self._rows()
        resp = self._import(client, seeded_db, [rows[0], rows[2], rows[1]])
        assert resp.status_code == 200, resp.text
        assert resp.json()["created"] == 2
        assert [e["row"] for e in resp.json()["errors"]] == [2]
        assert self._total(client, "SP-ONE") == 1
        assert self._total(client, "SP-TWO") == 1

    def test_every_row_bad_creates_nothing_and_reports_all(self, client, seeded_db):
        rows = self._rows()
        resp = self._import(client, seeded_db, [rows[1], dict(rows[1], sku="SP-BADFK2")])
        assert resp.status_code == 200, resp.text
        assert resp.json()["created"] == 0
        assert [e["row"] for e in resp.json()["errors"]] == [0, 1]
        assert self._total(client, "SP-BADFK") == 0


def test_attach_then_delete_round_trip(client, seeded_db):
    """The full admin loop: attach a distributor, then remove it. The part is
    back to zero listings and its aggregates go null again.
    """
    headers = _auth_header(client)
    part_id = str(seeded_db["part2"].id)

    created = client.post(
        f"/api/parts/{part_id}/listings",
        json={
            "supplier_id": str(seeded_db["supplier1"].id),
            "stock_quantity": 90,
            "unit_price": 1.25,
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text
    listing_id = created.json()["id"]

    removed = client.delete(f"/api/parts/{part_id}/listings/{listing_id}", headers=headers)
    assert removed.status_code == 200

    detail = client.get(f"/api/parts/{part_id}").json()
    assert detail["listings"] == []
    assert detail["best_price"] is None
    assert detail["total_stock"] is None
