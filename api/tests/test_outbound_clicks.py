"""The referral-click beacon, the company/customer split, and the FK rule.

Three things are proved here, and each one was broken on purpose while the
tests were written, to check that the test — not the comment — is what holds it
up:

* ``POST /api/outbound`` stores a click only for a (part, supplier) pair that
  really exists, and answers **204 to everything** either way.
* A customer's private expense and lead rows never appear in the company's
  books or CRM, and they go when the account goes.
* None of migration 045's new columns carries a FOREIGN KEY. That is the whole
  reason the reseed does not destroy them — see ``TestTheReseedSafetyRule``.
"""

import json
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

import app.models  # noqa: F401  — registers every table on Base.metadata
from app.db.session import Base
from app.models import Expense, Lead, OutboundClick, User
from app.services.auth_service import hash_password

OUTBOUND = "/api/outbound"


def _beacon(client, part_id, supplier_id):
    return client.post(OUTBOUND, json={"part_id": str(part_id), "supplier_id": str(supplier_id)})


def _clicks(db):
    db.expire_all()
    return db.query(OutboundClick).all()


# ── The beacon ──────────────────────────────────────────────────────────────


class TestTheBeaconStoresARealClick:
    def test_a_pair_the_catalog_confirms_is_stored(self, client, db, seeded_db):
        part = seeded_db["part1"]
        supplier = seeded_db["supplier1"]  # holds listing1 on part1

        assert _beacon(client, part.id, supplier.id).status_code == 204

        rows = _clicks(db)
        assert len(rows) == 1
        assert rows[0].part_id == part.id
        assert rows[0].supplier_id == supplier.id
        assert rows[0].clicked_at is not None

    def test_each_click_is_its_own_row(self, client, db, seeded_db):
        """A count, not a set: two visits to the same distributor are two
        referrals, and the panel that renders this is a click COUNT."""
        part, supplier = seeded_db["part1"], seeded_db["supplier1"]
        for _ in range(3):
            _beacon(client, part.id, supplier.id)
        assert len(_clicks(db)) == 3

    def test_it_needs_no_credentials(self, client, db, seeded_db):
        """Public by design — the click happens on a public page for an
        anonymous visitor. No Authorization header anywhere in this file."""
        assert _beacon(client, seeded_db["part1"].id, seeded_db["supplier1"].id).status_code == 204
        assert len(_clicks(db)) == 1


