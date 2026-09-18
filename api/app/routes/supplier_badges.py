"""Staff badge endpoints (055) — the catalogue, and who holds what.

`founder` stopped being a column in 055: a supplier IS a founder when it holds
an ENABLED row in the `founder` family. These four routes are the ONLY way
staff put one there, change how its fire looks, switch it off or take it back,
which makes them the only place the mark on the public boards moves.

Two rules run through all of it:

* **One holding per (supplier, family).** `uq_supplier_badges_family` is the
  DB's word on it; a second grant of a family the supplier already holds is a
  409, and choosing the family's alternate artwork is a PATCH that moves
  `badge_id` — never a second row.
* **Every write drops the catalog caches.** The look now rides INSIDE the
  cached category payload (`category_cache`, up to an hour) as well as the
  search-derived caches, so a grant that skipped `invalidate_catalog_caches()`
  would paint yesterday's fire on a live board.

The wall is `require_staff`, which admits a `viewer` (read-only staff, 051) on
GET and refuses 403 ``read_only`` on POST/PATCH/DELETE without this router
opting in per route. The customer's look-only door is a separate router.
"""

import uuid
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Badge, SupplierBadge, User
from app.models.badge import BADGE_SCHEMES
from app.routes.suppliers import _supplier_or_404
from app.services.auth_service import require_staff
from app.services.badges import serialize_badge_def, serialize_supplier_badge
from app.services.search_service import invalidate_catalog_caches

router = APIRouter(prefix="/api", tags=["badges"])

# The look fields a customer may also change (Task 4 reuses `apply_look`), plus
# `enabled`, which only staff may touch. Every one of them backs a NOT NULL
# column, so an explicit null is a 422 here rather than an IntegrityError 500
# at commit — the same guard `admin_expenses` carries.
LOOK_FIELDS = ("key", "scheme", "intensity", "opacity", "sparks")
NOT_NULLABLE = (*LOOK_FIELDS, "enabled")


class BadgeLookPatch(BaseModel):
    """What the badge LOOKS like. Shared with the customer router: the ranges
    live here once so both doors admit exactly the same values."""

    model_config = ConfigDict(extra="forbid")

    key: str | None = None
    scheme: Literal[BADGE_SCHEMES] | None = None  # type: ignore[valid-type]
    intensity: float | None = Field(None, ge=0.3, le=2)
    opacity: float | None = Field(None, ge=0.2, le=1)
    sparks: bool | None = None


class StaffBadgePatch(BadgeLookPatch):
    enabled: bool | None = None


class GrantBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str


def _badge_or_422(db: Session, key: str, family: str | None = None) -> Badge:
    """A catalogue row staff/customers may actually choose.

    Three separate refusals, all 422 because they are all "that is not a
    choosable badge": the key is unknown, it belongs to another family (a
    PATCH must not move a holding out of the family it is keyed on), or the
    catalogue has it marked unavailable — which is how an artwork ships dark
    until the owner releases it.

    `available` means CHOOSABLE, never RENDERABLE: neither `badge_look` nor
    `serialize_supplier_badge` consults it, so a holding that already points
    at a key later re-marked unavailable by the seed's re-assert
    (`app/db/seed.py`, `BADGE_CATALOGUE`) keeps painting. Pulling an artwork
    closes the door on NEW picks; it never yanks a badge a company was given.
    Note for the editor (Tasks 7/8): `GET /api/badges` returns unavailable
    rows on purpose, so the picker must filter on `available` itself or a
    user chooses a key that 422s here.
    """
    badge = db.query(Badge).filter(Badge.key == key).first()
    if badge is None:
        raise HTTPException(422, "unknown_badge")
    if family is not None and badge.family != family:
        raise HTTPException(422, "badge_family_mismatch")
    if not badge.available:
        raise HTTPException(422, "badge_unavailable")
    return badge


def _holding_or_404(db: Session, supplier_id: uuid.UUID, family: str) -> SupplierBadge:
    row = (
        db.query(SupplierBadge)
        .filter(SupplierBadge.supplier_id == supplier_id, SupplierBadge.family == family)
        .first()
    )
    if row is None:
        raise HTTPException(404, "badge_not_held")
    return row


