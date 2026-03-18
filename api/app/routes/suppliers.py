from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.db.session import get_db
from app.schemas import SupplierResponse
from app.models import Supplier

router = APIRouter(prefix="/api/suppliers", tags=["suppliers"])


@router.get("/", response_model=list[SupplierResponse])
def list_suppliers(db: Session = Depends(get_db)):
    return db.query(Supplier).order_by(Supplier.name).all()
