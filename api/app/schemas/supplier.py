from uuid import UUID

from pydantic import BaseModel, ConfigDict


class SupplierResponse(BaseModel):
    id: UUID
    name: str
    phone: str | None = None
    website: str | None = None
    email: str | None = None
    contact_name: str | None = None
    contact_role: str | None = None
    description: str | None = None
    logo_url: str | None = None
    model_config = ConfigDict(from_attributes=True)
