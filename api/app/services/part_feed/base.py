"""Provider-agnostic shapes for distributor part feeds."""

from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class FeedPriceBreak:
    min_quantity: int
    unit_price: float


@dataclass
class FeedPart:
    mpn: str
    manufacturer: str
    description: str | None = None
    image_url: str | None = None
    datasheet_url: str | None = None
    supplier_sku: str | None = None
    stock_quantity: int = 0
    lead_time_days: int | None = None
    currency: str = "USD"
    price_breaks: list[FeedPriceBreak] = field(default_factory=list)


class PartFeedProvider(Protocol):
    """What the importer needs from any distributor API."""

    supplier_name: str
    supplier_website: str

    # Call accounting — the import sweep spends a fixed daily budget of API
    # calls, so it has to read what a run has already cost. `calls_made`
    # counts every request the provider sent (a rejected call spent quota
    # too); `records_per_call` is the provider's page size, which is what
    # turns a requested record count back into a number of calls.
    calls_made: int
    records_per_call: int

    def search(self, keyword: str, limit: int = 50) -> list[FeedPart]:
        """Keyword search — used to fill a category with parts."""
        ...

    def lookup_mpn(self, mpn: str) -> FeedPart | None:
        """Exact part lookup — used to backfill images/datasheets."""
        ...
