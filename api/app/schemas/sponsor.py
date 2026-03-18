from uuid import UUID
from pydantic import BaseModel, ConfigDict


class SponsorResponse(BaseModel):
    id: UUID
    supplier_name: str
    image_url: str | None = None
    description: str | None = None
    tier: str
    website: str | None = None
    phone: str | None = None
    model_config = ConfigDict(from_attributes=True)