class TestJunkIsNotStorable:
    """Every case here must answer 204 AND write nothing. The status is the
    point as much as the emptiness: a beacon that answered differently for a
    real pair than an invented one would be an unauthenticated oracle over the
    catalog, and `sendBeacon` discards the response anyway."""

    def test_a_supplier_that_does_not_list_the_part_is_refused(self, client, db, seeded_db):
        """The load-bearing case. Both ids name REAL rows; the pair does not
        exist — supplier1 has no listing on part2. Without the EXISTS check a
        stranger could write any supplier uuid into that supplier's own
        console numbers."""
        assert _beacon(client, seeded_db["part2"].id, seeded_db["supplier1"].id).status_code == 204
        assert _clicks(db) == []

    def test_well_formed_uuids_naming_nothing_are_refused(self, client, db, seeded_db):
        assert _beacon(client, uuid.uuid4(), uuid.uuid4()).status_code == 204
        assert _clicks(db) == []

    def test_a_real_part_with_an_unknown_supplier_is_refused(self, client, db, seeded_db):
        assert _beacon(client, seeded_db["part1"].id, uuid.uuid4()).status_code == 204
        assert _clicks(db) == []

    def test_the_pair_is_directional(self, client, db, seeded_db):
        """part and supplier ids swapped — both real, neither in the right
        column."""
        part, supplier = seeded_db["part1"], seeded_db["supplier1"]
        assert _beacon(client, supplier.id, part.id).status_code == 204
        assert _clicks(db) == []

    def test_ids_that_are_not_uuids_are_refused(self, client, db, seeded_db):
        for body in (
            {"part_id": "not-a-uuid", "supplier_id": "also-not"},
            {"part_id": str(seeded_db["part1"].id), "supplier_id": "'; DROP TABLE parts;--"},
            {"part_id": 17, "supplier_id": 42},
            {"part_id": None, "supplier_id": None},
            {"part_id": [str(seeded_db["part1"].id)], "supplier_id": {}},
        ):
            assert client.post(OUTBOUND, json=body).status_code == 204, body
        assert _clicks(db) == []

    def test_a_missing_field_is_refused(self, client, db, seeded_db):
        assert client.post(OUTBOUND, json={}).status_code == 204
        assert (
            client.post(OUTBOUND, json={"supplier_id": str(seeded_db["supplier1"].id)}).status_code
            == 204
        )
        assert (
            client.post(OUTBOUND, json={"part_id": str(seeded_db["part1"].id)}).status_code == 204
        )
        assert _clicks(db) == []

    def test_a_malformed_body_is_204_and_not_422(self, client, db, seeded_db):
        """This is why the handler reads RAW bytes instead of declaring a
        Pydantic model: FastAPI rejects unparseable JSON with a 422 BEFORE any
        handler runs, so "always 204" cannot be kept from inside a model."""
        headers = {"content-type": "application/json"}
        for payload in (b"", b"not json at all", b"{", b'{"part_id":', b"\x00\xff"):
            resp = client.post(OUTBOUND, content=payload, headers=headers)
            assert resp.status_code == 204, (payload, resp.status_code, resp.text)
        assert _clicks(db) == []

    def test_a_json_body_that_is_not_an_object_is_204(self, client, db, seeded_db):
        for payload in ("[]", '"string"', "12", "null", "true"):
            assert client.post(OUTBOUND, content=payload,
                               headers={"content-type": "application/json"}).status_code == 204
        assert _clicks(db) == []

    def test_an_oversized_body_is_dropped_unparsed(self, client, db, seeded_db):
        """The cap bounds what an unauthenticated caller can make us parse. A
        legitimate beacon is ~100 bytes; this one carries a valid pair and is
        still refused, which is what proves the cap runs before the parse."""
        body = {
            "part_id": str(seeded_db["part1"].id),
            "supplier_id": str(seeded_db["supplier1"].id),
            "padding": "x" * 4096,
        }
        assert client.post(OUTBOUND, json=body).status_code == 204
        assert _clicks(db) == []


class TestTheBeaconIsThrottledOnItsOwnBucket:
    def test_beyond_the_window_allowance_it_stays_204_and_stops_storing(
        self, client, db, seeded_db
    ):
        part, supplier = seeded_db["part1"], seeded_db["supplier1"]
        from app.routes.analytics import _RATE_MAX

        for _ in range(_RATE_MAX):
            assert _beacon(client, part.id, supplier.id).status_code == 204
        assert len(_clicks(db)) == _RATE_MAX

        assert _beacon(client, part.id, supplier.id).status_code == 204
        assert len(_clicks(db)) == _RATE_MAX, "a throttled beacon must not store"

    def test_it_does_not_share_track_s_allowance(self, client, db, seeded_db):
        """Separate namespaces, deliberately (rate_limit.py's own rule). One
        part-page visit fires BOTH a page view and, on a click-through, a
        beacon — a shared bucket would make each starve the other."""
        from app.models import PageView
        from app.routes.analytics import _RATE_MAX

        part, supplier = seeded_db["part1"], seeded_db["supplier1"]
        for _ in range(_RATE_MAX + 5):
            _beacon(client, part.id, supplier.id)

        resp = client.post(
            "/api/track",
            json={"path": "/part/lm7805ct", "referrer": None, "session_id": "s-1"},
        )
        assert resp.status_code == 204
        db.expire_all()
        assert db.query(PageView).count() == 1


# ── The company/customer split ──────────────────────────────────────────────


