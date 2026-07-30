"""Expense model bounds + /api/admin/expenses CRUD + the AWS cost estimator.

SQLite ignores VARCHAR lengths, so column-width contracts are asserted against
the SQLAlchemy metadata (`__table__.c.<col>.type.length`) rather than by trying
to insert an over-long value — same pattern as test_user_email_column.py.
"""

import uuid
from datetime import date
from decimal import Decimal

from app.models import Expense
from app.models.expense import (
    EXPENSE_CATEGORIES,
    EXPENSE_CATEGORY_LABELS,
    expense_category_label,
)
from app.schemas.expense import ExpenseCategory
from app.services.aws_cost import (
    estimate_monthly_aws_cost,
    estimate_monthly_aws_cost_breakdown,
)


def _auth_header(client):
    resp = client.post("/api/auth/login", json={"username": "admin", "password": "testpass123"})
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def _payload(**overrides):
    body = {
        "category": "infrastructure",
        "vendor": "Amazon Web Services",
        "amount": "21.23",
        "description": "Estimated monthly AWS spend",
        "period_start": "2026-07-01",
        "period_end": "2026-07-31",
    }
    body.update(overrides)
    return body


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


class TestExpenseModel:
    def test_table_and_columns(self):
        cols = Expense.__table__.c
        assert Expense.__tablename__ == "expenses"
        assert {"id", "category", "vendor", "amount", "description"} <= set(cols.keys())
        assert {"period_start", "period_end", "created_at"} <= set(cols.keys())

    def test_column_widths(self):
        cols = Expense.__table__.c
        # SQLite ignores String(N); assert the contract on the metadata instead.
        assert cols.category.type.length >= 20
        assert cols.vendor.type.length >= 120

    def test_amount_is_money_precision(self):
        amount = Expense.__table__.c.amount.type
        assert amount.precision == 10
        assert amount.scale == 2

    def test_nullability(self):
        cols = Expense.__table__.c
        assert cols.category.nullable is False
        assert cols.amount.nullable is False
        assert cols.period_start.nullable is False
        assert cols.period_end.nullable is False
        assert cols.vendor.nullable is True
        assert cols.description.nullable is True

    def test_period_start_indexed_for_dashboard_bucketing(self):
        assert Expense.__table__.c.period_start.index is True

    def test_category_vocabulary_is_the_locked_set(self):
        assert EXPENSE_CATEGORIES == (
            "infrastructure",
            "ai",
            "email",
            "domain",
            "payment",
            "other",
        )

    def test_labels_cover_every_category(self):
        assert set(EXPENSE_CATEGORY_LABELS) == set(EXPENSE_CATEGORIES)

    def test_schema_literal_matches_the_model_vocabulary(self):
        assert set(ExpenseCategory.__args__) == set(EXPENSE_CATEGORIES)

    def test_label_helper_handles_unknown_values(self):
        assert expense_category_label("ai") == "AI / LLM"
        assert expense_category_label("INFRASTRUCTURE") == "Infrastructure"
        assert expense_category_label("cloud_ops") == "Cloud Ops"
        assert expense_category_label(None) == "Other"

    def test_row_round_trips(self, db):
        row = Expense(
            id=uuid.uuid4(),
            category="ai",
            vendor="Anthropic",
            amount=Decimal("120.00"),
            period_start=date(2026, 7, 1),
            period_end=date(2026, 7, 31),
        )
        db.add(row)
        db.commit()
        stored = db.query(Expense).one()
        assert float(stored.amount) == 120.0
        assert stored.created_at is not None


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


class TestExpenseCrudAuth:
    def test_all_methods_require_auth(self, client, seeded_db):
        assert client.get("/api/admin/expenses/").status_code == 401
        assert client.post("/api/admin/expenses/", json=_payload()).status_code == 401
        fake = str(uuid.uuid4())
        assert client.patch(f"/api/admin/expenses/{fake}", json={}).status_code == 401
        assert client.delete(f"/api/admin/expenses/{fake}").status_code == 401


