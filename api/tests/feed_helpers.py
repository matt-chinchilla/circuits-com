"""Shared builders for suites that exercise the part-feed seam.

One FakeProvider / feed_part serves both test_part_feed and
test_supplier_sync_route — a field added to FeedPart gets updated HERE, once,
instead of leaving one suite green and the other stale (review-caught: the two
files had drifted into near-identical private copies).
"""

from app.services.part_feed.base import FeedPart, FeedPriceBreak


class FakeProvider:
    """A provider that answers from a dict — no network, no key, no sleep."""

    supplier_name = "Mouser Electronics"
    supplier_website = "mouser.com"

    def __init__(self, by_mpn=None, search_results=None):
        self.by_mpn = by_mpn or {}
        self.search_results = search_results or []

    def search(self, keyword, limit=50):
        return self.search_results[:limit]

    def lookup_mpn(self, mpn):
        return self.by_mpn.get(mpn)


def feed_part(
    mpn: str = "FEED-001",
    manufacturer: str = "Feed Mfr",
    image: str | None = "https://img.example/p.jpg",
    breaks: bool = True,
) -> FeedPart:
    return FeedPart(
        mpn=mpn,
        manufacturer=manufacturer,
        description="10uF 25V ceramic capacitor 0805",
        image_url=image,
        datasheet_url="https://docs.example/d.pdf",
        supplier_sku=f"621-{mpn}",
        stock_quantity=500,
        lead_time_days=7,
        price_breaks=[FeedPriceBreak(1, 0.10), FeedPriceBreak(100, 0.08)] if breaks else [],
    )
