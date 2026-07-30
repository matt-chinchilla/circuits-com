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
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
    )