def _company_expense(db, vendor="Amazon Web Services"):
    row = Expense(
        id=uuid.uuid4(), category="infrastructure", vendor=vendor,
        amount=Decimal("21.23"), period_start=date(2026, 7, 1),
        period_end=date(2026, 7, 31),
    )
    db.add(row)
    db.flush()
    return row


def _customer_expense(db, user, vendor="Their Own Hosting"):
    row = Expense(
        id=uuid.uuid4(), category="infrastructure", vendor=vendor,
        amount=Decimal("99.00"), period_start=date(2026, 7, 1),
        period_end=date(2026, 7, 31), source="manual", user_id=user.id,
    )
    db.add(row)
    db.flush()
    return row


def _lead(db, company, user=None):
    row = Lead(
        id=uuid.uuid4(), source_key=f"{company}|", company_name=company,
        company_slug=company.lower().replace(" ", "-"),
        user_id=user.id if user is not None else None,
    )
    db.add(row)
    db.flush()
    return row


def _customer(db, email="c@test.example"):
    u = User(
        id=uuid.uuid4(), username=email, email=email,
        password_hash=hash_password("testpass123"), role="user",
        first_name="James", last_name="Chirichella",
        email_verified_at=datetime.now(UTC), activated_at=datetime.now(UTC),
    )
    db.add(u)
    db.flush()
    return u


def _owner(db, email="owner@test.example"):
    u = User(
        id=uuid.uuid4(), username=email, email=email,
        password_hash=hash_password("testpass123"), role="owner",
    )
    db.add(u)
    db.flush()
    return u


class TestTheCompanyBooksAreTheCompanyRows:
    def test_a_customer_expense_never_appears_in_the_staff_list(
        self, client, db, seeded_db, auth_header
    ):
        mine = _company_expense(db)
        theirs = _customer_expense(db, _customer(db))
        db.commit()

        listed = client.get("/api/admin/expenses/", headers=auth_header()).json()
        ids = {row["id"] for row in listed}
        assert str(mine.id) in ids
        assert str(theirs.id) not in ids, "a customer's cost line is not our spend"

    def test_a_customer_expense_is_404_by_id_rather_than_editable(
        self, client, db, seeded_db, auth_header
    ):
        theirs = _customer_expense(db, _customer(db))
        db.commit()
        headers = auth_header()
        assert client.patch(f"/api/admin/expenses/{theirs.id}", json={"vendor": "x"},
                            headers=headers).status_code == 404
        assert client.delete(f"/api/admin/expenses/{theirs.id}",
                             headers=headers).status_code == 404
        db.expire_all()
        assert db.query(Expense).filter(Expense.id == theirs.id).one().vendor == "Their Own Hosting"

    def test_staff_created_rows_are_still_company_rows(self, client, db, seeded_db, auth_header):
        """The split must not quietly hide the admin's own new row: a POST
        writes no user_id, so it comes straight back out of the list."""
        headers = auth_header()
        created = client.post(
            "/api/admin/expenses/",
            json={"category": "domain", "vendor": "Hover", "amount": "15.00",
                  "period_start": "2026-07-01", "period_end": "2026-07-31"},
            headers=headers,
        )
        assert created.status_code == 200
        listed = client.get("/api/admin/expenses/", headers=headers).json()
        assert [row["id"] for row in listed] == [created.json()["id"]]


class TestTheCompanyCrmIsTheCompanyRows:
    def test_a_customer_lead_never_appears_in_the_staff_roster(
        self, client, db, seeded_db, auth_header
    ):
        mine = _lead(db, "Our Prospect")
        theirs = _lead(db, "Their Prospect", user=_customer(db))
        db.commit()

        body = client.get("/api/admin/leads/", headers=auth_header()).json()
        names = {row["company_name"] for row in body["leads"]}
        assert "Our Prospect" in names
        assert "Their Prospect" not in names
        assert body["total"] == 1, "the count must exclude them too, not just the page"
        assert mine.id != theirs.id

    def test_a_customer_lead_is_404_by_id(self, client, db, seeded_db, auth_header):
        theirs = _lead(db, "Their Prospect", user=_customer(db))
        db.commit()
        headers = auth_header()
        assert client.get(f"/api/admin/leads/{theirs.id}", headers=headers).status_code == 404
        assert client.patch(f"/api/admin/leads/{theirs.id}", json={"notes": "x"},
                            headers=headers).status_code == 404
        assert client.post(f"/api/admin/leads/{theirs.id}/contacts",
                           json={"outcome": "converted"}, headers=headers).status_code == 404


