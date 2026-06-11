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
from app.schemas.sponsor import (
    AdminSponsorCreate,
    AdminSponsorResponse,
    AdminSponsorUpdate,
)
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/api/admin/sponsors", tags=["admin-sponsors"])


def _is_single_slot(tier: str | None, is_top_level: bool) -> bool:
    """Single-occupant placements that supersede same-tier peers: Platinum on a
    top-level category, Gold on a child. Silver (directory) and keyword
    placements are multi-occupant — never supersede.

    Casing-tolerant: admin emits TitleCase ('Platinum'), legacy seed rows are
    lowercase ('gold'). Normalize at the comparison site (per CLAUDE.md "Sponsor
    tier casing" gotcha).
    """
    t = (tier or "").strip().lower()
    return (t == "platinum" and is_top_level) or (t == "gold" and not is_top_level)


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

      - Category (top-level, ``parent_id IS NULL``): **Platinum** only (single
        Category Sponsor board, supersede peers).
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


def _supersede_existing_for_category(
    db: Session,
    category_id: uuid.UUID,
    tier: str,
    exclude_id: uuid.UUID | None = None,
) -> None:
    """Mark existing visible **same-tier** sponsors for ``category_id`` Expired.

    Enforces single-occupancy for the single-slot tiers (Platinum on a
    top-level category, Gold on a child) on every write path (POST +
    PATCH-with-category-id-change). Only callers that have confirmed a
    single-slot placement via ``_is_single_slot`` invoke this, so it filters to
    the SAME tier — a new Gold must not Expire the coexisting Silver directory
    on the same child, and vice versa. The public read in
    ``category_service`` mirrors the newest-visible-per-tier predicate.

    NULL is treated as Active: legacy seed rows (`db/seed.py`) omit the
    ``status`` column entirely, leaving it NULL. SQL three-valued logic
    means a naive ``status != 'Expired'`` filter SKIPS those rows (NULL !=
    'Expired' → NULL, not TRUE), so the supersede silently leaves a
    legacy row Active alongside the new one. ``or_(== 'Active', is_(None))``
    catches both. ``Paused`` is preserved unchanged — it's a deliberate
    lifecycle hold (billing dispute / contract pause), not a stale row, and
    a future booking on the same slot should not wipe it.
    """
    q = db.query(Sponsor).filter(
        Sponsor.category_id == category_id,
        func.lower(func.coalesce(Sponsor.tier, "")) == (tier or "").strip().lower(),
        or_(Sponsor.status == "Active", Sponsor.status.is_(None)),
    )
    if exclude_id is not None:
        q = q.filter(Sponsor.id != exclude_id)
    for old in q.all():
        old.status = "Expired"


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

    # Tier-aware supersede: single-slot placements (Platinum on a top-level
    # category, Gold on a child) Expire their same-tier peers so the board
    # shows one. Silver (the subcategory directory) and keyword placements are
    # multi-occupant — never supersede. Look up the category's parent_id to
    # resolve top-level vs child.
    if body.category_id is not None:
        cat = db.query(Category).filter(Category.id == body.category_id).first()
        if cat is not None and _is_single_slot(body.tier, cat.parent_id is None):
            _supersede_existing_for_category(db, body.category_id, body.tier)

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

    # Re-validate XOR + tier/placement invariants against the post-update
    # state so a PATCH can't leave the row in an illegal config.
    if "category_id" in update_data or "keyword" in update_data:
        _validate_xor(new_category_id, new_keyword)
    if "category_id" in update_data or "tier" in update_data:
        _validate_tier_placement(db, new_tier, new_category_id)

    # Re-assert single-slot occupancy after the update: if this PATCH lands the
    # sponsor as a single-slot tier (Platinum on top-level / Gold on child) —
    # whether by retargeting the category OR changing the tier — expire
    # same-tier peers on that category. Silver/keyword are multi-occupant: never
    # supersede. (Idempotent: supersede excludes self.)
    if new_category_id is not None and ("category_id" in update_data or "tier" in update_data):
        target_cat = db.query(Category).filter(Category.id == new_category_id).first()
        if target_cat is not None and _is_single_slot(new_tier, target_cat.parent_id is None):
            _supersede_existing_for_category(db, new_category_id, new_tier, exclude_id=sponsor.id)

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
