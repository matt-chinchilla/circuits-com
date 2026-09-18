"""The customer's own badge — /api/account/badges (055).

A company that holds a badge decides how its fire LOOKS; it never decides that
it has one. The whole router is that sentence:

* **The body is `BadgeLookPatch`, not `StaffBadgePatch`.** `enabled` is the
  staff off-switch — the one field that decides whether the supplier reads as a
  founder at all — so it is not in the customer's shape, and `extra="forbid"`
  turns a body naming it into a 422 rather than a silent drop. `key` IS
  customer-legal, but `apply_look` resolves it through
  `_badge_or_422(..., family=row.family)`, so it can only ever reach the
  ALTERNATE ARTWORK of the family already held, and only artwork the catalogue
  has released.
* **Scope, never a body field.** The rows are the ones held by
  ``scope.supplier_id``; nothing here reads a supplier id off the request, so
  there is no branch that could be made to serve somebody else's badge.
* **No supplier link is a 404 `no_supplier` on BOTH verbs.** A free browsing
  account has no badge surface, and answering the PATCH identically means the
  reply never says whether that family exists for anyone.
* **The write drops the catalog caches.** The look rides inside the cached
  category payload (up to an hour), so a restyle that skipped
  `invalidate_catalog_caches()` would leave yesterday's fire on a live board.

The gate is the router-level ``account_scope`` dependency, which resolves
through ``require_account_user``: staff are refused 403 here (their door is
``/api/suppliers/{id}/badges``) and so is an unactivated customer (D17).
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import SupplierBadge
from app.routes.supplier_badges import BadgeLookPatch, _holding_or_404, apply_look
from app.services.account_scope import AccountScope, account_scope
from app.services.badges import serialize_supplier_badge
from app.services.search_service import invalidate_catalog_caches

router = APIRouter(
    prefix="/api/account",
    tags=["account-badges"],
    # Every route here is scoped, so the scope dependency IS the gate — a route
    # in this file cannot forget it.
    dependencies=[Depends(account_scope)],
)

NO_SUPPLIER_DETAIL = "no_supplier"


def _my_supplier_id(scope: AccountScope) -> uuid.UUID:
    # `scope.supplier_id` is `UUID | None`; `is_supplier` is exactly the
    # narrowing, so the guard returns the value it proved is present.
    if not scope.is_supplier or scope.supplier_id is None:
        raise HTTPException(404, NO_SUPPLIER_DETAIL)
    return scope.supplier_id


@router.get("/badges")
def my_badges(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    supplier_id = _my_supplier_id(scope)
    rows = (
        db.query(SupplierBadge)
        .filter(SupplierBadge.supplier_id == supplier_id)
        .order_by(SupplierBadge.family)
        .all()
    )
    return [serialize_supplier_badge(row) for row in rows]


@router.patch("/badges/{family}")
def restyle_my_badge(
    family: str,
    body: BadgeLookPatch,
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    supplier_id = _my_supplier_id(scope)
    row = _holding_or_404(db, supplier_id, family)

    apply_look(row, body, db)
    db.commit()
    db.refresh(row)
    invalidate_catalog_caches()
    return serialize_supplier_badge(row)
