"""Automated cost sync: the write rules, the two live sources, and the gate.

The money properties under test, in the order they can hurt:

1. A sync NEVER overwrites a row a person typed, and never leaves an estimate
   sitting next to the actual it was standing in for (that is a doubled AWS
   bill in the P&L, not a cosmetic duplicate).
2. Cost Explorer costs $0.01 per request, so the staleness gate is asserted on
   both sides: a fresh table must make NO call, a stale one must make exactly
   one, and a first-ever sync must ask for the 13-month backfill.
3. Query strings reach Stripe through httpx `params=` — asserted on what the
   fake Stripe RECEIVED, because that is the only place the encoding defect
   from services/stripe_quotes.py would have been visible.

Neither source is exercised through a network: AWS is monkeypatched at the
`_ce_client` seam (so the suite never needs boto3 installed) and Stripe runs
real httpx through MockTransport.
"""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest
from sqlalchemy.exc import ProgrammingError

from app.config import settings
from app.jobs import sync_costs
from app.models.expense import Expense
from app.schemas.expense import ExpenseCreate, ExpenseResponse, ExpenseUpdate
from app.services.cost_sources import aws as aws_source
from app.services.cost_sources.anthropic import fetch_anthropic_cost_lines
from app.services.cost_sources.aws import fetch_aws_cost_lines
from app.services.cost_sources.base import (
    CostSourceUnavailable,
    SyncedCost,
    upsert_synced_costs,
)
from app.services.cost_sources.stripe_fees import fetch_stripe_fee_lines

JULY = date(2026, 7, 1)
JULY_END = date(2026, 7, 31)
AUGUST = date(2026, 8, 1)
AUGUST_END = date(2026, 8, 31)


def aws_line(amount="10.00", vendor="AWS - Circuit Center", start=AUGUST, end=AUGUST_END):
    return SyncedCost(
        source="aws",
        category="infrastructure",
        vendor=vendor,
        amount=Decimal(amount),
        period_start=start,
        period_end=end,
    )


def add_expense(db, **kwargs):
    defaults = {
        "category": "infrastructure",
        "vendor": "Amazon Web Services",
        "amount": Decimal("21.23"),
        "period_start": AUGUST,
        "period_end": AUGUST_END,
        "source": "manual",
    }
    row = Expense(**{**defaults, **kwargs})
    db.add(row)
    db.commit()
    return row


# ---------------------------------------------------------------------------
# Schema (SQLite ignores VARCHAR length, so assert on the metadata)
# ---------------------------------------------------------------------------


class TestExpenseSourceColumn:
    def test_source_is_a_non_null_string_defaulting_to_manual(self):
        col = Expense.__table__.c.source
        assert col.type.length >= 20
        assert col.nullable is False
        # The server_default is what makes the NOT NULL safe on the populated
        # prod table AND what makes a row inserted by hand in psql land as
        # 'manual' — i.e. as something no sync will overwrite.
        assert col.server_default is not None
        assert "manual" in str(col.server_default.arg)

    def test_updated_at_exists_for_the_staleness_gate(self):
        col = Expense.__table__.c.updated_at
        assert col.nullable is True
        assert col.onupdate is not None

    def test_the_orm_default_applies_when_source_is_omitted(self, db):
        row = Expense(
            category="other",
            vendor="Someone",
            amount=Decimal("1.00"),
            period_start=AUGUST,
            period_end=AUGUST_END,
        )
        db.add(row)
        db.commit()
        assert row.source == "manual"

    def test_response_carries_source_but_the_write_schemas_cannot_set_it(self):
        assert "source" in ExpenseResponse.model_fields
        # Server-controlled: a client that could set this could label a typed
        # number 'aws' and have the next sync silently overwrite it.
        assert "source" not in ExpenseCreate.model_fields
        assert "source" not in ExpenseUpdate.model_fields

    def test_the_seed_marks_every_placeholder_as_an_estimate(self, db):
        """AWS + the three PLACEHOLDER stand-ins (Stripe, Anthropic, Hover)
        are estimates — each is retired by supersede the moment its real
        synced figure lands. Name.com stays manual: a known recurring bill no
        sync will ever measure, so it must never be supersede-deletable."""
        from app.db.seed import _seed_expenses

        _seed_expenses(db)
        db.commit()
        rows = db.query(Expense).all()
        estimates = {r.vendor for r in rows if r.source == "estimate"}
        assert estimates == {"Amazon Web Services", "Stripe", "Anthropic", "Hover"}
        assert {r.source for r in rows if r.vendor == "Name.com"} == {"manual"}