class TestDeletingTheAccountTakesWhatTheyOwned:
    """No foreign key means no cascade, so the delete handler has to do it.
    Skip that and the rows outlive the account: invisible to staff, unreachable
    by their owner, orphaned forever."""

    def test_their_expenses_and_leads_go_with_them(self, client, db, seeded_db, auth_header):
        victim = _customer(db)
        _owner(db)
        # Ids captured now: after the delete these instances are gone, and
        # reading an attribute off an expired-then-deleted row raises.
        victim_id = victim.id
        expense_id = _customer_expense(db, victim).id
        lead_id = _lead(db, "Their Prospect", user=victim).id
        db.commit()

        resp = client.delete(f"/api/admin/users/{victim_id}",
                             headers=auth_header(email="owner@test.example"))
        assert resp.status_code == 200
        db.expire_all()
        assert db.query(User).filter(User.id == victim_id).count() == 0
        assert db.query(Expense).filter(Expense.id == expense_id).count() == 0
        assert db.query(Lead).filter(Lead.id == lead_id).count() == 0

    def test_it_takes_only_theirs(self, client, db, seeded_db, auth_header):
        victim = _customer(db)
        bystander = _customer(db, email="other@test.example")
        _owner(db)
        victim_id = victim.id
        survivors = (
            (_company_expense(db).id, Expense),
            (_customer_expense(db, bystander, vendor="Someone Else").id, Expense),
            (_lead(db, "Our Prospect").id, Lead),
            (_lead(db, "Someone Else's Prospect", user=bystander).id, Lead),
        )
        _customer_expense(db, victim)
        _lead(db, "Their Prospect", user=victim)
        db.commit()

        assert client.delete(f"/api/admin/users/{victim_id}",
                             headers=auth_header(email="owner@test.example")).status_code == 200
        db.expire_all()
        assert db.query(Expense).count() == 2
        assert db.query(Lead).count() == 2
        for row_id, model in survivors:
            assert db.query(model).filter(model.id == row_id).count() == 1, row_id


# ── The rule the whole schema hangs on ──────────────────────────────────────


