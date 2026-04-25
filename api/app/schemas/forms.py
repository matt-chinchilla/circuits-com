from pydantic import BaseModel, EmailStr


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
    message: str | None = None
