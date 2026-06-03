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
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Category, CategorySupplier, Sponsor, Supplier, User
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
    """Enforce the tier ↔ category-level placement rule.

    Product rule (2026-06-02, softened):

      - Featured tier may ONLY attach to a top-level category
        (``parent_id IS NULL``). Featured + child OR Featured + keyword
        → 422. Featured lands on the PreferredPartnersBanner, which is
        a top-level surface only.

      - Silver / Gold / Platinum may attach to:
          * a CHILD category (the "Subcategory Sponsor" single-slot
            surface), OR
          * a keyword (multi-sponsor per keyword landing page).
        Non-Featured + top-level category → 422 (top-level is the
        Featured tier's promise).

    The admin form greys out the wrong combinations; this guard catches
    a hand-crafted POST that bypasses the UI.

    Resolves the Category row (404 if missing) so we can check
    ``parent_id``. Done at the validator level rather than in the route
    body so POST and PATCH share one lookup path.
    """
    has_category = category_id is not None
    featured = _is_featured(tier)

    if featured and not has_category:
        raise HTTPException(
            status_code=422,
            detail="Featured tier is category-only — keyword placement not allowed.",
        )

    if not has_category:
        # Non-Featured + keyword is fine; nothing else to check.
        return

    cat = db.query(Category).filter(Category.id == category_id).first()
    if cat is None:
        raise HTTPException(status_code=404, detail="Category not found")

    is_top_level = cat.parent_id is None

    if featured and not is_top_level:
        raise HTTPException(
            status_code=422,
            detail="Featured tier must attach to a top-level category.",
        )
    if not featured and is_top_level:
        raise HTTPException(
            status_code=422,
            detail="Top-level category placement requires the Featured tier.",
        )


def _upsert_category_supplier_featured(
    db: Session,
    supplier_id: uuid.UUID,
    category_id: uuid.UUID,
) -> None:
    """Ensure the (supplier, category) join row exists with is_featured=True.

    Side-effect of writing a Featured sponsor: PreferredPartnersBanner
    reads ``category.suppliers`` filtered to ``is_featured=True``, so a
    Featured sponsor that didn't land here would be invisible on the
    banner (the 2026-06-02 reproduction).

    Idempotent — flips an existing row's is_featured if it was False,
    leaves an already-Featured row alone (don't churn rank). New rows
    pick rank = max(rank for category) + 1 to avoid collisions with
    existing featured peers, which the banner sorts by rank asc.
    """
    existing = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == category_id,
            CategorySupplier.supplier_id == supplier_id,
        )
        .first()
    )
    if existing is not None:
        # SQLAlchemy ORM descriptor assignment — Pyright sees Column[bool]
        # at type level, but runtime intercepts these to emit UPDATE.
        existing.is_featured = True  # type: ignore[assignment]
        return

    # Auto-rank: next slot after the highest existing FEATURED rank on this
    # category. Scoping the max to is_featured=True rows keeps the value a
    # sensible count of featured partners — non-featured CategorySupplier rows
    # (seed associations, or suppliers unfeatured but row-preserved) must NOT
    # inflate it, else the Nth featured partner lands at rank > N (the
    # 2026-06-03 "Pasternack shows #7" root cause). Banner ORDER BYs rank asc,
    # so max+1 still puts the new row at the bottom (lowest priority).
    max_rank = (
        db.query(CategorySupplier.rank)
        .filter(
            CategorySupplier.category_id == category_id,
            CategorySupplier.is_featured.is_(True),
        )
        .order_by(CategorySupplier.rank.desc())
        .first()
    )
    next_rank = (max_rank[0] if max_rank else 0) + 1

    db.add(
        CategorySupplier(
            category_id=category_id,
            supplier_id=supplier_id,
            is_featured=True,
            rank=next_rank,
        )
    )


def _unfeature_after_delete(
    db: Session,
    supplier_id: uuid.UUID,
    category_id: uuid.UUID,
) -> None:
    """Inverse of ``_upsert_category_supplier_featured`` for sponsor deletion.

    When a Featured sponsor is deleted, drop the supplier off the
    PreferredPartnersBanner by setting ``CategorySupplier.is_featured=False``
    — UNLESS another Featured sponsor for the same ``(supplier, category)``
    still justifies the slot (Featured peers coexist). Mirrors the
    ``/unfeature`` endpoint: flip the flag, preserve the row (keeps rank +
    association history).

    Must be called AFTER the deleted sponsor has been flushed, so the
    remaining-Featured check doesn't count the row being removed.

    NOTE: an ``is_featured`` row created by seed/manual curation (not by a
    Featured sponsor) is also cleared here if the supplier's last Featured
    sponsor on this category is deleted — acceptable, since removing the
    sponsorship is the admin's explicit intent.
    """
    # Only an Active (or NULL-legacy) Featured sponsor justifies keeping the
    # banner slot — same predicate as _supersede_existing_for_category and the
    # public category read. An Expired/Paused peer is not visible anywhere, so
    # it must not keep a supplier on the banner (ghost-partner bug class).
    remaining = (
        db.query(Sponsor)
        .filter(
            Sponsor.supplier_id == supplier_id,
            Sponsor.category_id == category_id,
            or_(Sponsor.status == "Active", Sponsor.status.is_(None)),
        )
        .all()
    )
    if any(_is_featured(s.tier) for s in remaining):
        return  # a live peer Featured sponsor still justifies the banner slot

    cs = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == category_id,
            CategorySupplier.supplier_id == supplier_id,
        )
        .first()
    )
    if cs is not None and cs.is_featured:
        # ORM descriptor assignment — Pyright sees Column[bool] at type level.
        cs.is_featured = False  # type: ignore[assignment]


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

    # Featured + top-level category → side-effect onto CategorySupplier
    # so the PreferredPartnersBanner picks up the new partner immediately.
    # (By contract, Featured can ONLY be top-level — validator above
    # rejects child/keyword for Featured.)
    if _is_featured(body.tier) and body.category_id is not None:
        _upsert_category_supplier_featured(db, body.supplier_id, body.category_id)

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
    db.commit()
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

    # Featured + top-level category (newly or already): mirror the POST
    # side-effect so the banner reflects the latest state.
    if _is_featured(new_tier) and new_category_id is not None:
        _upsert_category_supplier_featured(db, sponsor.supplier_id, new_category_id)

    for key, value in update_data.items():
        setattr(sponsor, key, value)

    db.commit()
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

    # Capture the Featured side-effect inputs BEFORE the row is gone, so we
    # can reverse the CategorySupplier feature that create_sponsor set up.
    # Without this the supplier stays on the PreferredPartnersBanner after
    # the sponsor is deleted (the banner reads category_suppliers, not
    # sponsors) — the "deleted sponsorship still shows on the website" bug.
    was_featured = _is_featured(sponsor.tier)
    supplier_id = sponsor.supplier_id
    category_id = sponsor.category_id

    db.delete(sponsor)
    # Flush so the deleted row isn't counted by the remaining-Featured check.
    db.flush()
    if was_featured and category_id is not None:
        _unfeature_after_delete(db, supplier_id, category_id)

    db.commit()
