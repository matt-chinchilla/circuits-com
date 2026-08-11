"""Month navigation + provenance on /api/dashboard/expenses/breakdown.

The endpoint used to serve the current month only. It now takes ``?month=YYYY-MM``
and additionally reports the month it served (human label included), which months
hold data at all, and — per category — whether the figure is entirely an
ESTIMATE plus a per-vendor itemization.

Two things shape the assertions here:

  * ``Expense.source`` lands in a SEPARATE migration. Everything below reads it
    through the API rather than the model, and the tests that need a specific
    source SKIP (loudly) when the column is not in the schema, so this file is
    green on both sides of that change — including on a checkout where the
    migration has been reverted.
  * Months are bucketed in America/New_York (the dashboard's business day), so
    "this month" is computed with zoneinfo here too — ``date.today()`` would
    flake near midnight ET.
"""

import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import text

from app.models import Expense

EASTERN = ZoneInfo("America/New_York")

BREAKDOWN = "/api/dashboard/expenses/breakdown"


def _today_est() -> date:
    return datetime.now(EASTERN).date()


def _month_key(day: date) -> str:
    return f"{day.year:04d}-{day.month:02d}"


def _months_back(anchor: date, months_ago: int) -> date:
    """First of the month ``months_ago`` before ``anchor`` (real month math)."""
    index = anchor.year * 12 + (anchor.month - 1) - months_ago
    return date(index // 12, index % 12 + 1, 1)


def _add_expense(db, category, vendor, amount, period_start, description="test"):
    row = Expense(
        id=uuid.uuid4(),
        category=category,
        vendor=vendor,
        amount=Decimal(str(amount)),
        description=description,
        period_start=period_start,
        period_end=period_start,
    )
    db.add(row)
    db.commit()
    return row


def _has_source_column(db) -> bool:
    columns = sa_inspect(db.connection()).get_columns("expenses")
    return any(c["name"] == "source" for c in columns)


def _require_source_column(db) -> None:
    if not _has_source_column(db):
        pytest.skip("expenses.source has not been migrated in yet")


def _set_source(db, description: str, source: str) -> None:
    """Stamp provenance on rows by description — raw SQL so this file never
    imports a model attribute that may not exist yet."""
    db.execute(
        text("UPDATE expenses SET source = :source WHERE description = :description"),
        {"source": source, "description": description},
    )
    db.commit()


# ---------------------------------------------------------------------------
# Default month — the pre-existing contract must not move
# ---------------------------------------------------------------------------


class TestBreakdownDefaultMonth:
    def test_old_fields_are_unchanged_without_the_month_param(
        self, client, seeded_db, db, auth_header
    ):
        today = _today_est()
        first = today.replace(day=1)
        _add_expense(db, "infrastructure", "Amazon Web Services", "21.23", first)
        _add_expense(db, "ai", "Anthropic", "120.00", first)
        _add_expense(db, "domain", "Name.com", "1.50", first)
        prev_end = first - timedelta(days=1)
        _add_expense(db, "email", "Hover", "500.00", prev_end.replace(day=1))

        data = client.get(BREAKDOWN, headers=auth_header()).json()

        assert data["month"] == _month_key(today)
        assert data["total"] == 142.73
        assert isinstance(data["total"], int | float)
        categories = data["categories"]
        assert [c["category"] for c in categories] == ["ai", "infrastructure", "domain"]
        assert categories[0]["label"] == "AI / LLM"
        assert categories[0]["vendor"] == "Anthropic"
        assert categories[0]["amount"] == 120.0
        assert len({c["category"] for c in categories}) == len(categories)

    def test_new_fields_ride_along_on_the_default_response(
        self, client, seeded_db, db, auth_header
    ):
        today = _today_est()
        _add_expense(db, "ai", "Anthropic", "120.00", today.replace(day=1))

        data = client.get(BREAKDOWN, headers=auth_header()).json()

        assert data["label"].endswith(str(today.year))
        assert data["label"].split(" ")[0].isalpha()
        assert data["available_months"] == [_month_key(today)]
        entry = data["categories"][0]
        assert entry["estimated"] is False
        assert entry["vendors"] == [{"vendor": "Anthropic", "amount": 120.0, "source": "manual"}]

    def test_label_names_the_month_in_english(self, client, seeded_db, db, auth_header):
        _add_expense(db, "ai", "Anthropic", "10.00", date(2026, 8, 1))
        data = client.get(f"{BREAKDOWN}?month=2026-08", headers=auth_header()).json()
        assert data["label"] == "August 2026"

    def test_empty_month_still_answers(self, client, seeded_db, auth_header):
        data = client.get(BREAKDOWN, headers=auth_header()).json()
        assert data["total"] == 0
        assert data["categories"] == []
        assert data["available_months"] == []

    def test_requires_auth(self, client, seeded_db):
        assert client.get(f"{BREAKDOWN}?month=2026-08").status_code == 401


# ---------------------------------------------------------------------------
# ?month=YYYY-MM
# ---------------------------------------------------------------------------


class TestExplicitMonth:
    def test_explicit_month_selects_that_month(self, client, seeded_db, db, auth_header):
        first = _today_est().replace(day=1)
        prev_first = _months_back(first, 1)
        _add_expense(db, "ai", "Anthropic", "120.00", first)
        _add_expense(db, "email", "Hover", "500.00", prev_first)
        _add_expense(db, "domain", "Name.com", "12.00", prev_first)

        data = client.get(
            f"{BREAKDOWN}?month={_month_key(prev_first)}", headers=auth_header()
        ).json()

        assert data["month"] == _month_key(prev_first)
        assert data["total"] == 512.0
        assert [c["category"] for c in data["categories"]] == ["email", "domain"]

    def test_asking_for_the_current_month_matches_the_default(
        self, client, seeded_db, db, auth_header
    ):
        today = _today_est()
        _add_expense(db, "ai", "Anthropic", "120.00", today.replace(day=1))
        _add_expense(db, "email", "Hover", "500.00", _months_back(today.replace(day=1), 2))

        default = client.get(BREAKDOWN, headers=auth_header()).json()
        explicit = client.get(
            f"{BREAKDOWN}?month={_month_key(today)}", headers=auth_header()
        ).json()
        assert explicit == default

    def test_month_without_rows_is_empty_not_an_error(self, client, seeded_db, db, auth_header):
        _add_expense(db, "ai", "Anthropic", "120.00", _today_est().replace(day=1))

        resp = client.get(f"{BREAKDOWN}?month=1999-01", headers=auth_header())
        assert resp.status_code == 200
        data = resp.json()
        assert data["month"] == "1999-01"
        assert data["label"] == "January 1999"
        assert data["total"] == 0
        assert data["categories"] == []
        # The pager still knows where the data lives.
        assert data["available_months"] == [_month_key(_today_est())]

    def test_a_month_boundary_is_never_double_counted(self, client, seeded_db, db, auth_header):
        """Rows on the first/last day belong to exactly one month."""
        first = date(2026, 3, 1)
        _add_expense(db, "ai", "Anthropic", "10.00", first)
        _add_expense(db, "ai", "Anthropic", "20.00", date(2026, 3, 31))
        _add_expense(db, "ai", "Anthropic", "40.00", date(2026, 2, 28))
        _add_expense(db, "ai", "Anthropic", "80.00", date(2026, 4, 1))

        assert (
            client.get(f"{BREAKDOWN}?month=2026-03", headers=auth_header()).json()["total"] == 30.0
        )
        assert (
            client.get(f"{BREAKDOWN}?month=2026-02", headers=auth_header()).json()["total"] == 40.0
        )
        assert (
            client.get(f"{BREAKDOWN}?month=2026-04", headers=auth_header()).json()["total"] == 80.0
        )


class TestMonthValidation:
    @pytest.mark.parametrize(
        "bad",
        [
            "2026-13",  # month out of range
            "2026-00",
            "2026-8",  # unpadded
            "26-08",  # short year
            "2026-08-01",  # a full date
            "August",
            "",
            "2026/08",
            "0000-01",  # clears the regex, is not a representable date
        ],
    )
    def test_garbage_month_is_a_422(self, client, seeded_db, auth_header, bad):
        assert client.get(f"{BREAKDOWN}?month={bad}", headers=auth_header()).status_code == 422


# ---------------------------------------------------------------------------
# available_months — what the UI pager steps through
# ---------------------------------------------------------------------------


class TestAvailableMonths:
    def test_distinct_and_sorted_newest_first(self, client, seeded_db, db, auth_header):
        _add_expense(db, "ai", "Anthropic", "10.00", date(2026, 3, 1))
        _add_expense(db, "email", "Hover", "20.00", date(2026, 3, 14))  # same month
        _add_expense(db, "ai", "Anthropic", "30.00", date(2026, 1, 1))
        _add_expense(db, "ai", "Anthropic", "40.00", date(2025, 12, 1))

        months = client.get(BREAKDOWN, headers=auth_header()).json()["available_months"]
        assert months == ["2026-03", "2026-01", "2025-12"]
        assert len(months) == len(set(months))

    def test_capped_at_24_newest(self, client, seeded_db, db, auth_header):
        anchor = date(2026, 8, 1)
        for months_ago in range(30):
            _add_expense(db, "ai", "Anthropic", "10.00", _months_back(anchor, months_ago))

        months = client.get(BREAKDOWN, headers=auth_header()).json()["available_months"]
        assert len(months) == 24
        expected = [_month_key(_months_back(anchor, n)) for n in range(24)]
        assert months == expected

    def test_same_list_whatever_month_is_served(self, client, seeded_db, db, auth_header):
        _add_expense(db, "ai", "Anthropic", "10.00", date(2026, 3, 1))
        _add_expense(db, "ai", "Anthropic", "20.00", date(2026, 1, 1))

        served = client.get(f"{BREAKDOWN}?month=2026-01", headers=auth_header()).json()
        other = client.get(f"{BREAKDOWN}?month=1999-05", headers=auth_header()).json()
        assert served["available_months"] == other["available_months"] == ["2026-03", "2026-01"]


# ---------------------------------------------------------------------------
# estimated / vendors — provenance
# ---------------------------------------------------------------------------


class TestEstimatedFlag:
    def test_plain_rows_are_not_estimates(self, client, seeded_db, db, auth_header):
        _add_expense(db, "infrastructure", "Amazon Web Services", "21.23", date(2026, 8, 1))
        data = client.get(f"{BREAKDOWN}?month=2026-08", headers=auth_header()).json()
        assert data["categories"][0]["estimated"] is False

    def test_true_when_every_row_is_an_estimate(self, client, seeded_db, db, auth_header):
        _require_source_column(db)
        _add_expense(
            db, "infrastructure", "Amazon Web Services", "21.23", date(2026, 8, 1), "aws-est"
        )
        _add_expense(db, "infrastructure", "Cloudflare", "20.00", date(2026, 8, 1), "cf-est")
        _set_source(db, "aws-est", "estimate")
        _set_source(db, "cf-est", "estimate")

        data = client.get(f"{BREAKDOWN}?month=2026-08", headers=auth_header()).json()
        entry = data["categories"][0]
        assert entry["category"] == "infrastructure"
        assert entry["estimated"] is True
        assert {v["source"] for v in entry["vendors"]} == {"estimate"}

    def test_false_once_an_aws_actual_lands_beside_the_estimate(
        self, client, seeded_db, db, auth_header
    ):
        _require_source_column(db)
        _add_expense(
            db, "infrastructure", "Amazon Web Services", "21.23", date(2026, 8, 1), "aws-est"
        )
        _add_expense(
            db, "infrastructure", "Amazon Web Services", "24.10", date(2026, 8, 1), "aws-bill"
        )
        _set_source(db, "aws-est", "estimate")
        _set_source(db, "aws-bill", "aws")

        entry = client.get(f"{BREAKDOWN}?month=2026-08", headers=auth_header()).json()[
            "categories"
        ][0]
        assert entry["estimated"] is False
        # One vendor, two provenances — neither is collapsed into the other.
        assert entry["vendors"] == [
            {"vendor": "Amazon Web Services", "amount": 24.10, "source": "aws"},
            {"vendor": "Amazon Web Services", "amount": 21.23, "source": "estimate"},
        ]

    def test_estimated_is_per_category(self, client, seeded_db, db, auth_header):
        _require_source_column(db)
        _add_expense(
            db, "infrastructure", "Amazon Web Services", "21.23", date(2026, 8, 1), "aws-est"
        )
        _add_expense(db, "ai", "Anthropic", "120.00", date(2026, 8, 1), "claude-bill")
        _set_source(db, "aws-est", "estimate")

        by_category = {
            c["category"]: c
            for c in client.get(f"{BREAKDOWN}?month=2026-08", headers=auth_header()).json()[
                "categories"
            ]
        }
        assert by_category["infrastructure"]["estimated"] is True
        assert by_category["ai"]["estimated"] is False


class TestVendorItemization:
    def test_vendors_sorted_by_amount_desc_and_sum_to_the_category(
        self, client, seeded_db, db, auth_header
    ):
        _add_expense(db, "infrastructure", "Cloudflare", "20.00", date(2026, 8, 1))
        _add_expense(db, "infrastructure", "Amazon Web Services", "21.23", date(2026, 8, 1))
        _add_expense(db, "infrastructure", "Fastly", "5.00", date(2026, 8, 1))

        entry = client.get(f"{BREAKDOWN}?month=2026-08", headers=auth_header()).json()[
            "categories"
        ][0]
        assert [v["vendor"] for v in entry["vendors"]] == [
            "Amazon Web Services",
            "Cloudflare",
            "Fastly",
        ]
        assert [v["amount"] for v in entry["vendors"]] == [21.23, 20.0, 5.0]
        assert round(sum(v["amount"] for v in entry["vendors"]), 2) == entry["amount"]
        # The legacy comma-joined string is still there for existing consumers.
        assert entry["vendor"] == "Cloudflare, Amazon Web Services, Fastly"

    def test_repeat_vendor_rows_are_summed(self, client, seeded_db, db, auth_header):
        _add_expense(db, "ai", "Anthropic", "100.00", date(2026, 8, 1))
        _add_expense(db, "ai", "Anthropic", "20.50", date(2026, 8, 9))

        entry = client.get(f"{BREAKDOWN}?month=2026-08", headers=auth_header()).json()[
            "categories"
        ][0]
        assert entry["vendors"] == [{"vendor": "Anthropic", "amount": 120.50, "source": "manual"}]

    def test_missing_vendor_serializes_as_null_not_omitted(
        self, client, seeded_db, db, auth_header
    ):
        _add_expense(db, "other", None, "9.00", date(2026, 8, 1))

        entry = client.get(f"{BREAKDOWN}?month=2026-08", headers=auth_header()).json()[
            "categories"
        ][0]
        assert entry["vendors"] == [{"vendor": None, "amount": 9.0, "source": "manual"}]
        # `?:` in TS only catches undefined — the key MUST be present and null.
        assert "vendor" in entry["vendors"][0]
        assert entry["vendor"] == ""

    def test_amounts_are_numbers_not_numeric_strings(self, client, seeded_db, db, auth_header):
        _add_expense(db, "ai", "Anthropic", "120.00", date(2026, 8, 1))
        entry = client.get(f"{BREAKDOWN}?month=2026-08", headers=auth_header()).json()[
            "categories"
        ][0]
        assert isinstance(entry["vendors"][0]["amount"], int | float)
