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
    model_config = ConfigDict(from_attributes=True)


class CategoryDetailResponse(CategoryResponse):
    parent: ParentCategoryResponse | None = None
    suppliers: list[SupplierResponse]
    sponsor: SponsorResponse | None
    parts: list[PublicPartResponse] = []
    model_config = ConfigDict(from_attributes=True)


CategoryDetailResponse.model_rebuild()
