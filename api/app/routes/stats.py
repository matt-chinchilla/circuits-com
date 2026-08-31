from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services.site_stats import get_site_stats

router = APIRouter(prefix="/api/stats", tags=["stats"])

# Ten minutes, matching the service's own TTL: the figures move when a feed
# import lands, not between two page loads, and a stat strip is not worth a
# revalidation round-trip. No ETag — the body is four integers, so a 304 would
# cost the same as the answer.
_STATS_CACHE_CONTROL = "public, max-age=600"


@router.get("/")
def site_stats(response: Response, db: Session = Depends(get_db)):
    """Public catalog totals — the About page's stat strip reads this.

    Deliberately unauthenticated and free of anything a competitor could not
    already count by walking the sitemap.
    """
    response.headers["Cache-Control"] = _STATS_CACHE_CONTROL
    return get_site_stats(db)
