from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, ConfigDict

from .part import PublicPartResponse
from .sponsor import SponsorResponse
from .supplier import SupplierResponse


class SubcategoryResponse(BaseModel):
    id: UUID
    name: str
    slug: str
    icon: str
    parts_count: int = 0
    featured_supplier_name: str | None = None
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
    # CSB v13 clean break: singular `sponsor` -> `top_sponsors`. Always
    # present (empty list when none), length 0 or 1 today, with headroom
    # for a future multi-sponsor banner.
    top_sponsors: list[SponsorResponse] = []
    parts: PartsPage = PartsPage()
    popular_parts: PartsPage = PartsPage()
    model_config = ConfigDict(from_attributes=True)


CategoryDetailResponse.model_rebuild()
