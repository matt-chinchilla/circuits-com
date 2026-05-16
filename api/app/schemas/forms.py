from typing import Literal

from pydantic import BaseModel, EmailStr

# Tier enum shared between JoinForm and KeywordRequestForm. Constrains the
# field to the three sponsorship tiers (matching `SPONSOR_TIERS` in
# frontend/src/public/pages/keyword-landing/constants.ts) so a malformed
# request fails fast at the Pydantic layer instead of silently propagating
# into the notify-email body or the Message.payload JSON.
SponsorTier = Literal["silver", "gold", "platinum"]


class ContactForm(BaseModel):
    name: str
    email: EmailStr
    subject: str
    message: str


class JoinForm(BaseModel):
    company_name: str
    contact_person: str
    email: EmailStr
    phone: str
    website: str | None = None
    categories_of_interest: list[str] = []
    # Sponsorship tier picked in the JoinPage form ('silver' | 'gold' | 'platinum').
    # Optional so older callers without the field still validate; n8n receives it
    # in the webhook payload when present so the success-receipt UI's chosen tier
    # actually reaches the team's intake pipeline.
    tier: str | None = None
    message: str | None = None


class KeywordRequestForm(BaseModel):
    company_name: str
    email: EmailStr
    keyword: str
    # Name and tier landed 2026-05-16 with the v2 RequestModal design parity.
    # `name` mirrors JoinForm.contact_person — required at the API edge so the
    # FE's required-attribute is enforced server-side too. `tier` constrains
    # to the SponsorTier literal so a malformed payload returns 422 instead
    # of silently embedding arbitrary text into the notification email.
    name: str
    tier: SponsorTier | None = None
    message: str | None = None
