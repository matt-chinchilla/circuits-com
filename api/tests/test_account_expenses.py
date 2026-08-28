"""The customer's own expense book — routes/account_expenses.

``expenses`` is ONE table holding two things: Circuit Center's own operating
costs (``user_id`` NULL — the seed, the cost sync, the admin CRUD) and each
customer's private cost lines. Every assertion below would pass against an
UNSCOPED implementation if the fixture held only the caller's rows, so the
fixture is built as a Venn diagram: a second customer's row and a company row
sit in the table for every "sees only mine" claim, with figures (7777, 5000)
ugly enough that a leak is unmistakable in a failure message.

The routes are mounted on a throwaway app rather than ``app.main``, matching
tests/test_account_dashboard_charts.py. That main.py carries the router at all
is pinned separately, by tests/test_account_scope_coverage.py.

Mutation-proven 2026-08-27 (see the report for the exact edits): dropping
``expenses_owned_by`` from ``list_my_expenses`` reddens
``TestListingIsMyBookOnly``; dropping it from ``_my_expense`` reddens
``TestOtherPeoplesRowsAreUnreachableById`` — a 404 turns into a 200 that edits
or DELETES the other customer's row.
"""

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.models import Expense, User
from app.routes import account_expenses
from app.services.auth_service import create_token

AUG = date(2026, 8, 1)
JUN = date(2026, 6, 1)


@pytest.fixture
def books(db, seeded_db):
    """Two customers with their own books, plus the company's."""
    customer_a = seeded_db["company_user"]
    customer_a.activated_at = datetime.now(UTC)

    def _customer(name, **links):
        user = User(
            id=uuid.uuid4(),
            username=name,
            password_hash=customer_a.password_hash,
            role="user",
            email=f"{name}@test.example",
            email_verified_at=datetime.now(UTC),
            activated_at=datetime.now(UTC),
            **links,
        )
        db.add(user)
        return user

    customer_b = _customer("avnet_user", supplier_id=seeded_db["supplier1"].id)
    # Neither company link. A cost book is keyed on the PERSON, so a free
    # account keeps one — this is the account that would break if anybody
    # "fixed" the scoping to key on supplier_id like the revenue chart does.
    free_user = _customer("free_user")
    db.flush()

    def _expense(owner, category, vendor, amount, first, **kw):
        row = Expense(
            id=uuid.uuid4(),
            category=category,
            vendor=vendor,
            amount=Decimal(amount),
            period_start=first,
            period_end=first,
            user_id=None if owner is None else owner.id,
            **kw,
        )
        db.add(row)
        return row

    a_recent = _expense(customer_a, "travel", "Delta", "120.50", AUG)
    a_old = _expense(customer_a, "software", "Figma", "40.00", JUN)
    b_row = _expense(customer_b, "email", "Their Private Vendor", "7777.00", AUG)
    # The company's own book: NULL owner, and written by the AWS sync — the
    # exact row `reconcile_source` owns and a customer must never touch.
    company_row = _expense(
        None, "infrastructure", "AWS - Circuit Center", "5000.00", AUG, source="aws"
    )
    db.commit()

    return {
        **seeded_db,
        "customer_a": customer_a,
        "customer_b": customer_b,
        "free_user": free_user,
        "a_recent": a_recent,
        "a_old": a_old,
        "b_row": b_row,
        "company_row": company_row,
    }


@pytest.fixture
def api(db):
    app = FastAPI()
    app.include_router(account_expenses.router)
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def as_(user):
    return {"Authorization": f"Bearer {create_token(str(user.id), user.role)}"}


def get(api, user, path="/expenses"):
    resp = api.get(f"/api/account{path}", headers=as_(user))
    assert resp.status_code == 200, resp.text
    return resp.json()


def post(api, user, **body):
    return api.post("/api/account/expenses", headers=as_(user), json=body)


def created(api, user, **body):
    resp = post(api, user, **body)
    assert resp.status_code == 200, resp.text
    return resp.json()


class TestTheFixtureHasSomethingToLeak:
    """Guards every "sees only mine" assertion below from passing vacuously."""

    def test_other_books_exist_in_the_same_table(self, books, db):
        assert db.query(Expense).count() == 4
        assert db.query(Expense).filter(Expense.user_id.is_(None)).count() == 1
        assert db.query(Expense).filter(Expense.user_id == books["customer_b"].id).count() == 1


