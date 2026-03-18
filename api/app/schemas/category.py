from __future__ import annotations

from uuid import UUID
from pydantic import BaseModel, ConfigDict

from .supplier import SupplierResponse
from .sponsor import SponsorResponse


class SubcategoryResponse(BaseModel):
    id: UUID
    name: str
    slug: str
    icon: str
    model_config = ConfigDict(from_attributes=True)


class CategoryResponse(BaseModel):
    id: UUID
    name: str
    slug: str
    icon: str
    children: list[SubcategoryResponse]
    model_config = ConfigDict(from_attributes=True)


class CategoryDetailResponse(CategoryResponse):
    suppliers: list[SupplierResponse]
    sponsor: SponsorResponse | None
    model_config = ConfigDict(from_attributes=True)


CategoryDetailResponse.model_rebuild()
