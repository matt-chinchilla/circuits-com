from uuid import UUID
from pydantic import BaseModel, ConfigDict


class PublicPartListingResponse(BaseModel):
    id: UUID
    supplier_name: str
    sku: str | None = None
    stock_quantity: int
    unit_price: float
    currency: str

    model_config = ConfigDict(from_attributes=True)


class PublicPartResponse(BaseModel):
    id: UUID
    sku: str
    description: str | None = None
    manufacturer_name: str
    lifecycle_status: str
    listings_count: int
    best_price: float | None = None
    category_icon: str | None = None

    model_config = ConfigDict(from_attributes=True)


class PublicPartDetailResponse(PublicPartResponse):
    datasheet_url: str | None = None
    category_name: str | None = None
    listings: list[PublicPartListingResponse] = []