class TestMigration026:
    """The suite builds tables with `create_all` and never runs migrations, so
    the one-time backfill has no other reader. Asserted on the shipped text."""

    @property
    def source(self):
        path = (
            Path(__file__).resolve().parents[1]
            / "alembic"
            / "versions"
            / "026_add_expense_source.py"
        )
        return path.read_text()

    def test_it_backfills_the_already_seeded_estimates(self):
        """Without this, every EXISTING AWS row defaults to 'manual' and the
        first real sync adds an actual NEXT TO it — infrastructure spend reads
        double, and `--reseed` cannot fix it (expenses is outside the TRUNCATE
        graph and _seed_expenses returns early when any row exists)."""
        text = self.source
        assert "UPDATE expenses" in text and "'estimate'" in text
        for guard in ("category = 'infrastructure'", "vendor = 'Amazon Web Services'", "LIKE"):
            assert guard in text, (
                f"the backfill lost its {guard!r} guard — a loose UPDATE could relabel a "
                "hand-entered row 'estimate', which a later AWS sync DELETES"
            )

    def test_the_seeded_description_still_matches_the_backfill_prefix(self, db):
        from app.db.seed import _seed_expenses

        _seed_expenses(db)
        db.commit()
        row = db.query(Expense).filter(Expense.vendor == "Amazon Web Services").first()
        assert row is not None
        # The migration matches on this prefix. Editing the seed's wording past
        # it would silently orphan every pre-026 estimate on prod.
        assert (row.description or "").startswith("ESTIMATE (list price, not an invoice)")

    def test_the_ddl_is_replayable(self):
        """alembic/env.py sets no transaction_per_migration: a failure partway
        through `upgrade head` replays this file on the next api boot, and
        "column already exists" would crash-loop the container at 502."""
        text = self.source
        for column in ("source VARCHAR(20)", "updated_at TIMESTAMPTZ"):
            statement = f"ADD COLUMN IF NOT EXISTS {column}"
            assert statement in text, f"{column} is not added idempotently"


# ---------------------------------------------------------------------------
# upsert_synced_costs
# ---------------------------------------------------------------------------


class TestUpsert:
    def test_creates_a_row_per_line(self, db):
        stats = upsert_synced_costs(db, [aws_line("12.34"), aws_line("5.00", vendor="AWS - Other")])
        assert stats == {"created": 2, "updated": 0, "superseded": 0, "reconciled": 0}
        assert db.query(Expense).count() == 2
        row = db.query(Expense).filter(Expense.vendor == "AWS - Other").one()
        assert Decimal(str(row.amount)) == Decimal("5.00")
        assert row.source == "aws"
        assert row.category == "infrastructure"

    def test_a_second_pass_updates_in_place_instead_of_appending(self, db):
        upsert_synced_costs(db, [aws_line("12.34")])
        stats = upsert_synced_costs(db, [aws_line("40.00")])

        assert stats["created"] == 0
        assert stats["updated"] == 1
        assert db.query(Expense).count() == 1
        assert Decimal(str(db.query(Expense).one().amount)) == Decimal("40.00")

    def test_the_same_vendor_in_a_different_month_is_a_different_row(self, db):
        upsert_synced_costs(db, [aws_line("12.34", start=JULY, end=JULY_END)])
        upsert_synced_costs(db, [aws_line("40.00", start=AUGUST, end=AUGUST_END)])
        assert db.query(Expense).count() == 2

    def test_a_re_sync_with_an_identical_amount_still_advances_updated_at(self, db):
        """The staleness gate reads updated_at. `onupdate` does NOT fire when
        nothing changed, so an unchanged month would look un-synced forever and
        the job would spend $0.01 every hour re-asking."""
        upsert_synced_costs(db, [aws_line("12.34")])
        row = db.query(Expense).one()
        stale = datetime.now(UTC) - timedelta(days=3)
        row.updated_at = stale
        db.commit()

        upsert_synced_costs(db, [aws_line("12.34")])
        db.refresh(row)
        refreshed = sync_costs._as_utc(row.updated_at)
        assert refreshed is not None and refreshed > stale

    def test_a_manual_row_is_never_touched(self, db):
        """Same vendor, same month, typed by a person: it must survive intact
        AND not be adopted as the sync's own row."""
        manual = add_expense(
            db, vendor="AWS - Circuit Center", amount=Decimal("999.00"), source="manual"
        )
        upsert_synced_costs(db, [aws_line("12.34", vendor="AWS - Circuit Center")])
        db.refresh(manual)

        assert Decimal(str(manual.amount)) == Decimal("999.00")
        assert manual.source == "manual"
        assert db.query(Expense).filter(Expense.source == "aws").count() == 1

    def test_a_source_may_not_claim_the_manual_label(self, db):
        with pytest.raises(ValueError, match="manual"):
            upsert_synced_costs(
                db,
                [
                    SyncedCost(
                        source="manual",
                        category="infrastructure",
                        vendor="Anything",
                        amount=Decimal("1.00"),
                        period_start=AUGUST,
                        period_end=AUGUST_END,
                    )
                ],
            )

    def test_an_aws_actual_supersedes_that_month_s_estimate(self, db):
        estimate = add_expense(db, source="estimate", period_start=AUGUST, period_end=AUGUST_END)
        stats = upsert_synced_costs(db, [aws_line("37.07")])

        assert stats["superseded"] == 1
        assert db.query(Expense).filter(Expense.id == estimate.id).first() is None
        assert db.query(Expense).count() == 1

    def test_several_aws_vendors_in_one_month_supersede_the_estimate_once(self, db):
        add_expense(db, source="estimate")
        stats = upsert_synced_costs(
            db,
            [
                aws_line("20.00", vendor="AWS - Circuit Center"),
                aws_line("10.00", vendor="AWS - Mail Server"),
                aws_line("7.07", vendor="AWS - Other"),
            ],
        )
        assert stats["superseded"] == 1
        assert stats["created"] == 3

    def test_an_estimate_for_another_month_survives(self, db):
        july = add_expense(db, source="estimate", period_start=JULY, period_end=JULY_END)
        upsert_synced_costs(db, [aws_line("37.07", start=AUGUST, end=AUGUST_END)])
        assert db.query(Expense).filter(Expense.id == july.id).first() is not None

    def test_a_stripe_line_supersedes_nothing(self, db):
        """The estimate stands in for the AWS bill. Fees are an additional
        cost, not a better measurement of one already shown."""
        estimate = add_expense(db, source="estimate")
        stats = upsert_synced_costs(
            db,
            [
                SyncedCost(
                    source="stripe",
                    category="payment",
                    vendor="Stripe fees",
                    amount=Decimal("4.20"),
                    period_start=AUGUST,
                    period_end=AUGUST_END,
                )
            ],
        )
        assert stats["superseded"] == 0
        assert db.query(Expense).filter(Expense.id == estimate.id).first() is not None

    def test_no_lines_is_a_no_op(self, db):
        add_expense(db)
        assert upsert_synced_costs(db, []) == {"created": 0, "updated": 0, "superseded": 0, "reconciled": 0}
        assert db.query(Expense).count() == 1


