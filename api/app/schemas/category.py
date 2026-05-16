from __future__ import annotations

from uuid import UUID
from pydantic import BaseModel, ConfigDict

from .supplier import SupplierResponse
from .sponsor import SponsorResponse
from .part import PublicPartResponse


class SubcategoryResponse(BaseModel):
    id: UUID
    name: str
    slug: str
    icon: str
    parts_count: int = 0
    model_config = ConfigDict(from_attributes=True)


class CategoryResponse(BaseModel):
    id: UUID
    name: str
    slug: str
    icon: str
    parts_count: int = 0
    children: list[SubcategoryResponse]
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


class PopularPartsPage(BaseModel):
    """Paginated rollup of parts across a parent category's subcategories,
    ranked by aggregate listing stock (popularity proxy). Designed to scale
    to thousands of parts — frontend pages through 20 at a time by default.
    """
    items: list[PublicPartResponse] = []
    total: int = 0
    page: int = 1
    pages: int = 1
    per_page: int = 20
    model_config = ConfigDict(from_attributes=True)


class CategoryDetailResponse(CategoryResponse):
    parent: ParentCategoryResponse | None = None
    suppliers: list[SupplierResponse]
    sponsor: SponsorResponse | None
    parts: list[PublicPartResponse] = []
    # Pagination meta included so the frontend can render numbered controls
    # (Google-style 1 / 2 / 3 / … / N) without an extra HEAD query.
    # Only populated when the category has children — leaves keep .items = [].
    popular_parts: PopularPartsPage = PopularPartsPage()
    model_config = ConfigDict(from_attributes=True)


CategoryDetailResponse.model_rebuild()
