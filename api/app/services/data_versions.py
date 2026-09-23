"""Change fingerprints for the admin console's persisted query cache.

Owner ask 2026-09-11: "a check that gets ran to see if the data has changed
since last being viewed" — the console keeps the last payload it saw and must
not re-run the dashboard's aggregations when nothing behind them moved.

One GET answers for every cached read: a short opaque hash per SCOPE, where a
scope is the set of tables a family of reads aggregates. The client stores the
scope hashes it saw alongside each payload and asks again before refetching;
equal means "serve what you have".

Postgres pays nothing for the answer: ``pg_stat_user_tables`` already keeps a
per-table count of inserted + updated + deleted rows (cumulative since the
last stats reset), so the fingerprint is a catalog read, not a scan of 570k
parts. Those counters are flushed by each backend at transaction end, at most
once a second, and within ~10s of the backend going idle — so ANOTHER
session's write can stay invisible for a few seconds. Accepted for dashboards
of daily trends; an operator's OWN write drops the client cache outright, so
it is never masked. TRUNCATE + reseed (fresh inserts) and a stats reset (the
counters drop) both read as "changed" — the safe direction.

Off Postgres (the SQLite test suite) the fallback is ``count(*)`` per table:
enough to prove the contract (an insert moves exactly its scope), blind to an
UPDATE, and never what prod runs.
"""

from __future__ import annotations

import hashlib

from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

# Scope → the tables whose rows the reads in that scope aggregate. The keys
# are the client's `DataScope` union in @admin/services/queryCache.ts
# (test_data_versions.py holds the two together); grow both at once.
SCOPES: dict[str, tuple[str, ...]] = {
    "catalog": (
        "parts",
        "part_listings",
        "price_breaks",
        "suppliers",
        "categories",
        "category_suppliers",
        "manufacturers",
        "supplier_badges",
        "badges",  # 055 — `founder` is derived from these now
    ),
    "traffic": ("page_views", "outbound_clicks"),
    # 057: the payments mirror and the staff-only billing audit are money;
    # a sponsor's billing row moves with its sponsor.
    "money": ("revenue", "expenses", "sponsor_payments", "billing_audit"),
    "sponsors": ("sponsors", "sponsor_billing"),
    "activity": ("activity_events",),
    "people": ("users",),
    "messages": ("messages",),
    "leads": ("leads", "lead_contacts"),
    # A table may sit in TWO scopes: the boards read the badge rows as part of
    # `catalog`, while the badge editor's own reads want a fingerprint that
    # moves on a grant WITHOUT the whole catalog (any part write) moving.
    "badges": ("badges", "supplier_badges"),
    # 057: the sales-codes page (codes, their open holds, Needs attention).
    "sales": ("sales_codes", "checkout_intents"),
}

_TABLES: tuple[str, ...] = tuple(sorted({t for tables in SCOPES.values() for t in tables}))

_PG_COUNTERS = text(
    "SELECT relname, n_tup_ins + n_tup_upd + n_tup_del AS writes "
    "FROM pg_stat_user_tables WHERE relname IN :names"
).bindparams(bindparam("names", expanding=True))


def _postgres_counters(db: Session) -> dict[str, int]:
    rows = db.execute(_PG_COUNTERS, {"names": list(_TABLES)}).all()
    return {str(name): int(writes) for name, writes in rows}


def _count_fallback(db: Session) -> dict[str, int]:
    # Table names come from the constant above, never from a request.
    return {t: int(db.execute(text(f"SELECT count(*) FROM {t}")).scalar() or 0) for t in _TABLES}


def write_counters(db: Session) -> dict[str, int]:
    """One integer per scoped table that moves whenever the table's rows do."""
    if db.get_bind().dialect.name == "postgresql":
        return _postgres_counters(db)
    return _count_fallback(db)


def data_versions(db: Session) -> dict[str, str]:
    """``{scope: 12-hex fingerprint}`` — equal to the last answer iff nothing in
    the scope's tables was written in between (see the module docstring for
    the flush lag). A table missing from the counters hashes as -1 so a
    dropped table still reads as a change rather than as silence."""
    counters = write_counters(db)
    versions: dict[str, str] = {}
    for scope, tables in SCOPES.items():
        raw = "|".join(f"{table}={counters.get(table, -1)}" for table in tables)
        versions[scope] = hashlib.sha1(raw.encode()).hexdigest()[:12]
    return versions
