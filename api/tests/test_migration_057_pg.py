"""Migration 057 on a real Postgres — the partial unique index and the backfill.

SQLite (the rest of the suite) builds the schema from the MODELS; this runs 057's
real ``upgrade()`` inside a transaction that is always rolled back, so the hold
index and the ``sponsor_billing`` backfill are proven on the engine prod runs.
Skips when the local stack is down; refuses a non-local host (pg_harness).
"""

from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from .pg_harness import postgres_engine

MIGRATION_PATH = (
    Path(__file__).resolve().parents[1] / "alembic" / "versions" / "057_gold_platinum_sales.py"
)
NEW_TABLES = (
    "billing_audit",
    "sponsor_payments",
    "sponsor_billing",
    "checkout_intents",
    "sales_codes",
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("migration_057", MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(conn, fn_name: str) -> None:
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    ctx = MigrationContext.configure(conn)
    with Operations.context(ctx):
        getattr(_load_migration(), fn_name)()


@pytest.fixture(scope="module")
def world():
    """057 applied once over the local database, with one subscription-owned
    sponsor seeded BEFORE the upgrade so the backfill has something to find."""
    engine = postgres_engine()
    connection = engine.connect()
    transaction = connection.begin()
    try:
        # A local DB already migrated past 056 would otherwise make upgrade()
        # die on "already exists"; inside this transaction the drop is undone.
        for table in NEW_TABLES:
            connection.execute(text(f"DROP TABLE IF EXISTS {table} CASCADE"))

        supplier_id = uuid.uuid4()
        sponsor_id = uuid.uuid4()
        unbilled_id = uuid.uuid4()
        sub_id = f"sub_harness_{uuid.uuid4().hex[:12]}"
        connection.execute(
            text("INSERT INTO suppliers (id, name) VALUES (:id, 'Harness 057 Co')"),
            {"id": supplier_id},
        )
        connection.execute(
            text(
                "INSERT INTO sponsors (id, supplier_id, keyword, tier, status, amount, "
                "stripe_subscription_id) VALUES (:id, :sup, :kw, 'Silver', 'Active', 210.00, :sub)"
            ),
            {
                "id": sponsor_id,
                "sup": supplier_id,
                "kw": f"h057-{sponsor_id.hex[:8]}",
                "sub": sub_id,
            },
        )
        connection.execute(
            text(
                "INSERT INTO sponsors (id, supplier_id, keyword, tier, status) "
                "VALUES (:id, :sup, :kw, 'Silver', 'Active')"
            ),
            {"id": unbilled_id, "sup": supplier_id, "kw": f"h057-{unbilled_id.hex[:8]}"},
        )
        _run(connection, "upgrade")
        yield {
            "conn": connection,
            "sponsor_id": sponsor_id,
            "unbilled_id": unbilled_id,
            "sub_id": sub_id,
        }
    finally:
        transaction.rollback()
        connection.close()
        engine.dispose()


def _open_intent(conn, category_id: uuid.UUID, *, tier: str = "gold", status: str = "open"):
    conn.execute(
        text(
            "INSERT INTO checkout_intents (id, tier, category_id, list_usd, founder_usd, "
            "price_usd, channel, company_name, email, status, expires_at) VALUES "
            "(:id, :tier, :cat, 2500, 2100, 2100, 'self_serve', 'Acme', 'a@acme.test', "
            ":status, now() + interval '45 minutes')"
        ),
        {"id": uuid.uuid4(), "tier": tier, "cat": category_id, "status": status},
    )


def test_the_index_refuses_a_second_open_exclusive_hold(world):
    conn = world["conn"]
    cat = uuid.uuid4()
    _open_intent(conn, cat)
    savepoint = conn.begin_nested()
    with pytest.raises(IntegrityError):
        _open_intent(conn, cat, tier="platinum")
    savepoint.rollback()


def test_a_lapsed_hold_and_silver_intents_do_not_block(world):
    conn = world["conn"]
    cat = uuid.uuid4()
    _open_intent(conn, cat, status="expired")
    _open_intent(conn, cat)
    _open_intent(conn, cat, tier="silver")
    _open_intent(conn, cat, tier="silver")
    count = conn.execute(
        text("SELECT count(*) FROM checkout_intents WHERE category_id = :c"), {"c": cat}
    ).scalar_one()
    assert count == 4


def test_the_index_is_the_partial_one_the_model_declares(world):
    definition = (
        world["conn"]
        .execute(
            text("SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_live_exclusive_intent'")
        )
        .scalar_one()
    )
    assert "UNIQUE" in definition and "(category_id)" in definition
    assert "'open'" in definition and "'gold'" in definition and "'platinum'" in definition


def test_a_subscription_owned_sponsor_gets_exactly_one_billing_row(world):
    rows = (
        world["conn"]
        .execute(
            text(
                "SELECT stripe_subscription_id, collection_method, channel, list_usd, "
                "price_usd, founder_usd, card_link_version, void_pending "
                "FROM sponsor_billing WHERE sponsor_id = :s"
            ),
            {"s": world["sponsor_id"]},
        )
        .all()
    )
    assert rows == [
        (world["sub_id"], "charge_automatically", "self_serve", 250, 210, None, 0, False)
    ]


def test_backfilled_rows_are_already_past_post_activation(world):
    """The sweep's post-activation step moves the card off the subscription. A
    live pre-057 subscription must NOT be touched just because we deployed —
    its card moves only when a rep opens a card link (spec R14)."""
    done = (
        world["conn"]
        .execute(
            text("SELECT post_activation_done_at FROM sponsor_billing WHERE sponsor_id = :s"),
            {"s": world["sponsor_id"]},
        )
        .scalar_one()
    )
    assert done is not None


def test_a_sponsor_without_a_subscription_gets_none(world):
    count = (
        world["conn"]
        .execute(
            text("SELECT count(*) FROM sponsor_billing WHERE sponsor_id = :s"),
            {"s": world["unbilled_id"]},
        )
        .scalar_one()
    )
    assert count == 0


def test_the_backfill_is_rerunnable(world):
    conn = world["conn"]
    conn.execute(text(_load_migration().BACKFILL_BILLING))
    count = conn.execute(
        text("SELECT count(*) FROM sponsor_billing WHERE sponsor_id = :s"),
        {"s": world["sponsor_id"]},
    ).scalar_one()
    assert count == 1


def test_billing_cascades_with_its_sponsor(world):
    conn = world["conn"]
    savepoint = conn.begin_nested()
    conn.execute(text("DELETE FROM sponsors WHERE id = :s"), {"s": world["sponsor_id"]})
    left = conn.execute(
        text("SELECT count(*) FROM sponsor_billing WHERE sponsor_id = :s"),
        {"s": world["sponsor_id"]},
    ).scalar_one()
    savepoint.rollback()
    assert left == 0


def test_checks_hold_on_postgres(world):
    conn = world["conn"]
    for points, max_uses in ((0, 1), (16, 1), (5, 0)):
        savepoint = conn.begin_nested()
        with pytest.raises(IntegrityError):
            conn.execute(
                text(
                    "INSERT INTO sales_codes (id, code, code_points, max_uses, rep, created_by) "
                    "VALUES (:id, :code, :pts, :mu, 'Daniel', 'Daniel')"
                ),
                {"id": uuid.uuid4(), "code": uuid.uuid4().hex[:8], "pts": points, "mu": max_uses},
            )
        savepoint.rollback()


def test_downgrade_removes_every_table(world):
    conn = world["conn"]
    savepoint = conn.begin_nested()
    _run(conn, "downgrade")
    left = [
        t
        for t in NEW_TABLES
        if conn.execute(text("SELECT to_regclass(:t)"), {"t": t}).scalar_one() is not None
    ]
    savepoint.rollback()
    assert left == []
