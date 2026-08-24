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

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.config import settings
from app.models import ProviderCredential, Supplier
from app.services.part_feed.base import PartFeedProvider
from app.services.part_feed.digikey import DigiKeyProvider
from app.services.part_feed.mouser import MouserProvider

# (domain fragment, provider class). Adding Digi-Key/Farnell is one row here
# plus the provider itself — nothing else in the sync path knows a brand name.
# The fragment doubles as the provider SLUG (the credential row's primary key).
_PROVIDERS: tuple[tuple[str, type], ...] = (
    ("mouser", MouserProvider),
    ("digikey", DigiKeyProvider),
)

# (slug, label) for every provider the system knows about — the ONE list the
# admin Settings card renders and `routes/feed_credentials.py` validates against,
# so adding a distributor above needs no route change and no second list.
FEED_PROVIDERS: tuple[tuple[str, str], ...] = tuple(
    (fragment, cls.supplier_name) for fragment, cls in _PROVIDERS
)


@dataclass(frozen=True)
class FeedSource:
    """One distributor, resolved: who they are, whether we can call them, at what cost.

    Exists because every consumer was repeating the same three-step dance —
    `match_provider` for the slug, `get_feed_key` for the credential (its own
    SELECT), then construct — and paying a query each time. Thirteen call sites
    did that; `live_feed_slugs` did it once PER PROVIDER, so a BOM request cost
    one primary-key read per registered distributor. Two is invisible. Fifty is
    fifty round trips per request for data that changes about once a month.

    Frozen because a resolved source is a SNAPSHOT of credential state at one
    moment. Letting a caller mutate it would invite exactly the stale-credential
    bug that not caching this at all is what avoids.
    """

    slug: str
    provider_cls: type
    credential: str | None
    budget: int

    @property
    def is_live(self) -> bool:
        """Registered AND keyed — the only claim worth making to a buyer.

        Registered alone is not it: Digi-Key sits in `_PROVIDERS` with no
        credential installed on production, and calling that a live source
        promises a refresh that has never run.
        """
        return self.credential is not None

    def provider(self) -> PartFeedProvider:
        """Build it, or say why not.

        Raises rather than returning an unkeyed provider: constructing one
        produces an object that can only ever 401, and the failure then surfaces
        one HTTP call away from the mistake instead of at it.
        """
        if self.credential is None:
            raise RuntimeError(
                f"{self.slug} has no credential — check Admin → Settings or the "
                f"{'/'.join(getattr(self.provider_cls, 'credential_env', ()))} "
                "environment values before building a provider"
            )
        return self.provider_cls.from_credential(self.credential)


class FeedSources:
    """Every registered distributor, resolved in one pass.

    The collection, not the loop: callers ask this once per request or per run
    and then answer freely, instead of each question costing a query.
    """

    def __init__(self, sources: dict[str, FeedSource]):
        self._sources = sources

    def __getitem__(self, slug: str) -> FeedSource:
        return self._sources[slug]

    def __contains__(self, slug: object) -> bool:
        return slug in self._sources

    def all(self) -> tuple[FeedSource, ...]:
        return tuple(self._sources.values())

    def live(self) -> tuple[FeedSource, ...]:
        return tuple(s for s in self._sources.values() if s.is_live)

    @property
    def live_slugs(self) -> frozenset[str]:
        return frozenset(s.slug for s in self._sources.values() if s.is_live)

    def for_supplier(self, supplier: Supplier) -> FeedSource | None:
        """This supplier's source, or None.

        Delegates to :func:`match_provider` ON PURPOSE. Matching semantics are
        deliberately unchanged by this object: a registrable-domain index would
        be O(1) instead of O(providers), but it also changes behaviour —
        `mydigikeyreseller.com` matches today by substring containment and would
        not under a domain lookup. At two providers the saving is two string
        comparisons and the risk is a supplier silently changing distributor, so
        the fragment scan stays and there remains exactly ONE definition of
        which distributor a row belongs to.
        """
        matched = match_provider(supplier)
        if matched is None:
            return None
        return self._sources.get(matched[0])


