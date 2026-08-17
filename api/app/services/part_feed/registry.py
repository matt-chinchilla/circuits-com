"""Which distributor feed, if any, backs a given supplier row.

Keyed on ``Supplier.website`` rather than on the name: a name is whatever the
admin typed ("Mouser", "Mouser Electronics", "Mouser Elec."), while the domain
is the one field that says which company this actually is. Matched as a
FRAGMENT so subdomains and full URLs (``https://www.mouser.com/``) resolve the
same as a bare ``mouser.com``.

The provider is constructed LAZILY, per call: ``MouserProvider.__init__``
raises without ``MOUSER_API_KEY``, so building the table eagerly at import time
would make an unconfigured environment fail on `import app.main` rather than on
the one route that needs a key. Callers must do the key check FIRST — see the
404 in ``routes/suppliers.sync_supplier``.
"""

from app.config import settings
from app.models import Supplier
from app.services.part_feed.base import PartFeedProvider
from app.services.part_feed.mouser import MouserProvider

# (domain fragment, provider class). Adding Digi-Key/Farnell is one row here
# plus the provider itself — nothing else in the sync path knows a brand name.
_PROVIDERS: tuple[tuple[str, type], ...] = (("mouser", MouserProvider),)


def feed_configured() -> bool:
    """Single truth for "is a feed key present" — the route's 404 gate asks
    here instead of re-reading the environment, mirroring how the Stripe
    routes gate on `settings.STRIPE_SECRET_KEY`. `.strip()` so a
    whitespace-only value reads as unconfigured, not as a key.
    """
    return bool((settings.MOUSER_API_KEY or "").strip())


def resolve_provider(supplier: Supplier) -> PartFeedProvider | None:
    """The feed provider for this supplier, or None when no feed covers it.

    None is not an error: most suppliers in the catalog have no API at all, and
    the route turns it into a 409 against that row rather than a 404 on the
    endpoint.
    """
    website = (supplier.website or "").strip().lower()
    if not website:
        return None
    for fragment, provider_cls in _PROVIDERS:
        if fragment in website:
            return provider_cls()
    return None
