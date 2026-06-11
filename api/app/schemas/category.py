from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, ConfigDict

from .part import PublicPartResponse
from .sponsor import SponsorResponse
from .supplier import SupplierResponse


class FeaturedSupplier(BaseModel):
    """A Featured supplier on a category (id + name).

    Carries the supplier id alongside the name so the admin categories tree can
    unambiguously identify the sponsor — Supplier.name has no unique constraint,
    so two distinct suppliers can share a name and collide in a name-keyed
    lookup. (Featured status is sourced from the `sponsors` table as of
    2026-06-03; the old CategorySupplier feature flag is gone.)
    """

    id: UUID
    name: str
    model_config = ConfigDict(from_attributes=True)


class SubcategoryResponse(BaseModel):
    id: UUID
    name: str
    slug: str
    icon: str
    parts_count: int = 0
    featured_supplier_name: str | None = None
    # All Featured CategorySuppliers for this category, ordered by rank ASC
    # (lowest rank = highest priority). 2026-06-02: a category may have many
    # Featured suppliers; `featured_supplier_name` is kept for back-compat
    # and mirrors `featured_suppliers[0].name`.
    featured_suppliers: list[FeaturedSupplier] = []
    model_config = ConfigDict(from_attributes=True)


class CategoryResponse(BaseModel):
    id: UUID
    name: str
    slug: str
    icon: str
    description: str | None = None
    parts_count: int = 0
    children: list[SubcategoryResponse]
    featured_supplier_name: str | None = None
    featured_suppliers: list[FeaturedSupplier] = []
    model_config = ConfigDict(from_attributes=True)


class ParentCategoryResponse(BaseModel):
    id: UUID
    name: str
    slug: str
    icon: str
    # Sibling subcategories — surfaced so the frontend can render the
    # intra-category chips on a subcategory page (current page marked active)
    # without an extra round-trip to fetch the parent. See 2026-05-16 bug fix
    # in CategoryPage/SubcategoryChips.
    children: list[SubcategoryResponse] = []
    model_config = ConfigDict(from_attributes=True)


class PartsPage(BaseModel):
    items: list[PublicPartResponse] = []
    total: int = 0
    page: int = 1
    pages: int = 1
    per_page: int = 20
    model_config = ConfigDict(from_attributes=True)


PopularPartsPage = PartsPage


class CategoryDetailResponse(CategoryResponse):
    parent: ParentCategoryResponse | None = None
    # `sponsor` = this child's newest visible GOLD sponsor (the single
    # Subcategory Sponsor slot → SponsorBlock). `silver` = this child's visible
    # SILVER sponsors (the multi-occupant directory → SilverPartners). Both are
    # tier-filtered in category_service. (2026-06-11 tier-boards matrix.)
    sponsor: SponsorResponse | None
    silver: list[SupplierResponse] = []
    parts: PartsPage = PartsPage()
    popular_parts: PartsPage = PartsPage()
    model_config = ConfigDict(from_attributes=True)


CategoryDetailResponse.model_rebuild()


class CategoryPartnersResponse(BaseModel):
    """Category Sponsor (Platinum) board payload for a TOP-LEVEL category (split
    out of the heavy CategoryDetailResponse 2026-06-04 so it's a small,
    cacheable, top-level artifact). `slug`/`name` are the RESOLVED top-level
    category — a child slug resolves to its parent — so the same Platinum board
    shows on every subpage. `platinum` is the single visible Platinum sponsor
    (newest-wins); `None` → the board renders its Open-Placement state.
    (2026-06-11 tier-boards matrix — was a multi-supplier `partners` list.)"""

    slug: str
    name: str
    platinum: SponsorResponse | None = None
    model_config = ConfigDict(from_attributes=True)