# ---------------------------------------------------------------------------
# AWS Cost Explorer
# ---------------------------------------------------------------------------


class FakeCE:
    """Records the request and replays a canned GetCostAndUsage payload."""

    def __init__(self, response=None, error=None):
        self.response = response or {}
        self.error = error
        self.calls: list[dict] = []

    def get_cost_and_usage(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.response


def ce_result(start, end, groups):
    return {
        "TimePeriod": {"Start": start, "End": end},
        "Groups": [
            {
                "Keys": [key],
                "Metrics": {"UnblendedCost": {"Amount": amount, "Unit": "USD"}},
            }
            for key, amount in groups
        ],
    }


@pytest.fixture
def fake_ce(monkeypatch):
    def install(response=None, error=None):
        fake = FakeCE(response, error)
        monkeypatch.setattr(aws_source, "_ce_client", lambda: fake)
        return fake

    return install


class TestAwsSource:
    def test_maps_the_two_tagged_apps_and_sums_everything_else(self, fake_ce):
        fake = fake_ce(
            {
                "ResultsByTime": [
                    ce_result(
                        "2026-08-01",
                        "2026-08-12",
                        [
                            ("Application$circuits-com", "22.5000001"),
                            ("Application$circuits-mail", "8.10"),
                            ("Application$", "6.47"),
                            ("Application$something-else", "0.50"),
                        ],
                    )
                ]
            }
        )
        lines = fetch_aws_cost_lines(2, today=date(2026, 8, 11))
        assert fake.calls, "the CE client was never called"

        by_vendor = {line.vendor: line for line in lines}
        assert set(by_vendor) == {"AWS - Circuit Center", "AWS - Mail Server", "AWS - Other"}
        assert by_vendor["AWS - Circuit Center"].amount == Decimal("22.50")
        assert by_vendor["AWS - Mail Server"].amount == Decimal("8.10")
        # Untagged AND an unrecognised tag both fold into one honest bucket.
        assert by_vendor["AWS - Other"].amount == Decimal("6.97")
        assert all(line.source == "aws" for line in lines)
        # Per-server categories (user decision 2026-08-11): the mail box files
        # under 'email' so the per-server price difference reads at category
        # level; the web stack and the untagged remainder stay infrastructure.
        assert by_vendor["AWS - Mail Server"].category == "email"
        assert by_vendor["AWS - Circuit Center"].category == "infrastructure"
        assert by_vendor["AWS - Other"].category == "infrastructure"

    def test_a_month_before_tag_activation_lands_entirely_in_other(self, fake_ce):
        """Cost allocation tags are not retroactive. Reporting those dollars as
        zero for the two apps would be a prettier chart and a lie."""
        fake_ce(
            {
                "ResultsByTime": [
                    ce_result("2026-07-01", "2026-08-01", [("Application$", "37.07")]),
                ]
            }
        )
        lines = fetch_aws_cost_lines(2, today=date(2026, 8, 11))
        assert [(line.vendor, line.amount) for line in lines] == [("AWS - Other", Decimal("37.07"))]

    def test_period_bounds_are_whole_calendar_months(self, fake_ce):
        fake_ce(
            {
                "ResultsByTime": [
                    ce_result("2026-08-01", "2026-08-12", [("Application$", "1.00")]),
                    ce_result("2026-02-01", "2026-03-01", [("Application$", "2.00")]),
                ]
            }
        )
        lines = fetch_aws_cost_lines(2, today=date(2026, 8, 11))
        bounds = {(line.period_start, line.period_end) for line in lines}
        # Month-to-date still spans the whole month: the dashboard buckets on
        # period_start and a half-month end would sort the current month apart.
        assert (date(2026, 8, 1), date(2026, 8, 31)) in bounds
        assert (date(2026, 2, 1), date(2026, 2, 28)) in bounds

    def test_zero_lines_are_dropped(self, fake_ce):
        fake_ce(
            {
                "ResultsByTime": [
                    ce_result(
                        "2026-08-01",
                        "2026-08-12",
                        [
                            ("Application$circuits-com", "0"),
                            ("Application$circuits-mail", "0.000"),
                            ("Application$", "12.00"),
                        ],
                    )
                ]
            }
        )
        lines = fetch_aws_cost_lines(2, today=date(2026, 8, 11))
        assert [line.vendor for line in lines] == ["AWS - Other"]

    def test_one_request_covers_the_whole_window(self, fake_ce):
        """Each GetCostAndUsage costs $0.01 — a month-at-a-time loop would be
        13 cents per backfill and 2 per routine pass, forever."""
        fake = fake_ce({"ResultsByTime": []})
        fetch_aws_cost_lines(13, today=date(2026, 8, 11))

        assert len(fake.calls) == 1
        call = fake.calls[0]
        # 13 months INCLUDING the current one → back to 2025-08-01.
        assert call["TimePeriod"] == {"Start": "2025-08-01", "End": "2026-08-12"}
        assert call["Granularity"] == "MONTHLY"
        assert call["Metrics"] == ["UnblendedCost"]
        assert call["GroupBy"] == [{"Type": "TAG", "Key": "Application"}]

    def test_the_routine_window_is_this_month_and_last(self, fake_ce):
        fake = fake_ce({"ResultsByTime": []})
        fetch_aws_cost_lines(2, today=date(2026, 1, 15))
        assert fake.calls[0]["TimePeriod"] == {"Start": "2025-12-01", "End": "2026-01-16"}

    def test_the_end_is_tomorrow_so_today_is_included(self, fake_ce):
        """Cost Explorer's End is exclusive; asking for a period that ends
        today returns nothing for today."""
        fake = fake_ce({"ResultsByTime": []})
        fetch_aws_cost_lines(2, today=date(2026, 8, 31))
        assert fake.calls[0]["TimePeriod"]["End"] == "2026-09-01"

    def test_a_credential_failure_is_CostSourceUnavailable(self, fake_ce):
        class NoCredentialsError(Exception):
            pass

        fake_ce(error=NoCredentialsError("Unable to locate credentials"))
        with pytest.raises(CostSourceUnavailable) as err:
            fetch_aws_cost_lines(2, today=date(2026, 8, 11))
        assert "NoCredentialsError" in str(err.value)

    def test_a_missing_boto3_is_also_CostSourceUnavailable(self, monkeypatch):
        def explode():
            raise ImportError("No module named 'boto3'")

        monkeypatch.setattr(aws_source, "_ce_client", explode)
        with pytest.raises(CostSourceUnavailable):
            fetch_aws_cost_lines(2, today=date(2026, 8, 11))

    def test_a_malformed_result_is_skipped_not_fatal(self, fake_ce):
        fake_ce(
            {
                "ResultsByTime": [
                    {"Groups": [("bad",)]},
                    ce_result("2026-08-01", "2026-08-12", [("Application$", "3.00")]),
                ]
            }
        )
        lines = fetch_aws_cost_lines(2, today=date(2026, 8, 11))
        assert [line.amount for line in lines] == [Decimal("3.00")]


# ---------------------------------------------------------------------------
# Stripe fees
# ---------------------------------------------------------------------------


class FakeStripeBalance:
    """Pages of balance transactions, with a tape of what was REQUESTED.

    The tape reads query params the way Stripe would, because the params-vs-
    f-string defect this repo already paid for once is only visible there.
    """

    def __init__(self, pages):
        self.pages = pages
        self.requests: list[httpx.Request] = []
        self.status = 200

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": {"message": "nope"}})
        index = 0
        cursor = request.url.params.get("starting_after")
        if cursor:
            for i, page in enumerate(self.pages):
                if any(row["id"] == cursor for row in page["data"]):
                    index = i + 1
                    break
        page = self.pages[index] if index < len(self.pages) else {"data": [], "has_more": False}
        return httpx.Response(200, json=page)


def txn(txn_id, fee, when):
    return {"id": txn_id, "fee": fee, "created": int(when.timestamp())}


NOW = datetime(2026, 8, 11, 12, 0, tzinfo=UTC)


def run_stripe(fake, now=NOW):
    return fetch_stripe_fee_lines("sk_test_x", now=now, transport=httpx.MockTransport(fake.handler))


class TestStripeFees:
    def test_sums_fees_and_buckets_them_by_calendar_month(self):
        fake = FakeStripeBalance(
            [
                {
                    "data": [
                        txn("txn_1", 320, datetime(2026, 7, 31, 23, 30, tzinfo=UTC)),
                        txn("txn_2", 180, datetime(2026, 8, 1, 0, 30, tzinfo=UTC)),
                        txn("txn_3", 250, datetime(2026, 8, 9, 10, 0, tzinfo=UTC)),
                    ],
                    "has_more": False,
                }
            ]
        )
        lines = run_stripe(fake)

        assert [(line.period_start, line.amount) for line in lines] == [
            (date(2026, 7, 1), Decimal("3.20")),
            (date(2026, 8, 1), Decimal("4.30")),
        ]
        assert {line.vendor for line in lines} == {"Stripe fees"}
        assert {line.source for line in lines} == {"stripe"}
        assert {line.category for line in lines} == {"payment"}
        assert lines[0].period_end == date(2026, 7, 31)

    def test_paginates_with_starting_after(self):
        fake = FakeStripeBalance(
            [
                {
                    "data": [
                        txn("txn_1", 100, datetime(2026, 8, 2, tzinfo=UTC)),
                        txn("txn_2", 100, datetime(2026, 8, 3, tzinfo=UTC)),
                    ],
                    "has_more": True,
                },
                {
                    "data": [txn("txn_3", 55, datetime(2026, 8, 4, tzinfo=UTC))],
                    "has_more": False,
                },
            ]
        )
        lines = run_stripe(fake)

        assert len(fake.requests) == 2
        assert fake.requests[0].url.params.get("starting_after") is None
        # The cursor is the LAST id of the previous page.
        assert fake.requests[1].url.params.get("starting_after") == "txn_2"
        assert [line.amount for line in lines] == [Decimal("2.55")]

    def test_the_query_string_is_params_encoded_not_interpolated(self):
        """`params=` only — an f-string ships `+` raw (Stripe decodes it as a
        space) and lets `&`/`#` inject or truncate. See services/stripe_quotes.py."""
        fake = FakeStripeBalance([{"data": [], "has_more": False}])
        run_stripe(fake)

        request = fake.requests[0]
        expected = int(datetime(2026, 7, 1, tzinfo=UTC).timestamp())
        assert request.url.params.get("created[gte]") == str(expected)
        assert request.url.params.get("limit") == "100"
        # Brackets percent-encoded on the wire, decoded by Stripe as created[gte].
        assert "created%5Bgte%5D" in str(request.url)

    def test_the_window_starts_at_the_first_of_the_previous_month(self):
        fake = FakeStripeBalance([{"data": [], "has_more": False}])
        run_stripe(fake, now=datetime(2026, 1, 9, tzinfo=UTC))
        expected = int(datetime(2025, 12, 1, tzinfo=UTC).timestamp())
        assert fake.requests[0].url.params.get("created[gte]") == str(expected)

    def test_a_month_with_no_fees_produces_no_line(self):
        fake = FakeStripeBalance(
            [
                {
                    "data": [
                        txn("txn_1", 0, datetime(2026, 8, 2, tzinfo=UTC)),
                        {"id": "txn_2", "created": None, "fee": 100},
                    ],
                    "has_more": False,
                }
            ]
        )
        assert run_stripe(fake) == []

    def test_a_non_200_is_CostSourceUnavailable(self):
        fake = FakeStripeBalance([{"data": [], "has_more": False}])
        fake.status = 401
        with pytest.raises(CostSourceUnavailable) as err:
            run_stripe(fake)
        assert "401" in str(err.value)

    def test_a_transport_error_is_CostSourceUnavailable(self):
        def explode(request):
            raise httpx.ConnectError("no route to host")

        with pytest.raises(CostSourceUnavailable):
            fetch_stripe_fee_lines("sk_test_x", now=NOW, transport=httpx.MockTransport(explode))

    def test_has_more_without_a_cursor_stops_instead_of_looping(self):
        """Page one repeated forever inside an hourly job would double-count it
        MAX_PAGES times; stopping is the safe answer."""
        fake = FakeStripeBalance(
            [{"data": [{"fee": 100, "created": int(NOW.timestamp())}], "has_more": True}]
        )
        lines = run_stripe(fake)
        assert len(fake.requests) == 1
        assert [line.amount for line in lines] == [Decimal("1.00")]


# ---------------------------------------------------------------------------
# Anthropic (stub)
# ---------------------------------------------------------------------------


class TestAnthropicStub:
    def test_no_key_means_no_lines(self):
        assert fetch_anthropic_cost_lines(None) == []
        assert fetch_anthropic_cost_lines("") == []

    def test_a_configured_key_warns_rather_than_pretending(self, caplog):
        with caplog.at_level("WARNING"):
            assert fetch_anthropic_cost_lines("sk-ant-admin-fake") == []
        assert "not implemented" in caplog.text


# ---------------------------------------------------------------------------
# The job: the staleness gate is the money gate
# ---------------------------------------------------------------------------


@pytest.fixture
def spy_aws(monkeypatch):
    """Replaces the AWS fetch inside the job and records the months asked for."""
    calls: list[int] = []

    def fake(months_back=2):
        calls.append(months_back)
        return [aws_line("37.07")]

    monkeypatch.setattr(sync_costs, "fetch_aws_cost_lines", fake)
    return calls


@pytest.fixture
def no_stripe(monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", None)


class TestStalenessGate:
    def test_an_empty_table_asks_for_the_thirteen_month_backfill(self, db, spy_aws, no_stripe):
        sync_costs.run_sync_pass(db)
        assert spy_aws == [13]

    def test_a_row_synced_today_et_spends_nothing(self, db, spy_aws, no_stripe):
        """One sync per ET calendar day: 01:00 this morning covers all of today."""
        et = ZoneInfo("America/New_York")
        this_morning = datetime.now(et).replace(hour=1, minute=0, second=0, microsecond=0)
        late_tonight = this_morning.replace(hour=23)
        add_expense(db, source="aws", updated_at=this_morning.astimezone(UTC))
        stats = sync_costs.run_sync_pass(db, now=late_tonight.astimezone(UTC))

        assert spy_aws == [], "a $0.01 Cost Explorer call was made against fresh data"
        assert stats["aws_skipped_fresh"] == 1

    def test_the_midnight_tick_syncs_yesterdays_row(self, db, spy_aws, no_stripe):
        """23:30 yesterday is a different ET day at 00:00 — the midnight pass
        runs even though the row is only 30 minutes old. Midnight IS the
        schedule, not a 24-hour cooldown."""
        et = ZoneInfo("America/New_York")
        midnight = datetime.now(et).replace(hour=0, minute=0, second=30, microsecond=0)
        last_night = midnight - timedelta(minutes=31)  # 23:29:30 the previous ET day
        add_expense(db, source="aws", updated_at=last_night.astimezone(UTC))
        sync_costs.run_sync_pass(db, now=midnight.astimezone(UTC))
        assert spy_aws == [2]

    def test_force_aws_bypasses_the_daily_gate(self, db, spy_aws, no_stripe):
        """The operator's fresh-report lever: --force-aws spends the $0.01 even
        when today's sync already happened — routine window, never backfill."""
        add_expense(db, source="aws", updated_at=datetime.now(UTC))
        sync_costs.run_sync_pass(db, force_aws=True)
        assert spy_aws == [2]

    def test_created_at_stands_in_when_updated_at_is_null(self, db, spy_aws, no_stripe):
        add_expense(
            db,
            source="aws",
            created_at=datetime.now(UTC) - timedelta(hours=2),
            updated_at=None,
        )
        sync_costs.run_sync_pass(db)
        assert spy_aws == []

    def test_rows_from_other_sources_do_not_count_as_an_aws_sync(self, db, spy_aws, no_stripe):
        add_expense(db, source="estimate", updated_at=datetime.now(UTC))
        add_expense(db, source="stripe", vendor="Stripe fees", updated_at=datetime.now(UTC))
        sync_costs.run_sync_pass(db)
        assert spy_aws == [13]

    def test_a_pass_writes_what_it_fetched(self, db, spy_aws, no_stripe):
        add_expense(db, source="estimate")
        stats = sync_costs.run_sync_pass(db)

        assert stats["created"] == 1
        assert stats["superseded"] == 1
        row = db.query(Expense).filter(Expense.source == "aws").one()
        assert Decimal(str(row.amount)) == Decimal("37.07")


class TestPassBehaviour:
    def test_stripe_syncs_every_pass_when_a_key_is_set(self, db, monkeypatch):
        calls: list[str] = []

        def fake(secret_key):
            calls.append(secret_key)
            return []

        monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_key")
        monkeypatch.setattr(sync_costs, "fetch_stripe_fee_lines", fake)
        monkeypatch.setattr(sync_costs, "fetch_aws_cost_lines", lambda months_back=2: [])

        sync_costs.run_sync_pass(db)
        sync_costs.run_sync_pass(db)
        assert calls == ["sk_test_key", "sk_test_key"]

    def test_no_stripe_key_means_no_stripe_call(self, db, monkeypatch, no_stripe):
        def explode(secret_key):
            raise AssertionError("Stripe was called without a key")

        monkeypatch.setattr(sync_costs, "fetch_stripe_fee_lines", explode)
        monkeypatch.setattr(sync_costs, "fetch_aws_cost_lines", lambda months_back=2: [])
        sync_costs.run_sync_pass(db)

    def test_an_unavailable_source_is_a_warning_not_a_traceback(
        self, db, monkeypatch, caplog, no_stripe
    ):
        def unavailable(months_back=2):
            raise CostSourceUnavailable("AWS Cost Explorer unavailable (NoCredentialsError)")

        monkeypatch.setattr(sync_costs, "fetch_aws_cost_lines", unavailable)
        with caplog.at_level("WARNING"):
            stats = sync_costs.run_sync_pass(db)

        assert stats["unavailable"] == 1
        assert "NoCredentialsError" in caplog.text
        assert "Traceback" not in caplog.text

    def test_one_dead_source_does_not_stop_the_other(self, db, monkeypatch):
        monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_key")

        def dead(secret_key):
            raise CostSourceUnavailable("could not reach Stripe (ConnectError)")

        monkeypatch.setattr(sync_costs, "fetch_stripe_fee_lines", dead)
        monkeypatch.setattr(sync_costs, "fetch_aws_cost_lines", lambda months_back=2: [aws_line()])

        stats = sync_costs.run_sync_pass(db)
        assert stats["unavailable"] == 1
        assert stats["created"] == 1

    def test_a_not_yet_migrated_schema_skips_the_pass_quietly(
        self, db, monkeypatch, caplog, no_stripe
    ):
        """The api entrypoint runs `alembic upgrade head` and nothing orders
        this loop after it — same window send_reminders hit on its first boot."""

        def missing(*args, **kwargs):
            raise ProgrammingError(
                "SELECT expenses.source",
                {},
                Exception("column expenses.source does not exist"),
            )

        monkeypatch.setattr(sync_costs, "aws_months_to_fetch", missing)
        with caplog.at_level("WARNING"):
            stats = sync_costs.run_sync_pass(db)

        assert stats["schema_missing"] == 1
        assert "not migrated" in caplog.text

    def test_a_real_database_error_still_raises(self, db, monkeypatch, no_stripe):
        def broken(*args, **kwargs):
            raise ProgrammingError("SELECT 1", {}, Exception("syntax error at or near"))

        monkeypatch.setattr(sync_costs, "aws_months_to_fetch", broken)
        with pytest.raises(ProgrammingError):
            sync_costs.run_sync_pass(db)


# ---------------------------------------------------------------------------
# 2026-08-11 review fixes — each class guards one confirmed finding
# ---------------------------------------------------------------------------


class TestMailCarveOut:
    """Pre-tagging months: the mail box's share is ALLOCATED out of the real
    'Other' total — never added on top — prorated from the box's birth."""

    def _response(self, month="2026-08-01", other="37.25", groups=None):
        return {
            "ResultsByTime": [
                {
                    "TimePeriod": {"Start": month, "End": "2026-09-01"},
                    "Groups": groups
                    if groups is not None
                    else [
                        {
                            "Keys": ["Application$"],
                            "Metrics": {"UnblendedCost": {"Amount": other}},
                        }
                    ],
                }
            ]
        }

    def test_august_carve_is_prorated_and_subtracted(self):
        lines = aws_source._lines_from_response(self._response(), date(2026, 8, 11))
        by_vendor = {(line.vendor, line.source): line for line in lines}
        carve = by_vendor[("AWS - Mail Server", "estimate")]
        # Aug 1..Aug 11 inclusive = 11 days × $0.35/day.
        assert carve.amount == Decimal("3.85")
        assert carve.category == "email"
        other = by_vendor[("AWS - Other", "aws")]
        assert other.amount + carve.amount == Decimal("37.25")

    def test_no_carve_before_the_box_existed(self):
        lines = aws_source._lines_from_response(
            self._response(month="2026-07-01", other="51.88"), date(2026, 8, 11)
        )
        assert [line.vendor for line in lines] == ["AWS - Other"]
        assert lines[0].amount == Decimal("51.88")

    def test_no_carve_when_a_tagged_mail_actual_exists(self):
        groups = [
            {"Keys": ["Application$circuits-mail"], "Metrics": {"UnblendedCost": {"Amount": "4.10"}}},
            {"Keys": ["Application$"], "Metrics": {"UnblendedCost": {"Amount": "30.00"}}},
        ]
        lines = aws_source._lines_from_response(
            self._response(groups=groups), date(2026, 8, 20)
        )
        estimates = [line for line in lines if line.source == "estimate"]
        assert estimates == []

    def test_carve_is_capped_by_what_other_actually_holds(self):
        lines = aws_source._lines_from_response(
            self._response(other="2.00"), date(2026, 8, 31)
        )
        carve = next(line for line in lines if line.source == "estimate")
        assert carve.amount == Decimal("2.00")  # min(10.85, 2.00)
        # 'Other' reduced to zero is a zero line — dropped, not written.
        assert all(line.vendor != "AWS - Other" for line in lines)


class TestReconciliation:
    """The zero-ratchet: a month the snapshot stopped reporting loses its row."""

    def test_a_credited_to_zero_month_loses_its_stale_row(self, db):
        upsert_synced_costs(db, [aws_line("12.40")])
        stats = upsert_synced_costs(
            db, [aws_line("9.99", start=JULY, end=JULY_END)], reconcile_source="aws"
        )
        assert stats["reconciled"] == 1
        assert db.query(Expense).filter(Expense.period_start == AUGUST).count() == 0

    def test_reconcile_never_touches_manual_or_estimate_rows(self, db):
        add_expense(db, source="manual", vendor="Hand Typed")
        add_expense(db, source="estimate", vendor="Amazon Web Services")
        stats = upsert_synced_costs(
            db, [aws_line("9.99", start=AUGUST, end=AUGUST_END, vendor="AWS - Other")],
            reconcile_source="aws",
        )
        assert stats["reconciled"] == 0
        assert db.query(Expense).filter(Expense.source == "manual").count() == 1
        # The AWS actual supersedes the infrastructure estimate — that is the
        # SUPERSEDE rule doing its job, distinct from reconciliation.
        assert stats["superseded"] == 1

    def test_months_outside_the_snapshot_window_are_left_alone(self, db):
        upsert_synced_costs(db, [aws_line("30.00", start=JULY, end=JULY_END)])
        stats = upsert_synced_costs(db, [aws_line("10.00")], reconcile_source="aws")
        # The snapshot covered August only — July's absence says nothing.
        assert stats["reconciled"] == 0
        assert db.query(Expense).filter(Expense.period_start == JULY).count() == 1


class TestOwnershipOnEdit:
    """Editing a synced row takes ownership; deleting one is refused."""

    def _mint_synced(self, db):
        upsert_synced_costs(db, [aws_line("37.25", vendor="AWS - Circuit Center")])
        return db.query(Expense).filter(Expense.vendor == "AWS - Circuit Center").one()

    def test_patch_promotes_a_synced_row_to_manual(self, client, seeded_db, auth_header, db):
        row = self._mint_synced(db)
        resp = client.patch(
            f"/api/admin/expenses/{row.id}", json={"amount": "52.10"}, headers=auth_header()
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["source"] == "manual"
        # The point of promotion: the next sync pass leaves the human's number.
        upsert_synced_costs(db, [aws_line("37.25", vendor="AWS - Circuit Center")])
        db.expire_all()
        survivors = db.query(Expense).filter(Expense.vendor == "AWS - Circuit Center").all()
        owned = [r for r in survivors if r.source == "manual"]
        assert len(owned) == 1 and Decimal(str(owned[0].amount)) == Decimal("52.10")

    def test_delete_of_a_synced_row_is_a_409_with_a_string_detail(
        self, client, seeded_db, auth_header, db
    ):
        row = self._mint_synced(db)
        resp = client.delete(f"/api/admin/expenses/{row.id}", headers=auth_header())
        assert resp.status_code == 409
        assert isinstance(resp.json()["detail"], str)  # apiErrorDetail contract
        assert db.query(Expense).filter(Expense.id == row.id).count() == 1

    def test_manual_and_estimate_rows_still_delete(self, client, seeded_db, auth_header, db):
        manual = add_expense(db, source="manual")
        estimate = add_expense(db, source="estimate", vendor="Amazon Web Services", period_start=JULY)
        for row in (manual, estimate):
            resp = client.delete(f"/api/admin/expenses/{row.id}", headers=auth_header())
            assert resp.status_code == 204


class TestStripeFeeTypeTransactions:
    """Billing/Tax post their cost as type='stripe_fee' rows with fee=0 and a
    NEGATIVE amount — counting only `fee` missed every one of them."""

    def test_stripe_fee_rows_are_counted_by_their_amount(self):
        august = int(datetime(2026, 8, 5, tzinfo=UTC).timestamp())

        def handler(request):
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"id": "txn_1", "fee": 59, "amount": 1000, "type": "charge", "created": august},
                        {"id": "txn_2", "fee": 0, "amount": -130, "type": "stripe_fee", "created": august},
                    ],
                    "has_more": False,
                },
            )

        lines = fetch_stripe_fee_lines(
            "sk_test_x",
            transport=httpx.MockTransport(handler),
            now=datetime(2026, 8, 11, tzinfo=UTC),
        )
        assert len(lines) == 1
        assert lines[0].amount == Decimal("1.89")  # 59¢ + 130¢
