from datetime import date
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, field_validator

from app.utils.color import validate_optional_hex_color
from app.utils.image_url import validate_optional_image_url


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

    @field_validator("image_url")
    @classmethod
    def _validate_image_url(cls, v: str | None) -> str | None:
        return validate_optional_image_url(v)

    @field_validator("brand_primary", "brand_secondary")
    @classmethod
    def _validate_brand_colors(cls, value: str | None) -> str | None:
        return validate_optional_hex_color(value)
