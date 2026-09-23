"""Sales quotes from /admin — /api/admin/quote-ladder, /sponsors/{id}/quote*.

Auth: the router carries ``require_staff`` (a customer gets 403 ``staff_only``,
a read-only viewer 403 ``read_only`` on every write). The two reads that
return a customer's billing documents — the quote list and the quote PDF —
also carry ``require_billing_reader``, which refuses a viewer on READS with
403 ``no_billing_access`` (R6). The ladder is list/founder/floor arithmetic,
not customer data, so a viewer may read it.

Pricing (R12): a quote takes ``code_points`` 0–15 and is priced by the ONE
rule in ``sales_pricing`` — the Founder's Deal less the points, never below
70% of list — so a quote and /join charge the same for the same points.

``STRIPE_SECRET_KEY`` unset → every route 404s: an unconfigured billing back
office does not exist.

Schemas live here (single consumer — the backend ≥2-consumer rule).
"""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import Sponsor, User
from app.services import billing_mirror, sales_pricing, stripe_quotes
from app.services.auth_service import require_billing_reader, require_staff
from app.services.stripe_quotes import StripeApiError

router = APIRouter(
    prefix="/api/admin",
    tags=["admin-quotes"],
    # The customer/staff wall (D16) sits on the router: everything served
    # here is company-wide STAFF data, so an activated customer is refused
    # with 403 staff_only rather than admitted as a console user.
    dependencies=[Depends(require_staff)],
)


# Stripe quote ids as Stripe mints them. Validated BEFORE interpolation into a
# request path so an id can never smuggle path segments toward Stripe's API.
_QUOTE_ID = re.compile(r"^qt_[A-Za-z0-9]{8,64}$")


def _secret_key() -> str:
    key = (settings.STRIPE_SECRET_KEY or "").strip()
    if not key:
        raise HTTPException(status_code=404, detail="Not found")
    return key


def _checked_quote_id(quote_id: str) -> str:
    if not _QUOTE_ID.fullmatch(quote_id):
        raise HTTPException(status_code=422, detail="malformed quote id")
    return quote_id


def _load_sponsor(db: Session, sponsor_id: str) -> Sponsor:
    try:
        key = uuid.UUID(sponsor_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Sponsor not found") from None
    sponsor = db.query(Sponsor).filter(Sponsor.id == key).first()
    if sponsor is None:
        raise HTTPException(status_code=404, detail="Sponsor not found")
    return sponsor


def _as_http_error(exc: StripeApiError) -> HTTPException:
    # 4xx from Stripe (or our own validation) is the caller's to fix; anything
    # else is upstream weather. The message is written to be shown in the form
    # (apiErrorDetail surfaces STRING details only, which this is).
    out_status = 422 if 400 <= exc.status < 500 else 502
    return HTTPException(status_code=out_status, detail=f"stripe: {exc.message}")


class QuoteAddress(BaseModel):
    """Customer billing address — Stripe Tax cannot place the sale without it."""

    line1: str = Field(min_length=1, max_length=200)
    line2: str | None = Field(default=None, max_length=200)
    city: str = Field(min_length=1, max_length=100)
    state: str = Field(min_length=2, max_length=2, description="Two-letter state code")
    postal_code: str = Field(min_length=5, max_length=10)

    def as_stripe(self) -> dict[str, str]:
        out = {
            "line1": self.line1,
            "city": self.city,
            "state": self.state.upper(),
            "postal_code": self.postal_code,
        }
        if self.line2:
            out["line2"] = self.line2
        return out


class QuoteCreate(BaseModel):
    """No email override ON PURPOSE: the supplier record is the billing
    identity. Quotes are created AND listed through the supplier's email —
    a per-quote override created quotes the list route could never find,
    leaving them unacceptable through the UI. A wrong billing contact is
    fixed on the supplier form, once, for every future quote.

    ``code_points`` replaced ``monthly_total`` (R12): the rep picks points,
    the server computes the price."""

    code_points: int = Field(ge=0, le=sales_pricing.MAX_CODE_POINTS)
    address: QuoteAddress


def ladder_payload() -> dict:
    """Every tier's list / Founder's Deal / floor and the price at each of the
    16 point values — server numbers only; the UI never computes a price."""
    return {
        "tiers": {
            tier: {
                "list": sales_pricing.list_usd(tier),
                "founder": sales_pricing.founder_usd(tier),
                "floor": sales_pricing.floor_usd(tier),
                "options": [
                    {"code_points": pts, "price_usd": sales_pricing.price_usd(tier, pts)}
                    for pts in range(sales_pricing.MAX_CODE_POINTS + 1)
                ],
            }
            for tier in sales_pricing.TIERS
        }
    }


@router.get("/quote-ladder")
def quote_ladder() -> dict:
    """What each point value costs, per tier (R12). ``options[0]`` is the
    Founder's Deal; the price never falls below ``floor`` (70% of list)."""
    _secret_key()
    return ladder_payload()


@router.post("/sponsors/{sponsor_id}/quote")
async def create_quote(
    sponsor_id: str,
    body: QuoteCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_staff),
) -> dict:
    key = _secret_key()
    sponsor = _load_sponsor(db, sponsor_id)
    supplier = sponsor.supplier
    email = (supplier.email or "").strip()
    if not email:
        raise HTTPException(
            status_code=422,
            detail="the supplier has no billing email — add one on the supplier record first",
        )
    async with stripe_quotes.make_client(key) as client:
        try:
            result = await stripe_quotes.create_sponsor_quote(
                client,
                sponsor_id=str(sponsor.id),
                tier=sponsor.tier or "",
                supplier_id=str(supplier.id),
                supplier_name=supplier.name,
                email=email,
                address=body.address.as_stripe(),
                code_points=body.code_points,
            )
        except StripeApiError as exc:
            raise _as_http_error(exc) from exc
    billing_mirror.audit(
        db,
        user.username,
        "quote_created",
        sponsor_id=sponsor.id,
        amount_cents=result.get("amount_total"),
        detail=f"quote {result.get('quote_id')} at {body.code_points} code points",
    )
    db.commit()
    return result


@router.get("/sponsors/{sponsor_id}/quotes")
async def sponsor_quotes(
    sponsor_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_billing_reader),
) -> dict:
    key = _secret_key()
    sponsor = _load_sponsor(db, sponsor_id)
    email = (sponsor.supplier.email or "").strip()
    if not email:
        return {"quotes": []}
    async with stripe_quotes.make_client(key) as client:
        try:
            return {
                "quotes": await stripe_quotes.list_sponsor_quotes(
                    client,
                    email=email,
                    supplier_id=str(sponsor.supplier_id),
                    sponsor_id=str(sponsor.id),
                )
            }
        except StripeApiError as exc:
            raise _as_http_error(exc) from exc


@router.post("/quotes/{quote_id}/accept")
async def accept_quote(quote_id: str) -> dict:
    key = _secret_key()
    async with stripe_quotes.make_client(key) as client:
        try:
            return await stripe_quotes.accept_quote(client, _checked_quote_id(quote_id))
        except StripeApiError as exc:
            raise _as_http_error(exc) from exc


@router.get("/quotes/{quote_id}/pdf")
async def download_quote_pdf(
    quote_id: str,
    _: User = Depends(require_billing_reader),
) -> Response:
    key = _secret_key()
    async with stripe_quotes.make_client(key) as client:
        try:
            pdf = await stripe_quotes.quote_pdf(client, _checked_quote_id(quote_id))
        except StripeApiError as exc:
            raise _as_http_error(exc) from exc
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{quote_id}.pdf"'},
    )
