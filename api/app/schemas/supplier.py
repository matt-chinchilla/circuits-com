from uuid import UUID
from pydantic import BaseModel, ConfigDict


class SupplierResponse(BaseModel):
    id: UUID
    name: str
    phone: str | None = None
    website: str | None = None
    email: str | None = None
    description: str | None = None
    logo_url: str | None = None
    is_featured: bool = False
    rank: int = 0
    model_config = ConfigDict(from_attributes=True)
