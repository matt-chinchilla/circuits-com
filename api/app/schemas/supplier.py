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
    # DERIVED since 055: true when the supplier holds an ENABLED founder-family
    # badge (`services.badges.is_founder`). There is no write path to this field
    # any more — granting happens on the badge holding, staff-only.
    founder: bool = False
    # The fire look the boards paint: {key, scheme, intensity, opacity, sparks},
    # or None when the supplier holds no enabled founder-family badge. Built by
    # the same `supplier_badge_fields` call that derives `founder` — the two are
    # always stamped together.
    badge: dict | None = None
    model_config = ConfigDict(from_attributes=True)
