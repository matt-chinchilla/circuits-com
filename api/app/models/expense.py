"""Operating expenses — the cost side of the admin dashboard's P&L view.

Mirrors ``models/revenue.py`` (UUID PK, Numeric(10,2) amount, a
``period_start``/``period_end`` Date range, created_at) so the two feed the same
month/day bucketing helpers in ``routes/dashboard.py``. Rows are monthly
recurring costs (AWS, domain, SMTP, payment processing, LLM usage); the seed
plants the last three months and ``/api/admin/expenses`` is the admin CRUD.

``category`` is a plain ``String`` rather than a Postgres ``Enum`` on purpose:
the category set is expected to grow (adding a value to a native enum needs an
``ALTER TYPE`` migration, and Postgres enum values cannot be removed at all).
The allowed set is enforced at the API boundary instead — ``schemas/expense.py``
types it as a ``Literal`` so a bad value is a clean 422 — with
``EXPENSE_CATEGORIES`` below as the single source of truth for both.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import Column, Date, DateTime, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID

from app.db.session import Base

# The allowed `Expense.category` values. Single home — `schemas/expense.py`
# builds its Literal from this, and `routes/dashboard.py` labels from the map.
EXPENSE_CATEGORIES: tuple[str, ...] = (
    "infrastructure",
    "ai",
    "email",
    "domain",
    "payment",
    "other",
)

# Display labels for the breakdown endpoint / expense charts. Keys must stay in
# sync with EXPENSE_CATEGORIES (guarded by tests/test_expenses.py).
EXPENSE_CATEGORY_LABELS: dict[str, str] = {
    "infrastructure": "Infrastructure",
    "ai": "AI / LLM",
    "email": "Email",
    "domain": "Domain",
    "payment": "Payment Processing",
    "other": "Other",
}


# `Expense.source` values. 'manual' is the ONLY one a human ever writes (it is
# the column default and the admin CRUD cannot set the field at all), which is
# what lets a sync say "never touch rows I did not write" as a query filter
# rather than as a convention.
MANUAL_SOURCE = "manual"
ESTIMATE_SOURCE = "estimate"


def expense_category_label(category: str | None) -> str:
    """Human label for a stored category value; unknown values pass through
    title-cased so a hand-inserted row never renders as an empty cell."""
    key = (category or "").strip().lower()
    return EXPENSE_CATEGORY_LABELS.get(key, key.replace("_", " ").title() or "Other")


class Expense(Base):
    __tablename__ = "expenses"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    category = Column(String(30), nullable=False)
    vendor = Column(String(120), nullable=True)
    amount = Column(Numeric(10, 2), nullable=False)
    description = Column(Text, nullable=True)
    # Indexed because the dashboard buckets by period_start (migration 020).
    period_start = Column(Date, nullable=False, index=True)
    period_end = Column(Date, nullable=False)
    # WHO wrote this row (migration 026). Server-controlled: the admin CRUD
    # schemas do not accept it, so anything a human types stays 'manual' and is
    # never overwritten by a sync. `app/services/cost_sources/` writes 'aws',
    # 'stripe' and (later) 'anthropic'; `db/seed.py` writes 'estimate' for the
    # list-price AWS figure, which a real 'aws' actual for the same month
    # SUPERSEDES — keeping both would double-count the same bill.
    #
    # A plain VARCHAR with a server_default rather than an enum, for the same
    # reason `category` is: the set will grow, and a row inserted by hand in
    # psql must land somewhere sane rather than violating NOT NULL.
    source = Column(String(20), nullable=False, server_default="manual", default=MANUAL_SOURCE)
    # WHOSE book this row belongs to (migration 045). NULL = Circuit Center's
    # own operating cost, which is every row the seed, the cost sync and the
    # admin CRUD have ever written; a uuid = a CUSTOMER's private cost line,
    # visible only in their console. The staff list filters `IS NULL` so the
    # company's books never mix the two.
    #
    # Plain UUID, NO ForeignKey to users, and that is load-bearing rather than
    # lazy: `users` sits inside deploy.sh --reseed's TRUNCATE CASCADE graph
    # (users.supplier_id -> suppliers), and TRUNCATE CASCADE is table-level and
    # transitive, so an FK here would drag `expenses` into the cascade and a
    # routine reseed would delete the whole cost history. Ownership is set at
    # the write site and cleaned up explicitly by DELETE /api/admin/users/{id}.
    # Guard: tests/test_leads_schema.py's census, tests/test_outbound_clicks.py.
    user_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
    )
    # Mirrors models/sponsor.py. The cost-sync job's staleness gate reads this
    # (falling back to created_at) to decide whether the once-a-day, $0.01-per-
    # call Cost Explorer request is due — so `upsert_synced_costs` stamps it
    # EXPLICITLY on every touch rather than relying on `onupdate`, which does
    # not fire when a re-sync writes the identical amount.
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        nullable=True,
    )
