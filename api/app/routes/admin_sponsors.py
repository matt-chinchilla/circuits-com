"""Admin CRUD for the sponsors table.

Backs the React admin /admin/sponsors page. Previously the admin console
only wrote sponsors to browser localStorage, so admin-created/edited
sponsors never reached the database — and the public site (which reads the
category sponsor straight from the `sponsors` table in
category_service.py) never saw them. This router is the missing WRITE
path: it persists sponsors so admin edits show up live on the public site.

Auth-gated like the rest of /admin/* via Depends(get_current_user).

The Sponsor model enforces a category_id-XOR-keyword CheckConstraint at the
Postgres level, but tests run on SQLite (which ignores CHECK constraints),
so the XOR is ALSO validated here in Python — exactly one of category_id /
keyword must be set, else 422.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Category, Sponsor, Supplier, User
from app.models.sponsor import is_single_slot
from app.schemas.sponsor import (
    AdminSponsorCreate,
    AdminSponsorResponse,
    AdminSponsorUpdate,
)
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/api/admin/sponsors", tags=["admin-sponsors"])


def _serialize(sponsor: Sponsor) -> AdminSponsorResponse:
    """Build the joined admin response, pulling names/icon off relationships."""
    return AdminSponsorResponse(
        id=sponsor.id,
        supplier_id=sponsor.supplier_id,
        supplier_name=sponsor.supplier.name if sponsor.supplier else "",
        category_id=sponsor.category_id,
        category_name=sponsor.category.name if sponsor.category else None,
        category_icon=sponsor.category.icon if sponsor.category else None,
        keyword=sponsor.keyword,
        tier=sponsor.tier,
        image_url=sponsor.image_url,
        description=sponsor.description,
        start_date=sponsor.start_date,
        end_date=sponsor.end_date,
        amount=sponsor.amount,
        status=sponsor.status,
    )


def _validate_xor(category_id: uuid.UUID | None, keyword: str | None) -> None:
    """Exactly one of category_id / keyword must be set, else 422.

    Enforced in Python because SQLite (used in tests) ignores the model's
    CheckConstraint. Mirrors the Postgres constraint at runtime.
    """
    has_category = category_id is not None
    has_keyword = bool(keyword)
    if has_category == has_keyword:
        raise HTTPException(
            status_code=422,
            detail="Exactly one of category_id or keyword must be set.",
        )


def _validate_tier_placement(db: Session, tier: str | None, category_id: uuid.UUID | None) -> None:
    """Enforce the tier ↔ placement matrix (2026-06-11 tier-boards model):

      - Category (top-level, ``parent_id IS NULL``): **Platinum** only (single-slot
        Category Sponsor board; a 2nd active peer is BLOCKED 409 by
        ``_reject_if_slot_taken`` + migration 016's unique index).
      - Subcategory (child): **Gold** (single slot) or **Silver** (directory).
      - Keyword: **Silver / Gold** (multi-sponsor; Platinum is top-level-only).

    So Platinum is top-level-category-exclusive and Silver is no longer
    keyword-only (it's the subcategory directory tier too). A Postgres trigger
    enforces the same rule at the DB level; this validator gives a clean 422
    (and covers SQLite tests, which skip the trigger). The admin form greys out
    the wrong combinations; this catches a hand-crafted POST. Resolves the
    Category (404 if missing) to read ``parent_id``.
    """
    t = (tier or "").strip().lower()
    has_category = category_id is not None
    if not has_category:
        if t not in ("silver", "gold"):
            raise HTTPException(422, "Keyword placement requires the Silver or Gold tier.")
        return
    cat = db.query(Category).filter(Category.id == category_id).first()
    if cat is None:
        raise HTTPException(404, "Category not found")
    if cat.parent_id is None:
        if t != "platinum":
            raise HTTPException(422, "Top-level category placement requires the Platinum tier.")
    elif t not in ("gold", "silver"):
        raise HTTPException(422, "Subcategory placement requires the Gold or Silver tier.")


def _parse_sponsor_id(sponsor_id: str) -> uuid.UUID:
    """Path-param id → UUID. Bad id is treated as not-found (404).

    Sponsor.id is a UUID column; under SQLite the ORM needs a real UUID to
    build the WHERE clause (a bare str throws 'str has no attribute hex').
    """
    try:
        return uuid.UUID(sponsor_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=404, detail="Sponsor not found") from None


def _reject_if_slot_taken(
    db: Session,
    category_id: uuid.UUID,
    tier: str,
    exclude_id: uuid.UUID | None = None,
) -> None:
    """Block a second occupant of a single-slot placement → 409 (incumbent wins).

    Single-occupant placements (Platinum on a top-level category, Gold on a
    child) hold ONE active sponsor: if an active same-tier sponsor already holds
    ``category_id``, reject — the incumbent keeps the slot. This is the 2026-06-22
    BLOCK policy, replacing the prior supersede (which Expired the old one so the
    NEWEST won); re-selling a slot now means expiring/removing the current
    sponsor first. The Postgres partial unique indexes (migration 016) are the
    un-bypassable DB backstop; this gives the clean 422/409 on the API path (and
    covers SQLite tests, which skip the indexes like the tier-placement trigger).

    Only callers that have confirmed a single-slot placement via
    ``is_single_slot`` invoke this, so it filters to the SAME tier — a new Gold
    must not collide with the coexisting Silver directory on the same child, and
    vice versa. ``exclude_id`` skips the row being PATCHed (re-validating itself).

    NULL is treated as Active: legacy seed rows (`db/seed.py`) omit the ``status``
    column, leaving it NULL. SQL three-valued logic means a naive
    ``status != 'Expired'`` filter SKIPS those rows, so a legacy incumbent would
    be invisible here and the second sponsor wrongly allowed.
    ``or_(== 'Active', is_(None))`` catches both. ``Paused``/``Expired`` rows are
    not active occupants, so they never block a new booking.
    """
    q = db.query(Sponsor).filter(
        Sponsor.category_id == category_id,
        func.lower(func.coalesce(Sponsor.tier, "")) == (tier or "").strip().lower(),
        or_(Sponsor.status == "Active", Sponsor.status.is_(None)),
    )
    if exclude_id is not None:
        q = q.filter(Sponsor.id != exclude_id)
    if db.query(q.exists()).scalar():
        raise HTTPException(
            status_code=409,
            detail=(
                f"This category already has an active {tier} sponsor. "
                "Expire or remove the current sponsor before adding another."
            ),
        )


@router.get("/", response_model=list[AdminSponsorResponse])
def list_sponsors(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sponsors = db.query(Sponsor).order_by(Sponsor.created_at.desc()).all()
    return [_serialize(s) for s in sponsors]


@router.post("/", response_model=AdminSponsorResponse)
def create_sponsor(
    body: AdminSponsorCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _validate_xor(body.category_id, body.keyword)
    _validate_tier_placement(db, body.tier, body.category_id)

    supplier = db.query(Supplier).filter(Supplier.id == body.supplier_id).first()
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found")

    # Single-slot BLOCK: a single-occupant placement (Platinum on a top-level
    # category, Gold on a child) rejects a second active sponsor with 409 — the
    # incumbent keeps the slot. Silver (the subcategory directory) and keyword
    # placements are multi-occupant — never blocked. Look up the category's
    # parent_id to resolve top-level vs child.
    if body.category_id is not None:
        cat = db.query(Category).filter(Category.id == body.category_id).first()
        if cat is not None and is_single_slot(body.tier, cat.parent_id is None):
            _reject_if_slot_taken(db, body.category_id, body.tier)

    sponsor = Sponsor(
        id=uuid.uuid4(),
        supplier_id=body.supplier_id,
        category_id=body.category_id,
        keyword=body.keyword,
        tier=body.tier,
        image_url=body.image_url,
        description=body.description,
        start_date=body.start_date,
        end_date=body.end_date,
        amount=body.amount,
        status=body.status,
    )
    db.add(sponsor)
    try:
        db.commit()
    except IntegrityError:
        # UNIQUE(supplier_id, category_id|keyword) — the company already
        # sponsors this category/keyword (no duplicate placements).
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="This company already has a sponsorship for that category or keyword.",
        ) from None
    db.refresh(sponsor)
    return _serialize(sponsor)


@router.patch("/{sponsor_id}", response_model=AdminSponsorResponse)
def update_sponsor(
    sponsor_id: str,
    body: AdminSponsorUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sponsor = db.query(Sponsor).filter(Sponsor.id == _parse_sponsor_id(sponsor_id)).first()
    if not sponsor:
        raise HTTPException(status_code=404, detail="Sponsor not found")

    update_data = body.model_dump(exclude_unset=True)

    # Resolve post-update tier + placement so all guards see the same
    # final state (handles partial PATCH where only one of tier/category_id
    # is touched).
    new_category_id = update_data.get("category_id", sponsor.category_id)
    new_keyword = update_data.get("keyword", sponsor.keyword)
    new_tier = update_data.get("tier", sponsor.tier)
    new_status = update_data.get("status", sponsor.status)

    # Re-validate XOR + tier/placement invariants against the post-update
    # state so a PATCH can't leave the row in an illegal config.
    if "category_id" in update_data or "keyword" in update_data:
        _validate_xor(new_category_id, new_keyword)
    if "category_id" in update_data or "tier" in update_data:
        _validate_tier_placement(db, new_tier, new_category_id)

    # Re-assert single-slot occupancy after the update: BLOCK when the POST-UPDATE
    # row would be an ACTIVE single-slot sponsor (Platinum on top-level / Gold on
    # child) AND the update touches a field that could create a 2nd active occupant
    # of that slot — the category, the tier, OR the status flipping to active. The
    # status case matters: re-activating an Expired sponsor (status-only PATCH) into
    # a now-occupied slot must 409 too, else it dodges the category/tier-only check
    # and two active sponsors land on one slot. An update that Expires/Pauses a row
    # frees the slot (new_is_active False) — never blocked. Silver/keyword are
    # multi-occupant. exclude_id skips self, so re-saving a row on its own slot is fine.
    new_is_active = new_status == "Active" or new_status is None
    if (
        new_category_id is not None
        and new_is_active
        and bool({"category_id", "tier", "status"} & update_data.keys())
    ):
        target_cat = db.query(Category).filter(Category.id == new_category_id).first()
        if target_cat is not None and is_single_slot(new_tier, target_cat.parent_id is None):
            _reject_if_slot_taken(db, new_category_id, new_tier, exclude_id=sponsor.id)

    for key, value in update_data.items():
        setattr(sponsor, key, value)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="This company already has a sponsorship for that category or keyword.",
        ) from None
    db.refresh(sponsor)
    return _serialize(sponsor)


@router.delete("/{sponsor_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sponsor(
    sponsor_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sponsor = db.query(Sponsor).filter(Sponsor.id == _parse_sponsor_id(sponsor_id)).first()
    if not sponsor:
        raise HTTPException(status_code=404, detail="Sponsor not found")

    # The banner reads the `sponsors` table directly now (2026-06-03
    # single-source-of-truth), so deleting the row removes the company from the
    # category page — no CategorySupplier reversal needed.
    db.delete(sponsor)
    db.commit()
