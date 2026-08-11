"""Pydantic schemas for the admin Expense CRUD (/api/admin/expenses).

`amount` is a `Decimal`, which Pydantic v2 serializes to a JSON **string**
(e.g. "21.23") — same as AdminSponsorResponse.amount. Any TS consumer must
coerce with Number() before doing arithmetic (CLAUDE.md NUMERIC-string gotcha).
The /api/dashboard/* aggregates deliberately float()-cast instead, so those
return real JSON numbers.
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# Mirrors app.models.expense.EXPENSE_CATEGORIES (guarded by tests/test_expenses.py).
# A Literal here is what turns a bad category into a clean 422 — the column
# itself is a plain VARCHAR so the set can grow without an enum migration.
ExpenseCategory = Literal["infrastructure", "ai", "email", "domain", "payment", "other"]


class ExpenseResponse(BaseModel):
    id: UUID
    category: str
    vendor: str | None = None
    amount: Decimal
    description: str | None = None
    period_start: date
    period_end: date
    # Who wrote the row: 'manual' | 'estimate' | 'aws' | 'stripe' (migration
    # 026). READ-ONLY — deliberately absent from Create/Update below, because
    # a client that could set it could label a hand-typed number 'aws' and have
    # the next sync silently overwrite it. The column default keeps every row
    # the admin CRUD creates 'manual', which is what makes "a sync never
    # touches what a person typed" enforceable as a query filter.
    source: str = "manual"
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class ExpenseCreate(BaseModel):
    category: ExpenseCategory
    vendor: str | None = Field(default=None, max_length=120)
    amount: Decimal
    description: str | None = None
    period_start: date
    period_end: date


class ExpenseUpdate(BaseModel):
    """All-optional PATCH body — `model_dump(exclude_unset=True)` in the router
    means an omitted field is left untouched (vs. explicitly set to null)."""

    category: ExpenseCategory | None = None
    vendor: str | None = Field(default=None, max_length=120)
    amount: Decimal | None = None
    description: str | None = None
    period_start: date | None = None
    period_end: date | None = None