class TestExpenseCrud:
    def test_create_then_list(self, client, seeded_db):
        headers = _auth_header(client)
        created = client.post("/api/admin/expenses/", json=_payload(), headers=headers)
        assert created.status_code == 200
        body = created.json()
        assert body["category"] == "infrastructure"
        assert body["vendor"] == "Amazon Web Services"
        assert body["period_start"] == "2026-07-01"
        assert body["created_at"] is not None
        # Decimal → JSON string (documented contract; TS must Number() it).
        assert body["amount"] == "21.23"
        assert isinstance(body["amount"], str)

        listed = client.get("/api/admin/expenses/", headers=headers).json()
        assert len(listed) == 1
        assert listed[0]["id"] == body["id"]

    def test_collection_path_without_trailing_slash_works(self, client, seeded_db):
        # FastAPI 307s to the canonical trailing-slash route; axios follows it.
        resp = client.get("/api/admin/expenses", headers=_auth_header(client))
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_is_newest_period_first(self, client, seeded_db):
        headers = _auth_header(client)
        for start, end in (
            ("2026-05-01", "2026-05-31"),
            ("2026-07-01", "2026-07-31"),
            ("2026-06-01", "2026-06-30"),
        ):
            client.post(
                "/api/admin/expenses/",
                json=_payload(period_start=start, period_end=end),
                headers=headers,
            )
        listed = client.get("/api/admin/expenses/", headers=headers).json()
        assert [row["period_start"] for row in listed] == [
            "2026-07-01",
            "2026-06-01",
            "2026-05-01",
        ]

    def test_patch_is_partial(self, client, seeded_db):
        headers = _auth_header(client)
        created = client.post("/api/admin/expenses/", json=_payload(), headers=headers).json()

        patched = client.patch(
            f"/api/admin/expenses/{created['id']}",
            json={"amount": "25.00"},
            headers=headers,
        )
        assert patched.status_code == 200
        body = patched.json()
        assert body["amount"] == "25.00"
        # Untouched fields survive.
        assert body["vendor"] == "Amazon Web Services"
        assert body["period_start"] == "2026-07-01"

    def test_delete(self, client, seeded_db):
        headers = _auth_header(client)
        created = client.post("/api/admin/expenses/", json=_payload(), headers=headers).json()
        assert (
            client.delete(f"/api/admin/expenses/{created['id']}", headers=headers).status_code
            == 204
        )
        assert client.get("/api/admin/expenses/", headers=headers).json() == []
        assert (
            client.delete(f"/api/admin/expenses/{created['id']}", headers=headers).status_code
            == 404
        )

    def test_unknown_category_is_422(self, client, seeded_db):
        resp = client.post(
            "/api/admin/expenses/",
            json=_payload(category="yacht"),
            headers=_auth_header(client),
        )
        assert resp.status_code == 422

    def test_inverted_period_is_422(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.post(
            "/api/admin/expenses/",
            json=_payload(period_start="2026-07-31", period_end="2026-07-01"),
            headers=headers,
        )
        assert resp.status_code == 422

        created = client.post("/api/admin/expenses/", json=_payload(), headers=headers).json()
        bad_patch = client.patch(
            f"/api/admin/expenses/{created['id']}",
            json={"period_end": "2026-06-01"},
            headers=headers,
        )
        assert bad_patch.status_code == 422

    def test_explicit_null_clears_optionals_but_rejects_required_fields(self, client, seeded_db):
        headers = _auth_header(client)
        created = client.post("/api/admin/expenses/", json=_payload(), headers=headers).json()

        cleared = client.patch(
            f"/api/admin/expenses/{created['id']}",
            json={"vendor": None, "description": None},
            headers=headers,
        )
        assert cleared.status_code == 200
        assert cleared.json()["vendor"] is None

        # NOT NULL columns — a null must 422, never a 500 at commit.
        for field in ("category", "amount", "period_start", "period_end"):
            resp = client.patch(
                f"/api/admin/expenses/{created['id']}", json={field: None}, headers=headers
            )
            assert resp.status_code == 422, field

    def test_malformed_id_is_404_not_500(self, client, seeded_db):
        headers = _auth_header(client)
        assert (
            client.patch("/api/admin/expenses/not-a-uuid", json={}, headers=headers).status_code
            == 404
        )
        assert client.delete("/api/admin/expenses/not-a-uuid", headers=headers).status_code == 404


# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------


class TestSeedExpenses:
    def test_seeds_three_consecutive_months_of_recurring_costs(self, db):
        from app.db.seed import _seed_expenses

        _seed_expenses(db)
        db.commit()

        rows = db.query(Expense).all()
        periods = sorted({row.period_start for row in rows})
        assert len(periods) == 3
        assert all(p.day == 1 for p in periods)
        # Consecutive CALENDAR months (the 30-day-subtraction helper skips one
        # across February — _calendar_month_bounds must not).
        indexes = [p.year * 12 + p.month for p in periods]
        assert indexes == [indexes[0], indexes[0] + 1, indexes[0] + 2]
        assert len(rows) == 3 * 5  # 5 recurring line items per month

        categories = {row.category for row in rows}
        assert categories == {"infrastructure", "domain", "email", "payment", "ai"}

    def test_aws_line_uses_the_estimator(self, db):
        from app.db.seed import _seed_expenses

        _seed_expenses(db)
        db.commit()
        aws = db.query(Expense).filter(Expense.vendor == "Amazon Web Services").first()
        assert aws is not None
        assert Decimal(str(aws.amount)) == estimate_monthly_aws_cost()
        # The number is a list-price estimate — the row says so out loud.
        assert "ESTIMATE" in (aws.description or "")

    def test_placeholder_lines_are_labelled(self, db):
        from app.db.seed import _seed_expenses

        _seed_expenses(db)
        db.commit()
        for vendor in ("Hover", "Stripe", "Anthropic"):
            row = db.query(Expense).filter(Expense.vendor == vendor).first()
            assert row is not None
            assert "PLACEHOLDER" in (row.description or ""), vendor

    def test_is_idempotent(self, db):
        from app.db.seed import _seed_expenses

        _seed_expenses(db)
        db.commit()
        before = db.query(Expense).count()
        _seed_expenses(db)
        db.commit()
        assert db.query(Expense).count() == before


# ---------------------------------------------------------------------------
# AWS cost estimator
# ---------------------------------------------------------------------------


class TestAwsCostEstimate:
    def test_total_is_a_decimal(self):
        total = estimate_monthly_aws_cost()
        assert isinstance(total, Decimal)
        assert total == Decimal("21.23")

    def test_line_items_sum_exactly_to_the_total(self):
        lines = estimate_monthly_aws_cost_breakdown()
        assert sum((line.amount for line in lines), Decimal("0.00")) == estimate_monthly_aws_cost()

    def test_line_items_are_labelled_and_priced(self):
        lines = estimate_monthly_aws_cost_breakdown()
        keys = [line.key for line in lines]
        assert keys == ["ec2_compute", "ebs_storage", "public_ipv4", "data_transfer_out"]
        for line in lines:
            assert isinstance(line.amount, Decimal)
            assert line.amount >= Decimal("0")
            assert line.label and line.detail

    def test_egress_is_free_under_the_100gb_allowance(self):
        dto = next(
            line
            for line in estimate_monthly_aws_cost_breakdown()
            if line.key == "data_transfer_out"
        )
        assert dto.amount == Decimal("0.00")

    def test_elastic_ip_is_billed(self):
        """Post-2024-02-01 AWS charges for every public IPv4, attached or not."""
        ipv4 = next(
            line for line in estimate_monthly_aws_cost_breakdown() if line.key == "public_ipv4"
        )
        assert ipv4.amount == Decimal("3.65")
