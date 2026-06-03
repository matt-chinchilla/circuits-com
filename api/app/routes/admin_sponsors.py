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
from sqlalchemy import or_
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


def _is_featured(tier: str | None) -> bool:
    """Case-insensitive check for the Featured tier.

    Admin emits TitleCase ('Featured'); legacy seed rows are lowercase
    ('gold'). Normalize at the comparison site rather than at write time
    so existing data stays untouched (per CLAUDE.md "Sponsor tier
    casing" gotcha).
    """
    return (tier or "").strip().lower() == "featured"


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


def _validate_tier_placement(
    db: Session, tier: str | None, category_id: uuid.UUID | None
) -> None:
    """Enforce the tier ↔ placement matrix (2026-06-03 single-source model):

      - Category (top-level, ``parent_id IS NULL``): **Featured** only.
      - Subcategory (child): **Platinum / Gold** only.
      - Keyword: **Silver / Gold / Platinum** (Featured is category-only).

    So Silver is keyword-exclusive and Featured is top-level-category-exclusive.
    A Postgres trigger enforces the same rule at the DB level; this validator
    gives a clean 422 (and covers SQLite tests, which skip the trigger). The
    admin form greys out the wrong combinations; this catches a hand-crafted
    POST. Resolves the Category (404 if missing) to read ``parent_id``.
    """
    t = (tier or "").strip().lower()
    has_category = category_id is not None

    if not has_category:
        # Keyword placement — any paid tier except Featured.
        if t == "featured":
            raise HTTPException(
                status_code=422,
                detail="Featured tier is category-only — keyword placement not allowed.",
            )
        return

    cat = db.query(Category).filter(Category.id == category_id).first()
    if cat is None:
        raise HTTPException(status_code=404, detail="Category not found")

    if cat.parent_id is None:
        if t != "featured":
            raise HTTPException(
                status_code=422,
                detail="Top-level category placement requires the Featured tier.",
            )
    elif t not in ("platinum", "gold"):
        raise HTTPException(
            status_code=422,
            detail="Subcategory placement requires the Platinum or Gold tier.",
        )


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
    exclude_id: uuid.UUID | None = None,
) -> None:
    """Mark any existing visible sponsor for ``category_id`` as Expired.

    Enforces "at most one Active sponsor per category" on EVERY write path
    (POST + PATCH-with-category-id-change). The public read in
    ``category_service.get_category_detail`` filters the same predicate, so
    this guarantees the banner picks a single deterministic sponsor.

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

    # Tier-gated supersede: Featured allows MULTIPLE concurrent sponsors
    # per top-level category (banner shows them all). Non-Featured + child
    # is the single Subcategory Sponsor slot, so supersede peers there.
    # Non-Featured + keyword is multi-sponsor; no supersede.
    if body.category_id is not None and not _is_featured(body.tier):
        _supersede_existing_for_category(db, body.category_id)

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

    # If this PATCH re-targets a non-Featured sponsor to a new category
    # (necessarily a child category — top-level + non-Featured was
    # rejected above), supersede whatever's currently sitting on that
    # Subcategory Sponsor slot. Featured peers coexist on top-level
    # categories (banner shows them all), so skip supersede there.
    if (
        "category_id" in update_data
        and new_category_id is not None
        and new_category_id != sponsor.category_id
        and not _is_featured(new_tier)
    ):
        _supersede_existing_for_category(db, new_category_id, exclude_id=sponsor.id)

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