class TestTheReseedSafetyRule:
    """`deploy.sh --reseed` runs TRUNCATE ... CASCADE from `suppliers`, which is
    TABLE-level and TRANSITIVE and ignores ON DELETE entirely. `users` is
    already inside that graph (users.supplier_id -> suppliers). So a foreign key
    on ANY of migration 045's new columns would silently enrol outbound_clicks,
    expenses and leads in the cascade, and a routine reseed would destroy the
    click history, the whole cost book and the whole CRM without one error.

    tests/test_leads_schema.py's census catches it from the other direction.
    This is the local statement of the same rule, next to the columns it
    governs — mutation-checked by adding each FK back and watching it fail.
    """

    NEW_COLUMNS = (
        ("outbound_clicks", "supplier_id"),
        ("outbound_clicks", "part_id"),
        ("expenses", "user_id"),
        ("leads", "user_id"),
    )

    def test_none_of_the_new_columns_carries_a_foreign_key(self):
        for table, column in self.NEW_COLUMNS:
            col = Base.metadata.tables[table].c[column]
            assert not col.foreign_keys, (
                f"{table}.{column} has a FOREIGN KEY. It joins deploy.sh --reseed's "
                "TRUNCATE CASCADE graph and a reseed will delete every row in "
                f"{table}. Validity belongs at the write site."
            )

    def test_the_clicks_table_references_nothing_at_all(self):
        assert not Base.metadata.tables["outbound_clicks"].foreign_keys

    def test_the_columns_exist_with_the_shapes_the_contract_names(self):
        clicks = Base.metadata.tables["outbound_clicks"]
        assert clicks.c.supplier_id.nullable is False
        assert clicks.c.part_id.nullable is True
        assert clicks.c.clicked_at.nullable is False
        assert Base.metadata.tables["expenses"].c.user_id.nullable is True
        assert Base.metadata.tables["leads"].c.user_id.nullable is True
        kpi = Base.metadata.tables["users"].c.dashboard_kpi
        assert kpi.nullable is True and not kpi.foreign_keys
        assert kpi.type.length == 40

    def test_the_supplier_window_index_exists(self):
        """The one query this table exists to answer is "this supplier's clicks
        over this window", so the index has to LEAD with supplier_id."""
        clicks = Base.metadata.tables["outbound_clicks"]
        leading = [
            [c.name for c in ix.columns][:2]
            for ix in clicks.indexes
            if [c.name for c in ix.columns][:1] == ["supplier_id"]
        ]
        assert ["supplier_id", "clicked_at"] in leading, sorted(
            [c.name for c in ix.columns] for ix in clicks.indexes
        )

    def test_a_stored_click_survives_its_supplier_being_deleted(self, db, seeded_db):
        """The behavioural half of the same rule: no FK means no cascade and no
        constraint error. History is kept, unlinked — the same call
        `activity_events.supplier_id` makes."""
        from app.models import PartListing, PriceBreak, Revenue, Sponsor
        from app.models.supplier import CategorySupplier

        supplier = seeded_db["supplier1"]
        db.add(OutboundClick(id=uuid.uuid4(), part_id=seeded_db["part1"].id,
                             supplier_id=supplier.id))
        db.commit()

        listing_ids = [
            row[0] for row in db.query(PartListing.id)
            .filter(PartListing.supplier_id == supplier.id).all()
        ]
        db.query(PriceBreak).filter(PriceBreak.listing_id.in_(listing_ids)).delete(
            synchronize_session=False
        )
        db.query(PartListing).filter(PartListing.supplier_id == supplier.id).delete(
            synchronize_session=False
        )
        db.query(Sponsor).filter(Sponsor.supplier_id == supplier.id).delete(
            synchronize_session=False
        )
        db.query(CategorySupplier).filter(CategorySupplier.supplier_id == supplier.id).delete(
            synchronize_session=False
        )
        db.query(Revenue).filter(Revenue.supplier_id == supplier.id).delete(
            synchronize_session=False
        )
        db.expire(supplier)
        db.delete(supplier)
        db.commit()

        rows = _clicks(db)
        assert len(rows) == 1
        assert rows[0].supplier_id is not None


class TestTheBeaconContractTheFrontendCallsWith:
    def test_the_body_the_part_page_sends_is_the_body_the_route_reads(
        self, client, db, seeded_db
    ):
        """`navigator.sendBeacon` ships a Blob of exactly this JSON with
        content-type application/json. Sent as raw bytes here, the way the
        browser sends it, rather than through the test client's json= helper."""
        payload = json.dumps(
            {
                "part_id": str(seeded_db["part1"].id),
                "supplier_id": str(seeded_db["supplier1"].id),
            }
        ).encode()
        resp = client.post(OUTBOUND, content=payload,
                           headers={"content-type": "application/json"})
        assert resp.status_code == 204
        assert len(_clicks(db)) == 1

    def test_the_content_type_is_not_load_bearing(self, client, db, seeded_db):
        """Reading raw bytes buys this for free, and it matters: a `sendBeacon`
        of a plain string ships text/plain, and privacy extensions rewrite the
        header. The pair is what the route trusts, never the envelope."""
        payload = json.dumps(
            {
                "part_id": str(seeded_db["part1"].id),
                "supplier_id": str(seeded_db["supplier1"].id),
            }
        ).encode()
        resp = client.post(OUTBOUND, content=payload,
                           headers={"content-type": "text/plain;charset=UTF-8"})
        assert resp.status_code == 204
        assert len(_clicks(db)) == 1
