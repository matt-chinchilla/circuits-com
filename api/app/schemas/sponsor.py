from datetime import date
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.utils.color import validate_optional_hex_color
from app.utils.image_url import validate_optional_image_url

# The three lifecycle states every reader understands (NULL = legacy Active).
# An admin write is canonicalised to exactly one of these (F3): R15's guard
# compares canonical values, so "expired" / " Expired " / "EXPIRED" can no
# longer slip past it and hide a board the customer keeps paying for, and a
# stray "Inactive" never lands in a column the boards filter on.
SPONSOR_STATUSES = ("Active", "Paused", "Expired")
SPONSOR_STATUS_RULE = "Status must be Active, Paused or Expired."
_STATUS_BY_FOLDED = {s.casefold(): s for s in SPONSOR_STATUSES}


def canonical_sponsor_status(value: str | None) -> str | None:
    """``value`` stripped + casefolded onto ``Active`` | ``Paused`` |
    ``Expired``; ``None`` stays ``None`` (legacy Active). Anything else raises
    ``ValueError(SPONSOR_STATUS_RULE)`` — the route turns it into a 422 with
    that sentence as a STRING detail, which the admin form can print."""
    if value is None:
        return None
    canonical = _STATUS_BY_FOLDED.get(value.strip().casefold())
    if canonical is None:
        raise ValueError(SPONSOR_STATUS_RULE)
    return canonical


class SponsorResponse(BaseModel):
    id: UUID
    supplier_name: str
    image_url: str | None = None
    description: str | None = None
    tier: str
    website: str | None = None
    phone: str | None = None
    email: str | None = None
    contact_name: str | None = None
    # Sponsor-board fields, joined off the linked supplier (migration 014). The
    # boards (Platinum/Gold/Silver) render these; the `/partners` + `/{slug}`
    # routes build this model by hand (manual serialize, not response_model), so
    # every field listed here must be stamped on the dict the service returns.
    logo_url: str | None = None
    contact_role: str | None = None
    coverage_hours: str | None = None
    brand_primary: str | None = None
    brand_secondary: str | None = None
    brand_takeover: bool = False
    # 055: founding-distributor flag + the fire look, DERIVED off the joined
    # supplier's badge holdings. Stamped by `_sponsor_board_dict` AND the
    # keyword route — the two hand-built sites, both via `supplier_badge_fields`.
    founder: bool = False
    badge: dict | None = None
    model_config = ConfigDict(from_attributes=True)


class AdminSponsorResponse(BaseModel):
    """Admin-facing sponsor shape — joins supplier + category names/icon.

    Backs the React admin /admin/sponsors CRUD. Unlike the public
    SponsorResponse this exposes the raw FK ids, lifecycle dates, billing
    amount, and status so the admin form can round-trip every field.
    """

    id: UUID
    supplier_id: UUID
    supplier_name: str
    category_id: UUID | None = None
    category_name: str | None = None
    category_icon: str | None = None
    keyword: str | None = None
    tier: str
    image_url: str | None = None
    description: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    amount: Decimal | None = None
    status: str | None = None
    brand_primary: str | None = None
    brand_secondary: str | None = None
    # Sales rep who closed the deal (an admin User.username). ADMIN-ONLY —
    # deliberately absent from the public SponsorResponse above, which
    # routes/sponsors.py serves unauthenticated.
    sold_by: str | None = None

    model_config = ConfigDict(from_attributes=True)


class AdminSponsorCreate(BaseModel):
    supplier_id: UUID
    category_id: UUID | None = None
    keyword: str | None = None
    tier: str
    image_url: str | None = None
    description: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    amount: Decimal | None = None
    status: str | None = "Active"
    brand_primary: str | None = None
    brand_secondary: str | None = None
    sold_by: str | None = Field(default=None, max_length=120)

    @field_validator("image_url")
    @classmethod
    def _validate_image_url(cls, v: str | None) -> str | None:
        return validate_optional_image_url(v)

    @field_validator("brand_primary", "brand_secondary")
    @classmethod
    def _validate_brand_colors(cls, value: str | None) -> str | None:
        return validate_optional_hex_color(value)


class AdminSponsorUpdate(BaseModel):
    supplier_id: UUID | None = None
    category_id: UUID | None = None
    keyword: str | None = None
    tier: str | None = None
    image_url: str | None = None
    description: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    amount: Decimal | None = None
    status: str | None = None
    brand_primary: str | None = None
    brand_secondary: str | None = None
    sold_by: str | None = Field(default=None, max_length=120)

    @field_validator("image_url")
    @classmethod
    def _validate_image_url(cls, v: str | None) -> str | None:
        return validate_optional_image_url(v)

    @field_validator("brand_primary", "brand_secondary")
    @classmethod
    def _validate_brand_colors(cls, value: str | None) -> str | None:
        return validate_optional_hex_color(value)
