"""The customer's own expense book — /api/account/expenses.

One table, two books. ``expenses.user_id`` NULL is CIRCUIT CENTER'S OWN
operating cost (every seed row, every cost-sync row, every admin entry) and a
populated value is exactly one customer's private cost line. This router is the
customer's door; ``routes/admin_expenses`` is the company's, and neither ever
opens onto the other side of that line.

Four things here are decisions, not defaults.

**A row that is not yours is 404, never 403.** A 403 says "it exists and you
may not have it", which is an existence oracle for expense ids. Every
id-addressed handler resolves the row THROUGH ``expenses_owned_by``, so another
customer's row, the company's own NULL-owner rows, and an id that was never
created produce the identical reply. There is no branch that could be made to
answer differently, because there is no branch.

**``source`` is server-set to 'manual' and is not in any request body.** That
string is load-bearing beyond bookkeeping: ``upsert_synced_costs``'s
``reconcile_source`` DELETES the rows a source stopped reporting, and 'manual'
is the one label no sync ever reconciles. A client that could name its own
source could label a row 'aws' and have the next hourly pass delete it.

**``user_id`` is server-set from the scope, never from the body.** Same reason
``extra="forbid"`` is on both bodies: a request naming ``user_id`` or ``source``
is REFUSED rather than quietly dropped, because a silently-ignored field lets a
client believe it worked.

**``amount`` leaves here as a JSON NUMBER.** ``Decimal`` through Pydantic
serializes to a STRING, at which point the console sorts "9999.00" before
"2500.00" and adds costs by concatenating them. The admin CRUD ships the string
(its TS coerces); this surface is new and does not have to inherit that.
"""

import uuid
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Expense
from app.models.expense import MANUAL_SOURCE
from app.services.account_scope import AccountScope, account_scope, expenses_owned_by

router = APIRouter(
    prefix="/api/account",
    tags=["account-expenses"],
    # Every route here is scoped, so the scope dependency IS the gate: it
    # resolves through require_account_user, which refuses staff and refuses an
    # unactivated customer (D17). A route in this file cannot forget it.
    dependencies=[Depends(account_scope)],
)

# The one reply for "not yours" and for "no such row" alike. A single constant
# so the two can never drift into distinguishable bodies.
EXPENSE_NOT_FOUND_DETAIL = "expense_not_found"

# `expenses.category` is VARCHAR(30). The staff CRUD narrows it to a Literal of
# the six house categories; a customer's book is THEIRS, so this is free text
# with the column's own limit as the only ceiling. It is stored trimmed and
# lowercased because every reader groups on it — `operating-costs` already does
# `.strip().lower()` — and "Travel" beside "travel" is two rows in one chart.
CATEGORY_MAX = 30

# `expenses.vendor` is VARCHAR(120).
VENDOR_MAX = 120

# What the NUMERIC(10,2) column can actually hold. Enforced here so an
# over-precise or oversized figure is a clean 422 rather than a silent rescale
# (Postgres rounds a third decimal away; SQLite keeps it) or a 500 at commit.
AMOUNT_MAX_DIGITS = 10
AMOUNT_DECIMAL_PLACES = 2


def _clean_category(value: str | None) -> str | None:
    # None passes through: on the PATCH body it means "explicitly cleared",
    # which the route answers with its own 422 naming the field, rather than
    # an AttributeError from here.
    if value is None:
        return None
    text = value.strip().lower()
    if not 1 <= len(text) <= CATEGORY_MAX:
        raise ValueError(f"category must be 1-{CATEGORY_MAX} characters")
    return text


def _clean_optional_text(value: str | None) -> str | None:
    """Blank is absent. A vendor of "   " is not a vendor, and storing it makes
    the console render an empty cell where it checks for None."""
    if value is None:
        return None
    return value.strip() or None


class ExpenseIn(BaseModel):
    """A new row in the caller's book.

    ``extra="forbid"``: ``user_id`` and ``source`` are the two fields whose
    silent acceptance would matter, and forbidding everything unknown means
    neither needs to be enumerated here to be refused.
    """

    model_config = ConfigDict(extra="forbid")

    category: str
    amount: Decimal = Field(
        gt=0, max_digits=AMOUNT_MAX_DIGITS, decimal_places=AMOUNT_DECIMAL_PLACES
    )
    period_start: date
    vendor: str | None = Field(default=None, max_length=VENDOR_MAX)
    description: str | None = None
    # Defaulted to period_start in the route, not here: a default that read the
    # other field would need a model validator anyway, and this way the PATCH
    # body below can keep the same field meaning "leave it alone".
    period_end: date | None = None

    _category = field_validator("category")(_clean_category)
    _vendor = field_validator("vendor")(_clean_optional_text)
    _description = field_validator("description")(_clean_optional_text)


class ExpensePatch(BaseModel):
    """A partial edit. Omitted means untouched; explicit null means CLEAR, and
    only on the two nullable columns — see ``NULLABLE_FIELDS``."""

    model_config = ConfigDict(extra="forbid")

    category: str | None = None
    amount: Decimal | None = Field(
        default=None, gt=0, max_digits=AMOUNT_MAX_DIGITS, decimal_places=AMOUNT_DECIMAL_PLACES
    )
    period_start: date | None = None
    period_end: date | None = None
    vendor: str | None = Field(default=None, max_length=VENDOR_MAX)
    description: str | None = None

    _category = field_validator("category")(_clean_category)
    _vendor = field_validator("vendor")(_clean_optional_text)
    _description = field_validator("description")(_clean_optional_text)


