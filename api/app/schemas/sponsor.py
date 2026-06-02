from datetime import date
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# Single source of truth for the v13 rep-contact column widths. Mirrors
# api/alembic/versions/011_add_sponsor_rep_fields.py exactly and is
# guarded by tests/test_sponsor_rep_fields_metadata.py so future column
# resizes update both the DB constraint AND the Pydantic max_length in
# lockstep — otherwise a width drift would surface as Postgres
# StringDataRightTruncation 500 in prod rather than Pydantic 422.
REP_FIELD_MAX = {
    "contact_name": 80,
    "role": 80,
    "phone": 40,
    "hours": 60,
    "email": 120,
    "division": 80,
    "partno": 60,
    "lettermark": 8,
    "blurb": 160,
}


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
    # CSB v13 rep-contact block — surfaced on the public banner. All 9 are
    # optional and default to None so legacy/keyword sponsors round-trip
    # without breakage.
    role: str | None = None
    hours: str | None = None
    division: str | None = None
    partno: str | None = None
    lettermark: str | None = None
    blurb: str | None = None
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
    # CSB v13 rep-contact block — admin form round-trips all 9.
    contact_name: str | None = None
    role: str | None = None
    phone: str | None = None
    hours: str | None = None
    email: str | None = None
    division: str | None = None
    partno: str | None = None
    lettermark: str | None = None
    blurb: str | None = None

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
    contact_name: str | None = Field(default=None, max_length=REP_FIELD_MAX["contact_name"])
    role: str | None = Field(default=None, max_length=REP_FIELD_MAX["role"])
    phone: str | None = Field(default=None, max_length=REP_FIELD_MAX["phone"])
    hours: str | None = Field(default=None, max_length=REP_FIELD_MAX["hours"])
    email: str | None = Field(default=None, max_length=REP_FIELD_MAX["email"])
    division: str | None = Field(default=None, max_length=REP_FIELD_MAX["division"])
    partno: str | None = Field(default=None, max_length=REP_FIELD_MAX["partno"])
    lettermark: str | None = Field(default=None, max_length=REP_FIELD_MAX["lettermark"])
    blurb: str | None = Field(default=None, max_length=REP_FIELD_MAX["blurb"])


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
    contact_name: str | None = Field(default=None, max_length=REP_FIELD_MAX["contact_name"])
    role: str | None = Field(default=None, max_length=REP_FIELD_MAX["role"])
    phone: str | None = Field(default=None, max_length=REP_FIELD_MAX["phone"])
    hours: str | None = Field(default=None, max_length=REP_FIELD_MAX["hours"])
    email: str | None = Field(default=None, max_length=REP_FIELD_MAX["email"])
    division: str | None = Field(default=None, max_length=REP_FIELD_MAX["division"])
    partno: str | None = Field(default=None, max_length=REP_FIELD_MAX["partno"])
    lettermark: str | None = Field(default=None, max_length=REP_FIELD_MAX["lettermark"])
    blurb: str | None = Field(default=None, max_length=REP_FIELD_MAX["blurb"])
