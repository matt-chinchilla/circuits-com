"""Admin CRUD for the expenses table (/api/admin/expenses).

The cost side of the dashboard P&L. Rows are monthly recurring operating
costs — AWS hosting, the domain registration, SMTP, payment-processor fees,
LLM usage — each pinned to a `period_start`/`period_end` month like `revenue`.

STAFF-only, like the rest of /admin/*: the router carries
Depends(require_staff), so a customer account gets 403 staff_only. Shape and
conventions mirror `admin_sponsors.py`: trailing-slash collection routes (axios
follows FastAPI's 307), a UUID path-param parse that degrades to 404, and
`model_dump(exclude_unset=True)` on PATCH so an omitted field is untouched.

THE COMPANY'S BOOKS ARE THE COMPANY'S ROWS (migration 045). `expenses` now also
holds CUSTOMERS' private cost lines, marked by a non-NULL `user_id`, so every
read here filters `user_id IS NULL`. Staff being staff is not the question: a
customer's operating costs are their business, they are not Circuit Center's
spend, and summing them into this company's P&L would be wrong even if the
privacy were not. Those rows will carry `source='manual'`, which is also what
keeps the cost sync's `reconcile_source` from ever deleting them — it only
removes rows written by the source it is reconciling, and a human's row is
never that.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Expense, User
from app.schemas.expense import ExpenseCreate, ExpenseResponse, ExpenseUpdate
from app.services.auth_service import get_current_user, require_staff

router = APIRouter(
    prefix="/api/admin/expenses",
    tags=["admin-expenses"],
    # The customer/staff wall (D16) sits on the router: everything served
    # here is company-wide STAFF data, so an activated customer is refused
    # with 403 staff_only rather than admitted as a console user. It COMPOSES
    # with the per-route get_current_user gates — it does not replace them.
    dependencies=[Depends(require_staff)],
)


def _parse_expense_id(expense_id: str) -> uuid.UUID:
    """Path-param id → UUID. A malformed id is treated as not-found (404).

    Expense.id is a UUID column; under SQLite the ORM needs a real UUID to build
    the WHERE clause (a bare str throws "'str' has no attribute 'hex'").
    """
    try:
        return uuid.UUID(expense_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=404, detail="Expense not found") from None


def _get_or_404(db: Session, expense_id: str) -> Expense:
    """A company row, by id. A customer's row is 404 here, not 403.

    The same `user_id IS NULL` filter the list uses, on purpose: this
    collection is Circuit Center's cost book, and as far as it is concerned a
    customer's private line is not in it. Answering 403 would confirm the id
    names something.
    """
    expense = (
        db.query(Expense)
        .filter(Expense.id == _parse_expense_id(expense_id), Expense.user_id.is_(None))
        .first()
    )
    if not expense:
        raise HTTPException(status_code=404, detail="Expense not found")
    return expense


@router.get("/", response_model=list[ExpenseResponse])
def list_expenses(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """The COMPANY's rows, newest period first — stable ordering for the table.

    `user_id IS NULL` is the company/customer split; see the module docstring.
    """
    return (
        db.query(Expense)
        .filter(Expense.user_id.is_(None))
        .order_by(Expense.period_start.desc(), Expense.created_at.desc())
        .all()
    )


@router.post("/", response_model=ExpenseResponse)
def create_expense(
    body: ExpenseCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if body.period_end < body.period_start:
        raise HTTPException(status_code=422, detail="period_end must not precede period_start.")

    expense = Expense(id=uuid.uuid4(), **body.model_dump())
    db.add(expense)
    db.commit()
    db.refresh(expense)
    return expense


@router.patch("/{expense_id}", response_model=ExpenseResponse)
def update_expense(
    expense_id: str,
    body: ExpenseUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    expense = _get_or_404(db, expense_id)
    update_data = body.model_dump(exclude_unset=True)

    # `vendor`/`description` are nullable, so an explicit null legitimately
    # CLEARS them. The other four back NOT NULL columns — an explicit null there
    # would only surface as a 500 IntegrityError at commit, so reject it as 422.
    nulled_required = [
        field
        for field in ("category", "amount", "period_start", "period_end")
        if field in update_data and update_data[field] is None
    ]
    if nulled_required:
        raise HTTPException(
            status_code=422,
            detail=f"These fields cannot be null: {', '.join(sorted(nulled_required))}.",
        )

    # Validate the POST-UPDATE range so a partial PATCH that moves only one
    # endpoint can't invert the period.
    new_start = update_data.get("period_start", expense.period_start)
    new_end = update_data.get("period_end", expense.period_end)
    if new_start is not None and new_end is not None and new_end < new_start:
        raise HTTPException(status_code=422, detail="period_end must not precede period_start.")

    for key, value in update_data.items():
        setattr(expense, key, value)

    # Editing a machine-written row TAKES OWNERSHIP: promoted to 'manual', the
    # sync's own rule (never touch manual) protects the human's number from
    # being silently reverted an hour later — and a changed vendor can no
    # longer make the next pass insert a duplicate beside it. Without this,
    # ownership was decided at INSERT only, and a PATCH left the row wearing
    # a source label the sync still considered its own.
    if update_data and expense.source != "manual":
        expense.source = "manual"

    db.commit()
    db.refresh(expense)
    return expense


@router.delete("/{expense_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_expense(
    expense_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    expense = _get_or_404(db, expense_id)
    if expense.source not in ("manual", "estimate"):
        # Deleting a synced row is futile — the next pass re-creates it within
        # the hour — so refuse loudly instead of silently un-deleting later.
        # (Estimates ARE deletable: the seed's get_or_create only re-plants
        # them on an empty month, and the sync supersedes them anyway.)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"This row is written by the {expense.source} sync and would be "
                "re-created within the hour. Edit it instead — editing takes "
                "ownership and the sync stops touching it."
            ),
        )
    db.delete(expense)
    db.commit()