def resolve(db: Session) -> FeedSources:
    """Every provider's credential and budget, in ONE query.

    The whole point: cost does not grow with the number of registered
    distributors. One `WHERE provider IN (...)` read replaces the per-provider
    primary-key selects, and the env fallback is applied in memory afterwards,
    preserving `get_feed_key`'s DB-row-beats-environment precedence without
    restating it.

    Deliberately NOT cached. A cache would make this free on the warm path and
    would also mean a revoked or rotated credential keeps being used until
    something remembers to invalidate — a silent-failure mode in a path that
    currently has none, bought for a millisecond.
    """
    slugs = [slug for slug, _cls in _PROVIDERS]
    stored: dict[str, str] = {}
    if slugs:
        rows = (
            db.query(ProviderCredential.provider, ProviderCredential.api_key)
            .filter(ProviderCredential.provider.in_(slugs))
            .all()
        )
        stored = {row[0]: (row[1] or "").strip() for row in rows}
    return FeedSources(
        {
            slug: FeedSource(
                slug=slug,
                provider_cls=cls,
                credential=_usable_credential(slug, stored.get(slug)),
                budget=call_budget(slug),
            )
            for slug, cls in _PROVIDERS
        }
    )


def _provider_cls(provider: str) -> type | None:
    """The class registered under `provider`, or None for an unknown slug."""
    for slug, cls in _PROVIDERS:
        if slug == provider:
            return cls
    return None


def _credential_names(provider: str) -> tuple[str, ...]:
    cls = _provider_cls(provider)
    return getattr(cls, "credential_env", ()) if cls else ()


def _usable_credential(provider: str, stored: str | None) -> str | None:
    """The key to call `provider` with, or None if it cannot be called at all.

    ONE definition, shared by :func:`get_feed_key` and :func:`resolve`, and the
    reason it exists: the "every declared value is required" rule used to live
    only in :func:`env_feed_key`, so a credential STORED from Admin → Settings
    walked straight past it. A `provider_credentials` row has a single
    `api_key` column, so it can only ever supply the TRAVELLING value —
    Digi-Key's client id — while the secret is read from settings by the
    provider itself. Taking the stored row as the whole answer made a
    half-pasted credential resolve, and `FeedSource.is_live` is what the PUBLIC
    BOM tool renders as "live feed": it would have told buyers a distributor's
    prices came from a live source that has never authenticated. That is a
    worse failure than the feed run 401ing, and it is the exact false claim the
    provenance work exists to prevent.

    Precedence is unchanged and still stated once: the stored row beats the
    environment.
    """
    names = _credential_names(provider)
    # Everything BEYOND the travelling value can only come from settings, so a
    # stored row cannot complete a multi-value credential on its own. A provider
    # declaring nothing has no supporting values to be missing, and its stored
    # row is the whole answer — narrowing that to "undeclared means unusable"
    # broke `test_each_provider_is_called_with_ITS_OWN_key`, whose fake provider
    # classes declare no credential_env.
    if names and not all((getattr(settings, name, None) or "").strip() for name in names[1:]):
        return None
    return (stored or "").strip() or env_feed_key(provider)


def env_feed_key(provider: str) -> str | None:
    """The ENVIRONMENT key for a provider, or None.

    Separate from :func:`get_feed_key` because the credentials route has to tell
    the two sources apart to say which one is answering.

    NAMES NO PROVIDER. This used to be an `if provider == "mouser" / elif
    "digikey"` ladder, which meant a third distributor got a registry entry, an
    admin Settings card row (derived from `_PROVIDERS`) and a silent
    "unconfigured" forever — the operator sees the card, pastes the key, and
    nothing happens, with no error anywhere. Each provider now declares its own
    `credential_env` and this function just reads the declaration, so the ladder
    cannot fall behind the table again.

    EVERY declared name is required. That generalises the rule Digi-Key used to
    hardcode rather than special-casing it: a provider needing an id and a
    secret must not resolve on the id alone, or an operator can enable a nightly
    run that can only ever 401. The FIRST declared value is the one that
    travels; anything else the provider reads from settings itself.

    `.strip()` so a whitespace-only value reads as unconfigured, not as a key.

    NO DEFAULT SLUG, here or on the three functions below. `provider="mouser"`
    meant a caller who forgot the argument silently resolved MOUSER's key —
    harmless while Mouser was the only distributor, and a wrong-credential bug
    with no error the moment there are two. Only four call sites relied on it,
    all in one test file.
    """
    cls = _provider_cls(provider)
    names: tuple[str, ...] = getattr(cls, "credential_env", ()) if cls else ()
    if not names:
        return None
    values = [(getattr(settings, name, None) or "").strip() for name in names]
    return values[0] if all(values) else None


