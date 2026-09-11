"""GET /api/data-versions — "has anything changed since I last looked?"

The one read the console makes BEFORE deciding to refetch a cached payload
(see services/data_versions.py). Gated by ``get_current_user`` rather than
the customer/staff wall on purpose: staff and customers both keep a cache and
the answer is opaque hashes with nothing to protect, so one door serves both
(it is listed in test_every_route_is_gated.EXEMPT_FROM_THE_WALL for that).
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import User
from app.services.auth_service import get_current_user
from app.services.data_versions import data_versions

router = APIRouter(prefix="/api/data-versions", tags=["dashboard"])


@router.get("")
def get_data_versions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return {"scopes": data_versions(db)}