# The only two columns an explicit null legitimately clears. The other four back
# NOT NULL columns, where a null would surface as a 500 IntegrityError at commit
# instead of a 422 the caller can act on.
NULLABLE_FIELDS = ("vendor", "description")


def _projection(expense: Expense) -> dict:
    return {
        "id": str(expense.id),
        "category": expense.category,
        "vendor": expense.vendor,
        # round() rather than a bare float(): a NUMERIC(10,2) is exact and the
        # float cast is not, and this figure is money on a customer's screen.
        "amount": round(float(expense.amount), AMOUNT_DECIMAL_PLACES),
        "description": expense.description,
        "period_start": expense.period_start,
        "period_end": expense.period_end,
    }


def _my_expense(db: Session, scope: AccountScope, expense_id: str) -> Expense:
    """Resolve an id THROUGH the scope, or 404.

    The ownership filter and the lookup are ONE query on purpose: a two-step
    "fetch then compare" is where an ownership check gets forgotten, inverted,
    or turned into a 403. A malformed uuid takes the same exit — under SQLite
    the ORM needs a real UUID to build the WHERE clause at all.
    """
    try:
        parsed = uuid.UUID(expense_id)
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=EXPENSE_NOT_FOUND_DETAIL
        ) from None
    expense = db.query(Expense).filter(Expense.id == parsed, expenses_owned_by(scope)).first()
    if expense is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=EXPENSE_NOT_FOUND_DETAIL)
    return expense


def _check_period(period_start: date, period_end: date) -> None:
    if period_end < period_start:
        raise HTTPException(
            status_code=422,
            detail="period_end must not precede period_start.",
        )


@router.get("/expenses")
def list_my_expenses(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """This caller's own cost lines, newest period first.

    Keyed on the USER, not the company — a cost book belongs to the person who
    keeps it, exactly like the inbox. ``expenses_owned_by`` is an equality test
    and must stay one: the company's rows are the NULL ones, and an
    ``or_(... .is_(None))`` convenience here would publish Circuit Center's AWS
    bill to every customer console.

    Unpaginated, so ``total_count`` is the length of ``items``. It is in the
    envelope anyway because the console renders a count beside the table, and a
    client that counts the array itself is a client that breaks the day a
    ``?page=`` lands.
    """
    rows = (
        db.query(Expense)
        .filter(expenses_owned_by(scope))
        .order_by(Expense.period_start.desc(), Expense.created_at.desc(), Expense.id)
        .all()
    )
    items = [_projection(row) for row in rows]
    return {"items": items, "total_count": len(items)}


# 200, not 201: every other write in this codebase answers 200 with the row
# (admin_expenses, admin_sponsors, the inbox PATCH), and one endpoint
# disagreeing is how a client grows a status-code special case.
@router.post("/expenses")
def create_my_expense(
    body: ExpenseIn,
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """Add a line to the caller's own book.

    ``user_id`` comes from the scope and ``source`` is 'manual', both fixed
    here rather than accepted from the body — see the module docstring for why
    the second one is a data-integrity boundary and not a label.

    A missing ``period_end`` means a one-day period, not an open one: the column
    is NOT NULL, every reader buckets on ``period_start``, and a customer typing
    a single date means that date.
    """
    period_end = body.period_end if body.period_end is not None else body.period_start
    _check_period(body.period_start, period_end)

    expense = Expense(
        id=uuid.uuid4(),
        category=body.category,
        vendor=body.vendor,
        amount=body.amount,
        description=body.description,
        period_start=body.period_start,
        period_end=period_end,
        source=MANUAL_SOURCE,
        user_id=scope.user_id,
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)
    return _projection(expense)


@router.patch("/expenses/{expense_id}")
def update_my_expense(
    expense_id: str,
    body: ExpensePatch,
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """Edit one of MY lines. Ownership never moves — ``user_id`` and ``source``
    are not addressable, so an edited row stays this customer's manual row."""
    expense = _my_expense(db, scope, expense_id)
    updates = body.model_dump(exclude_unset=True)

    nulled_required = sorted(
        field for field, value in updates.items() if value is None and field not in NULLABLE_FIELDS
    )
    if nulled_required:
        raise HTTPException(
            status_code=422,
            detail=f"These fields cannot be null: {', '.join(nulled_required)}.",
        )

    # Validate the POST-update range, so a partial edit that moves only one
    # endpoint cannot invert the period.
    _check_period(
        updates.get("period_start", expense.period_start),
        updates.get("period_end", expense.period_end),
    )

    for key, value in updates.items():
        setattr(expense, key, value)
    db.commit()
    db.refresh(expense)
    return _projection(expense)


@router.delete("/expenses/{expense_id}")
def delete_my_expense(
    expense_id: str,
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """Remove one of MY lines.

    No 409 for a synced source, unlike the admin CRUD: nothing writes a
    customer-owned row except this router, so every row reachable here is a
    'manual' one the person typed themselves.
    """
    db.delete(_my_expense(db, scope, expense_id))
    db.commit()
    return {"status": "ok"}
