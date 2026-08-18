"""Which distributor feed, if any, backs a given supplier row — and with which key.

Keyed on ``Supplier.website`` rather than on the name: a name is whatever the
admin typed ("Mouser", "Mouser Electronics", "Mouser Elec."), while the domain
is the one field that says which company this actually is. Matched as a
FRAGMENT so subdomains and full URLs (``https://www.mouser.com/``) resolve the
same as a bare ``mouser.com``.

The provider is constructed LAZILY, per call: ``MouserProvider.__init__``
raises without a key, so building the table eagerly at import time would make an
unconfigured environment fail on `import app.main` rather than on the one route
that needs a key. Callers must resolve the key FIRST — see the 404 in
``routes/suppliers.sync_supplier``.

KEY PRECEDENCE, one definition (:func:`get_feed_key`): the DB row written from
Admin → Settings wins, the environment variable is the fallback. That ordering
is the whole point of the admin card — an operator who pastes a new key expects
it to take effect, not to be shadowed by whatever the container was started
with.
"""

from sqlalchemy.orm import Session

from app.config import settings
from app.models import ProviderCredential, Supplier
from app.services.part_feed.base import PartFeedProvider
from app.services.part_feed.mouser import MouserProvider

# (domain fragment, provider class). Adding Digi-Key/Farnell is one row here
# plus the provider itself — nothing else in the sync path knows a brand name.
# The fragment doubles as the provider SLUG (the credential row's primary key).
_PROVIDERS: tuple[tuple[str, type], ...] = (("mouser", MouserProvider),)

# (slug, label) for every provider the system knows about — the ONE list the
# admin Settings card renders and `routes/feed_credentials.py` validates against,
# so adding a distributor above needs no route change and no second list.
FEED_PROVIDERS: tuple[tuple[str, str], ...] = tuple(
    (fragment, cls.supplier_name) for fragment, cls in _PROVIDERS
)


def env_feed_key(provider: str = "mouser") -> str | None:
    """The ENVIRONMENT key for a provider, or None.

    Separate from :func:`get_feed_key` because the credentials route has to tell
    the two sources apart to say which one is answering; keeping the
    slug→setting mapping here means the route never names a setting itself.
    `.strip()` so a whitespace-only value reads as unconfigured, not as a key.
    """
    if provider == "mouser":
        return (settings.MOUSER_API_KEY or "").strip() or None
    return None


def get_feed_key(db: Session, provider: str = "mouser") -> str | None:
    """The key this provider should be called with — DB row first, env fallback.

    None means the feature is off for this provider; the sync route turns that
    into its 404. An empty or whitespace-only stored value is treated as absent
    rather than as a key, so a row someone blanked out falls back to the
    environment instead of failing every call with an empty credential.
    """
    row = db.query(ProviderCredential).filter(ProviderCredential.provider == provider).first()
    stored = (row.api_key or "").strip() if row else ""
    return stored or env_feed_key(provider)


def feed_configured(db: Session, provider: str = "mouser") -> bool:
    """The boolean face of :func:`get_feed_key`, for callers that need the
    yes/no and not the value — a feature gate, mirroring how the Stripe routes
    ask about `settings.STRIPE_SECRET_KEY`. The sync route uses `get_feed_key`
    directly, because it must PASS the key it gated on to the provider.

    Takes a session: the answer depends on the database now, not just on the
    process environment.
    """
    return bool(get_feed_key(db, provider))


def match_provider(supplier: Supplier) -> tuple[str, type[PartFeedProvider]] | None:
    """The (slug, provider class) covering this supplier, or None.

    None is not an error: most suppliers in the catalog have no API at all, and
    the route turns it into a 409 against that row rather than a 404 on the
    endpoint.

    Matching and CONSTRUCTING are deliberately separate calls. The caller has to
    resolve THIS provider's key — `get_feed_key(db, slug)` — before it can build
    anything, and a single `resolve_provider(supplier)` gave it no way to learn
    which slug it had matched: it would resolve the default ("mouser") and hand
    Mouser's credential to the second distributor the day one is added, which is
    exactly the edit this table advertises as free. Returning the class rather
    than an instance is what makes the key mandatory at the construction site.
    """
    website = (supplier.website or "").strip().lower()
    if not website:
        return None
    for fragment, provider_cls in _PROVIDERS:
        if fragment in website:
            return fragment, provider_cls
    return None
