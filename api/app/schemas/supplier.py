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
    coverage_hours: str | None = None
    description: str | None = None
    logo_url: str | None = None
    # Founding-distributor incentive flag (054). PUBLIC on purpose — it is a
    # badge, not a secret; writes stay staff-only via require_staff.
    founder: bool = False
    model_config = ConfigDict(from_attributes=True)