class TestListingIsMyBookOnly:
    def test_only_my_rows_newest_period_first(self, api, books):
        body = get(api, books["customer_a"])
        assert [row["vendor"] for row in body["items"]] == ["Delta", "Figma"]
        assert body["total_count"] == 2

    def test_neither_the_other_customer_nor_the_company_appears(self, api, books):
        vendors = {row["vendor"] for row in get(api, books["customer_a"])["items"]}
        assert "Their Private Vendor" not in vendors
        assert "AWS - Circuit Center" not in vendors

    def test_the_second_customer_sees_a_different_book(self, api, books):
        body = get(api, books["customer_b"])
        assert [row["vendor"] for row in body["items"]] == ["Their Private Vendor"]
        assert body["total_count"] == 1

    def test_an_unlinked_account_starts_empty_and_keeps_its_own_book(self, api, books):
        assert get(api, books["free_user"]) == {"items": [], "total_count": 0}
        created(
            api, books["free_user"], category="postage", amount="9.99", period_start="2026-08-04"
        )
        assert get(api, books["free_user"])["total_count"] == 1
        # ...and it did not land in anybody else's.
        assert get(api, books["customer_a"])["total_count"] == 2

    def test_the_row_carries_the_contract_fields_and_amount_is_a_number(self, api, books):
        row = get(api, books["customer_a"])["items"][0]
        assert set(row) == {
            "id",
            "category",
            "vendor",
            "amount",
            "description",
            "period_start",
            "period_end",
        }
        # A Decimal through Pydantic would serialize as the STRING "120.50",
        # which the console would then sort and add as text.
        assert isinstance(row["amount"], float)
        assert row["amount"] == 120.50


