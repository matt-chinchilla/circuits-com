from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Sponsor, Supplier
from app.schemas import SponsorResponse

router = APIRouter(prefix="/api/sponsors", tags=["sponsors"])


@router.get("/keyword/{keyword}", response_model=SponsorResponse)
def get_sponsor_by_keyword(keyword: str, db: Session = Depends(get_db)):
    sponsor = db.query(Sponsor).filter(Sponsor.keyword == keyword).first()
    if not sponsor:
        raise HTTPException(404, "Sponsor not found for this keyword")
    supplier = db.query(Supplier).filter(Supplier.id == sponsor.supplier_id).first()
    return SponsorResponse(
        id=sponsor.id,
        supplier_name=supplier.name if supplier else "",
        image_url=sponsor.image_url,
        description=sponsor.description,
        tier=sponsor.tier,
        website=supplier.website if supplier else None,
        phone=sponsor.phone or (supplier.phone if supplier else None),
        # SponsorResponse gained `email` + `contact_name` in commit fddba35
        # for the CategorySponsorBanner. The category route was updated;
        # this keyword route was missed — Pydantic silently defaulted them
        # to None for every keyword sponsor. Mirror category_service.
        email=sponsor.email or (supplier.email if supplier else None),
        contact_name=sponsor.contact_name or (supplier.contact_name if supplier else None),
        # CSB v13 rep-contact block — None for legacy keyword sponsors until
        # the admin form starts writing them; explicit pass-through keeps
        # the response_model from silently dropping unannotated values.
        role=sponsor.role,
        hours=sponsor.hours,
        division=sponsor.division,
        partno=sponsor.partno,
        lettermark=sponsor.lettermark,
        blurb=sponsor.blurb,
    )