def apply_look(row: SupplierBadge, patch: BadgeLookPatch, db: Session) -> None:
    """Write the look fields a PATCH actually SET onto the holding.

    Shared with the customer router, so the "which fields, which coercion"
    answer exists once. `exclude_unset` is what keeps an omitted field
    untouched; the null sweep covers `enabled` too (the staff subclass), so
    both callers get the same refusal without a second copy of it. The
    numerics go through `Decimal(str(x))` because the columns are
    `Numeric(3, 2)` and binding a binary float is how 1.7 becomes 1.6999.
    """
    data = patch.model_dump(exclude_unset=True)
    nulled = sorted(k for k in NOT_NULLABLE if k in data and data[k] is None)
    if nulled:
        raise HTTPException(422, f"These fields cannot be null: {', '.join(nulled)}.")

    if "key" in data:
        row.badge_id = _badge_or_422(db, data["key"], family=row.family).id
    if "scheme" in data:
        row.scheme = data["scheme"]
    if "intensity" in data:
        row.intensity = Decimal(str(data["intensity"]))
    if "opacity" in data:
        row.opacity = Decimal(str(data["opacity"]))
    if "sparks" in data:
        row.sparks = bool(data["sparks"])


@router.get("/badges")
def list_badge_catalogue(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_staff),
):
    """The whole catalogue, unavailable rows included — the editor needs to
    show what exists before it shows what is choosable."""
    rows = db.query(Badge).order_by(Badge.sort_order, Badge.key).all()
    return [serialize_badge_def(b) for b in rows]


@router.get("/suppliers/{supplier_id}/badges")
def list_supplier_badges(
    supplier_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_staff),
):
    supplier = _supplier_or_404(db, supplier_id)
    rows = (
        db.query(SupplierBadge)
        .filter(SupplierBadge.supplier_id == supplier.id)
        .order_by(SupplierBadge.family)
        .all()
    )
    return [serialize_supplier_badge(r) for r in rows]


@router.post("/suppliers/{supplier_id}/badges")
def grant_badge(
    supplier_id: str,
    body: GrantBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_staff),
):
    supplier = _supplier_or_404(db, supplier_id)
    badge = _badge_or_422(db, body.key)
    held = (
        db.query(SupplierBadge)
        .filter(
            SupplierBadge.supplier_id == supplier.id,
            SupplierBadge.family == badge.family,
        )
        .first()
    )
    if held is not None:
        raise HTTPException(
            409,
            f"This supplier already holds a '{badge.family}' badge. "
            "Change its artwork with PATCH, or revoke it first.",
        )

    row = SupplierBadge(
        supplier_id=supplier.id,
        badge_id=badge.id,
        family=badge.family,
        granted_by=current_user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    invalidate_catalog_caches()
    return serialize_supplier_badge(row)


@router.patch("/suppliers/{supplier_id}/badges/{family}")
def update_supplier_badge(
    supplier_id: str,
    family: str,
    body: StaffBadgePatch,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_staff),
):
    supplier = _supplier_or_404(db, supplier_id)
    row = _holding_or_404(db, supplier.id, family)

    apply_look(row, body, db)
    data = body.model_dump(exclude_unset=True)
    if "enabled" in data:
        # Staff-only, and the one switch that decides whether the supplier
        # reads as a founder at all — a disabled holding paints nothing.
        row.enabled = bool(data["enabled"])

    db.commit()
    db.refresh(row)
    invalidate_catalog_caches()
    return serialize_supplier_badge(row)


@router.delete("/suppliers/{supplier_id}/badges/{family}")
def revoke_supplier_badge(
    supplier_id: str,
    family: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_staff),
):
    supplier = _supplier_or_404(db, supplier_id)
    row = _holding_or_404(db, supplier.id, family)
    db.delete(row)
    db.commit()
    invalidate_catalog_caches()
    return {"ok": True}