class TestTheRoundTrip:
    def test_create_read_update_delete(self, api, books, db):
        body = created(
            api,
            books["customer_a"],
            category="  Travel  ",
            vendor="Amtrak",
            amount="55.25",
            description="Site visit",
            period_start="2026-08-10",
            period_end="2026-08-31",
        )
        assert body["category"] == "travel"  # trimmed and lowercased
        assert body["amount"] == 55.25
        assert body["period_end"] == "2026-08-31"
        new_id = body["id"]

        assert new_id in {row["id"] for row in get(api, books["customer_a"])["items"]}

        patched = api.patch(
            f"/api/account/expenses/{new_id}",
            headers=as_(books["customer_a"]),
            json={"amount": "60.00", "category": "TRAIN"},
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["amount"] == 60.00
        assert patched.json()["category"] == "train"
        assert patched.json()["vendor"] == "Amtrak"  # untouched by an omitted field

        deleted = api.delete(f"/api/account/expenses/{new_id}", headers=as_(books["customer_a"]))
        assert deleted.status_code == 200
        assert deleted.json() == {"status": "ok"}
        assert new_id not in {row["id"] for row in get(api, books["customer_a"])["items"]}
        assert db.query(Expense).filter(Expense.id == uuid.UUID(new_id)).first() is None

    def test_a_created_row_is_mine_and_manual_on_the_db_row(self, api, books, db):
        """Asserted on the ROW, not the response: neither field is in the
        projection, and `source='manual'` is what keeps the cost sync's
        `reconcile_source` from deleting a customer's line within the hour."""
        body = created(
            api, books["customer_a"], category="ai", amount="20.00", period_start="2026-08-02"
        )
        row = db.query(Expense).filter(Expense.id == uuid.UUID(body["id"])).one()
        assert row.user_id == books["customer_a"].id
        assert row.source == "manual"

    def test_period_end_defaults_to_period_start(self, api, books):
        body = created(
            api, books["customer_a"], category="ai", amount="1.00", period_start="2026-08-02"
        )
        assert body["period_end"] == "2026-08-02"

    def test_an_explicit_null_clears_a_nullable_field(self, api, books):
        body = created(
            api,
            books["customer_a"],
            category="ai",
            vendor="Anthropic",
            amount="1.00",
            period_start="2026-08-02",
        )
        patched = api.patch(
            f"/api/account/expenses/{body['id']}",
            headers=as_(books["customer_a"]),
            json={"vendor": None},
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["vendor"] is None


class TestOtherPeoplesRowsAreUnreachableById:
    """404, never 403 — a 403 is an existence oracle for expense ids."""

    def _ids(self, books):
        return {
            "another customer's": str(books["b_row"].id),
            "the company's": str(books["company_row"].id),
        }

    def test_patch_is_404(self, api, books):
        for label, row_id in self._ids(books).items():
            resp = api.patch(
                f"/api/account/expenses/{row_id}",
                headers=as_(books["customer_a"]),
                json={"amount": "1.00"},
            )
            assert resp.status_code == 404, f"{label} row was reachable: {resp.text}"
            assert resp.json()["detail"] == "expense_not_found"

    def test_delete_is_404_and_the_row_survives(self, api, books, db):
        for label, row_id in self._ids(books).items():
            resp = api.delete(f"/api/account/expenses/{row_id}", headers=as_(books["customer_a"]))
            assert resp.status_code == 404, f"{label} row was reachable: {resp.text}"
        assert db.query(Expense).count() == 4

    def test_a_stranger_a_ghost_and_a_malformed_id_are_indistinguishable(self, api, books):
        replies = [
            api.patch(
                f"/api/account/expenses/{row_id}",
                headers=as_(books["customer_a"]),
                json={"amount": "1.00"},
            )
            for row_id in (str(books["b_row"].id), str(uuid.uuid4()), "not-a-uuid")
        ]
        assert {r.status_code for r in replies} == {404}
        assert len({r.text for r in replies}) == 1


class TestValidation:
    def _refused(self, api, books, **body):
        resp = post(api, books["customer_a"], **body)
        assert resp.status_code == 422, resp.text

    def test_amount_must_be_a_positive_two_decimal_figure(self, api, books):
        for amount in ("0", "-5.00", "12.345", "12345678901.00"):
            self._refused(api, books, category="ai", amount=amount, period_start="2026-08-02")

    def test_category_must_be_one_to_thirty_characters_after_trimming(self, api, books):
        for category in ("", "   ", "x" * 31):
            self._refused(api, books, category=category, amount="1.00", period_start="2026-08-02")

    def test_the_required_fields_are_required(self, api, books):
        self._refused(api, books, amount="1.00", period_start="2026-08-02")
        self._refused(api, books, category="ai", period_start="2026-08-02")
        self._refused(api, books, category="ai", amount="1.00")

    def test_a_period_may_not_run_backwards(self, api, books):
        self._refused(
            api,
            books,
            category="ai",
            amount="1.00",
            period_start="2026-08-10",
            period_end="2026-08-01",
        )

    def test_a_patch_may_not_invert_the_period_either(self, api, books):
        row = created(
            api,
            books["customer_a"],
            category="ai",
            amount="1.00",
            period_start="2026-08-10",
            period_end="2026-08-20",
        )
        resp = api.patch(
            f"/api/account/expenses/{row['id']}",
            headers=as_(books["customer_a"]),
            json={"period_end": "2026-08-01"},
        )
        assert resp.status_code == 422, resp.text

    def test_ownership_and_source_cannot_be_named_in_a_body(self, api, books):
        """extra='forbid' is the enforcement. A silently-dropped user_id would
        let a client believe it had written into somebody else's book."""
        base = {"category": "ai", "amount": "1.00", "period_start": "2026-08-02"}
        self._refused(api, books, **base, user_id=str(books["customer_b"].id))
        self._refused(api, books, **base, source="aws")
        self._refused(api, books, **base, id=str(uuid.uuid4()))

        row = created(api, books["customer_a"], **base)
        for field, value in (("user_id", str(books["customer_b"].id)), ("source", "aws")):
            resp = api.patch(
                f"/api/account/expenses/{row['id']}",
                headers=as_(books["customer_a"]),
                json={field: value},
            )
            assert resp.status_code == 422, resp.text

    def test_a_patch_may_not_null_a_not_null_column(self, api, books):
        row = created(
            api, books["customer_a"], category="ai", amount="1.00", period_start="2026-08-02"
        )
        for field in ("category", "amount", "period_start", "period_end"):
            resp = api.patch(
                f"/api/account/expenses/{row['id']}",
                headers=as_(books["customer_a"]),
                json={field: None},
            )
            assert resp.status_code == 422, f"{field}: {resp.text}"


class TestTheGate:
    def test_staff_and_anonymous_are_refused_on_every_verb(self, api, books):
        row_id = str(books["a_recent"].id)
        staff = as_(books["admin_user"])
        calls = (
            ("get", "/api/account/expenses", {}),
            (
                "post",
                "/api/account/expenses",
                {"json": {"category": "ai", "amount": "1.00", "period_start": "2026-08-02"}},
            ),
            ("patch", f"/api/account/expenses/{row_id}", {"json": {"amount": "1.00"}}),
            ("delete", f"/api/account/expenses/{row_id}", {}),
        )
        for method, path, kwargs in calls:
            assert getattr(api, method)(path, headers=staff, **kwargs).status_code == 403
            assert getattr(api, method)(path, **kwargs).status_code in (401, 403)

    def test_an_unactivated_customer_is_refused(self, api, books, db):
        books["customer_a"].activated_at = None
        db.commit()
        assert api.get("/api/account/expenses", headers=as_(books["customer_a"])).status_code == 403