def call_budget(provider: str) -> int:
    """This distributor's own daily API-call allowance.

    Quotas are NOT pooled in reality — Mouser and Digi-Key each sell ~1,000
    calls/day — but the nightly job spent a single `FEED_IMPORT_CALL_BUDGET`
    across whichever providers it reached. With two that is merely wasteful:
    whichever one the sweep reaches first can eat the other's day, and the
    second hits a quota wall that reads like a provider outage. It is also what
    makes a reach estimate unstateable, because "how much of the catalog can we
    price tonight" only has an answer per distributor.

    Lives in settings rather than on the provider class because a budget is an
    OPERATOR fact: an API tier changes without the code changing. The scalar
    stays the fallback so adding a distributor needs no ops change before it can
    run at all.
    """
    overrides = getattr(settings, "FEED_IMPORT_CALL_BUDGETS", None) or {}
    return int(overrides.get(provider, settings.FEED_IMPORT_CALL_BUDGET))


def get_feed_key(db: Session, provider: str) -> str | None:
    """The key this provider should be called with — DB row first, env fallback.

    None means the feature is off for this provider; the sync route turns that
    into its 404. An empty or whitespace-only stored value is treated as absent
    rather than as a key, so a row someone blanked out falls back to the
    environment instead of failing every call with an empty credential.
    """
    row = db.query(ProviderCredential).filter(ProviderCredential.provider == provider).first()
    return _usable_credential(provider, row.api_key if row else None)


def feed_configured(db: Session, provider: str) -> bool:
    """The boolean face of :func:`get_feed_key`, for callers that need the
    yes/no and not the value — a feature gate, mirroring how the Stripe routes
    ask about `settings.STRIPE_SECRET_KEY`. The sync route uses `get_feed_key`
    directly, because it must PASS the key it gated on to the provider.

    Takes a session: the answer depends on the database now, not just on the
    process environment.
    """
    return bool(get_feed_key(db, provider))


def live_feed_slugs(db: Session) -> frozenset[str]:
    """Every provider slug we could call RIGHT NOW — registered AND keyed.

    This is the CREDENTIAL half of "is a live source behind this supplier's
    price". The supplier half stays with :func:`match_provider`, so there is
    exactly one definition of which distributor a row belongs to and this
    function never learns a domain fragment.

    Built on :func:`feed_configured` rather than on ``_PROVIDERS`` alone,
    because matching the table is not the claim. Digi-Key has sat in
    ``_PROVIDERS`` with no credential installed, and a supplier row we cannot
    call is not a live source — labelling it one promises buyers a refresh that
    has never run. Going through `feed_configured` also keeps the
    DB-row-beats-environment precedence in its ONE home (:func:`get_feed_key`)
    instead of restating it here.

    Cost is ONE query total, not one per provider: it delegates to
    :func:`resolve`, which reads every credential in a single
    ``WHERE provider IN (...)``. It used to issue a primary-key select per
    registered distributor — fine at two, fifty round trips at fifty, for data
    that changes about once a month. Callers must still hoist it out of any
    per-row loop (:func:`app.services.bom_match.build_row` takes the result as
    a REQUIRED argument precisely so a caller cannot quietly pay for it per
    row): one query is cheap, five hundred of them is not.

    A measured figure used to live in this comment and in two others. It said
    0.794 ms and nobody could reproduce it — the author's own re-measure said
    1.397 ms and an independent one said 1.554 ms median. No number is quoted
    here now: the cost is a function of round trips, and the round-trip count
    is the thing the tests pin (`test_provider_scaling.py` asserts it does not
    grow when a third provider is registered).

    SEE ALSO :func:`app.services.bom_resolve.pick_feed_source`, which asks a
    near-identical question for a different purpose: it wants the FIRST
    supplier it can actually call, so it iterates ``Supplier`` rows and returns
    a constructed provider; this wants the SET of slugs that are callable at
    all, so it touches no supplier. Both funnel through :func:`get_feed_key`,
    so neither is a second home for the key precedence — but two functions
    asking "which providers can we call" with no pointer between them is how a
    third one gets written.
    """
    return resolve(db).live_slugs


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
