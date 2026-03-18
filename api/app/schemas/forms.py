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
    message: str | None = None


class KeywordRequestForm(BaseModel):
    company_name: str
    email: EmailStr
    keyword: str
    message: str | None = None
