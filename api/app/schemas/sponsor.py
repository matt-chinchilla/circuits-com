from datetime import date
from decimal import Decimal
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
    email: str | None = None
    contact_name: str | None = None
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
