"""Distributor part-feed providers (Mouser first; Digi-Key/Farnell can slot in).

The seam: every provider maps its API's response into FeedPart, and the
importer only ever sees FeedPart — swapping or adding a distributor never
touches import logic. Provider choice is per-run, keyed by API-key presence.
"""

from app.services.part_feed.base import FeedPart, FeedPriceBreak, PartFeedProvider
from app.services.part_feed.importer import sync_event, sync_supplier_listings
from app.services.part_feed.mouser import MouserProvider
from app.services.part_feed.registry import (
    FEED_PROVIDERS,
    env_feed_key,
    feed_configured,
    get_feed_key,
    match_provider,
)

__all__ = [
    "FeedPart",
    "FeedPriceBreak",
    "PartFeedProvider",
    "MouserProvider",
    "FEED_PROVIDERS",
    "env_feed_key",
    "feed_configured",
    "get_feed_key",
    "match_provider",
    "sync_event",
    "sync_supplier_listings",
]
