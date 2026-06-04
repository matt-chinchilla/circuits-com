from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, ConfigDict

from .part import PublicPartResponse
from .sponsor import SponsorResponse
from .supplier import SupplierResponse


class FeaturedSupplier(BaseModel):
    """A Featured supplier on a category (id + name).

    Carries the supplier id alongside the name so the admin categories tree's
    "Unfeature" button can target the exact CategorySupplier row. Names alone
    are ambiguous — Supplier.name has no unique constraint, so two distinct
    suppliers can share a name and collide in a name-keyed lookup.
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
    suppliers: list[SupplierResponse]
    sponsor: SponsorResponse | None
    parts: PartsPage = PartsPage()
    popular_parts: PartsPage = PartsPage()
    model_config = ConfigDict(from_attributes=True)


CategoryDetailResponse.model_rebuild()


class CategoryPartnersResponse(BaseModel):
    """Preferred Partners banner payload for a TOP-LEVEL category (split out of
    the heavy CategoryDetailResponse 2026-06-04 so the banner is a small,
    cacheable, top-level artifact). `slug`/`name` are the RESOLVED top-level
    category — a child slug resolves to its parent — so the banner shows the
    same partners on every subpage."""

    slug: str
    name: str
    partners: list[SupplierResponse] = []
    model_config = ConfigDict(from_attributes=True)
