from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.db.session import get_db
from app.schemas import SponsorResponse
from app.models import Sponsor, Supplier

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
        phone=supplier.phone if supplier else None,
    )
