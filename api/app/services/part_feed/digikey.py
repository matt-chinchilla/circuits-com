"""DigiKey Product Information v4 — the second real distributor.

Everything here was written against a LIVE response captured on 2026-08-24 and
saved as `tests/fixtures/digikey_keyword_product.json`, not against
documentation. Three fields are shaped unlike Mouser's and would each have been
guessed wrong: `Description` is an object, `ManufacturerLeadWeeks` is a string
counting WEEKS, and a product carries several priced `ProductVariations`.

**The throughput fact the whole integration rests on, measured not assumed:**
`POST /products/v4/search/keyword` returns up to 50 products per call, each
FULLY hydrated — complete `StandardPricing` ladders, `Parameters`,
`Classifications`, `PhotoUrl`, `DatasheetUrl`. There is no per-part follow-up.
At a 1,000 call/day ceiling (confirmed live via `x-ratelimit-limit`) that is
~50,000 priced parts a day rather than 1,000, which is the difference between
covering this catalog in days and in months.

Auth is TWO-legged (`client_credentials`): a server-to-server token, no user
redirect. Three-legged would unlock `MyPricing` — the account's own negotiated
rates — and publishing those as public comparison prices would show visitors
numbers they cannot get. `StandardPricing` only, deliberately.
"""

from __future__ import annotations

import functools
import json
import logging
import pathlib
import threading
import time
import unicodedata

import httpx

from app.config import settings
from app.services.manufacturer_canon import canon
from app.services.part_feed.base import FeedPart, FeedPriceBreak

# FeedScope lives in `importer` because that is the module that CONSUMES scopes
# and owns the sweep strategies; a provider only ever constructs one. The
# direction is safe — `importer` imports `mouser`, `base` and `specmap` and
# never a provider, so there is no cycle — but its natural home is `base.py`
# beside FeedPart, which was outside this change's remit. Moving it is a
# one-line import change and is recorded as a follow-up.
from app.services.part_feed.importer import FeedScope
from app.services.part_feed.mouser import FeedFatalError
from app.services.part_feed.specmap import map_mount, map_rohs

logger = logging.getLogger(__name__)

PROD_HOST = "https://api.digikey.com"
SANDBOX_HOST = "https://sandbox-api.digikey.com"

SEARCH_WINDOW = 300
"""The hard ceiling on ``Offset + Limit`` for the v4 keyword search.

Measured live on 2026-08-24, not read in documentation (quota moved 987 -> 982,
``x-ratelimit-limit: 1000``)::

    Offset 280 + Limit 50  ->  HTTP 400
      {"title":"Bad Request","status":400,
       "detail":"Offset + Limit must be less than or equal to 300", ...}
    Offset 250 + Limit 50  ->  HTTP 200, 50 products

So every query — however many products it matches — has a 300-record window and
no more. ``ProductsCount`` for ``SN74LV`` scoped to Texas Instruments is 3,689;
348 of those 3,689 records are simply unreachable per 50 that are. That is the
single fact the whole overlap sweep is shaped around: a query has to be NARROW
before it is worth paging, and the narrowing has to come from our own catalog
because asking the API to narrow it costs a call.
"""

# DigiKey's own wording for the window refusal, lowercased for matching. Match
# on the DETAIL rather than on the bare 400, because a 400 is also what a
# malformed request gets and that one is a bug we must not swallow.
_OFFSET_WINDOW_DETAIL = "offset + limit must be less than or equal to"


class FeedWindowExhausted(Exception):
    """This query has no more readable records — NOT that the feed is down.

    Deliberately **not** a :class:`FeedFatalError`. Everything upstream treats
    a FeedFatalError as the account-wide quota wall: ``grow_catalog`` ends the
    run with "Feed unavailable" and ``jobs/feed_import_daily`` stops the whole
    night for every remaining supplier. Paging past record 300 is none of those
    things — it is one query reaching the end of what the API will serve, which
    the sweep already knows how to read (a short page means "this unit is
    finished"). Inheriting from FeedFatalError to save a line would hand the
    first family to reach the wall the power to cancel the night.
    """


# ── manufacturer scoping: our canonical key -> DigiKey's own ids ────────────
#
# `ManufacturerFilter` is what makes a family query precise enough to be worth
# a call, and it needs DigiKey's id, which nothing in our schema knows. The
# translation is GENERATED and COMMITTED — see
# `scripts/gen_digikey_manufacturers.py` for how, and for why a hand-typed map
# is a wrong price waiting to happen (a mistyped id does not fail, it narrows
# to the wrong company and writes that company's prices onto our parts).
#
# Measured 2026-08-24 against the live catalog and DigiKey's 3,718-name list:
# 454 of our 1,068 part-bearing makers match, covering 126,395 of 175,728 parts
# (71.9%) and 93,459 of 130,728 Mouser-priced ones (71.5%).

_MANUFACTURER_MAP_PATH = pathlib.Path(__file__).with_name("digikey_manufacturers.json")

# Hand-approved aliases the canon rules legitimately REFUSE to merge, because
# the rules are deliberately conservative — `canon` does not fold "USA" or a
# slash-joined division, since "Microchip USA" is a different company from
# "Microchip Technology" and that carve-out is load-bearing elsewhere. Each
# entry below was checked against DigiKey's own name, which is quoted; the
# starter set recovers ~16,700 parts the generated map cannot reach.
#
# PINS WIN over the generated map. They are code rather than data on purpose:
# the reason a pin is safe lives in the comment beside it, and a regeneration
# must never silently drop a human's decision.
#
# DELIBERATELY NOT PINNED, with the reason, because the next person will look:
#   amphenol fci / amphenol commercial products  — DigiKey lists 40+ Amphenol
#     divisions and none by these names; guessing one would scope to the wrong
#     product line.
#   te connectivity cgs                          — the only "CGS" DigiKey has
#     is "CGS Tape", an unrelated company.
#   apc by schneider electric (768 parts)        — DigiKey has "Schneider
#     Electric" but no APC; the parent is not the brand.
#   keysight (720) / pem (699)                   — DigiKey lists neither.
#   3m electronic specialty (561)                — a 3M division; "3m" is
#     already mapped, and adding it would scope the same id twice.
EXTRA_MANUFACTURER_IDS: dict[str, tuple[int, ...]] = {
    # "Analog Devices Inc." + "Analog Devices Inc./Maxim Integrated" — ADI
    # bought Maxim; DigiKey kept both rows and our catalog holds the merged
    # name. Our single largest unmatched maker at 2,975 parts.
    "analog devices maxim integrated": (505, 175),
    "vishay semiconductors": (751,),  # "Vishay Semiconductor Opto Division"
    "te connectivity amp": (17,),  # "TE Connectivity AMP Connectors"
    "same sky": (2223,),  # "Same Sky (Formerly CUI Devices)"
    "welwyn components tt electronics": (985,),  # "TT Electronics/Welwyn"
    "tripp lite": (95,),  # "Eaton Tripp Lite"
    "broadcom avago": (516,),  # "Broadcom Limited" — Avago renamed itself
    "hirose connector": (26,),  # "Hirose Electric Co Ltd"
    "airpax": (723,),  # "Sensata-Airpax"
    "vishay bc components": (56,),  # "Vishay Beyschlag/Draloric/BC Components"
    "vishay beyschlag": (56,),  # the same DigiKey row, both our spellings
    "essentra": (145,),  # "Essentra Components"
    "startech": (5214,),  # "StarTech.com"
    "nexperia": (1727,),  # "Nexperia USA Inc."
    "mill max": (54,),  # "Mill-Max Manufacturing Corp."
    "nisshinbo": (2129,),  # "Nisshinbo Micro Devices Inc."
    "telemecanique": (5452,),  # "Telemecanique Sensors"
    "radiall": (2201,),  # "Radiall USA, Inc."
    "melexis": (413,),  # "Melexis Technologies NV"
    "adafruit": (1528,),  # "Adafruit Industries LLC"
    "eaton electronics": (283,),  # "Eaton - Electronics Division"
    "molex airborn": (4134,),  # "AirBorn, a Molex company"
}


def _fold_key(name: str) -> str:
    """`canon()` plus a diacritic fold — the SAME matcher the generator used.

    `canon` NFKC-normalises but does not decompose accents, so `Würth
    Elektronik` and `Wurth Elektronik` canonicalise to different keys and would
    never meet. Our catalog stores the unaccented spelling and DigiKey stores
    the accented one, so without this fold Würth (and Schaffner, and every
    other accented maker) is simply unreachable.

    Mirrored in `scripts/gen_digikey_manufacturers.py::fold`. If you change one,
    change both — `TestTheManufacturerMap` pins that they agree.
    """
    key = canon(name or "")
    return "".join(c for c in unicodedata.normalize("NFD", key) if not unicodedata.combining(c))


@functools.lru_cache(maxsize=1)
def manufacturer_ids_by_key() -> dict[str, tuple[int, ...]]:
    """canonical_key -> DigiKey manufacturer ids, generated data plus pins.

    Read lazily and cached: a missing or corrupt file must not make
    `import app.main` fail — every other feature in this process is unrelated
    to DigiKey, and a provider that can only sweep its pinned makers is a
    degraded feed, not a down site. It IS logged, once.

    Values are TUPLES because 59 fold-keys inside DigiKey's own 3,718-name list
    collide with each other — `abracon` is ids 535 and 6290 — and picking one
    would silently sweep half a manufacturer's catalog.
    """
    loaded: dict[str, tuple[int, ...]] = {}
    try:
        raw = json.loads(_MANUFACTURER_MAP_PATH.read_text())
        for key, ids in raw.items():
            values = tuple(sorted({int(i) for i in ids}))
            if key and values:
                loaded[key] = values
    except (OSError, ValueError, TypeError) as exc:
        logger.warning(
            "[digikey] manufacturer map unreadable (%s) — falling back to the %d "
            "hand-pinned makers; regenerate with scripts/gen_digikey_manufacturers.py",
            exc,
            len(EXTRA_MANUFACTURER_IDS),
        )
    loaded.update(EXTRA_MANUFACTURER_IDS)  # pins win
    return loaded


def _text(raw) -> str | None:
    value = (raw or "").strip() if isinstance(raw, str) else None
    return value or None


def _description(raw: dict) -> str | None:
    """DigiKey's Description is an OBJECT; Mouser's is a string.

    `ProductDescription` is the terse catalog line ("IC AND 1-CIR 2-IN SC-70-5")
    and `DetailedDescription` the prose one. The terse form matches what the
    parts table already shows for Mouser rows.
    """
    node = raw.get("Description")
    if isinstance(node, str):
        return _text(node)
    if isinstance(node, dict):
        return _text(node.get("ProductDescription")) or _text(node.get("DetailedDescription"))
    return None


def _lead_time_days(raw: dict) -> int | None:
    """`ManufacturerLeadWeeks` is a STRING of WEEKS. Everything else is days.

    None, not 0, when the feed says nothing — zero would read as "available
    now", which is the opposite claim.
    """
    weeks = raw.get("ManufacturerLeadWeeks")
    try:
        value = int(str(weeks).strip())
    except (TypeError, ValueError):
        return None
    return value * 7 if value > 0 else None


def _parameter(raw: dict, *names: str) -> str | None:
    """First `Parameters[]` entry matching one of `names`, in the order given."""
    params = raw.get("Parameters") or []
    for wanted in names:
        for entry in params:
            if (entry.get("ParameterText") or "").strip().lower() == wanted.lower():
                value = _text(entry.get("ValueText"))
                # DigiKey writes "-" for "no value", which is not a value.
                if value and value != "-":
                    return value
    return None


def choose_variation(variations: list[dict] | None) -> dict | None:
    """The ONE offer this part's single listing will carry.

    A part has several packagings, each separately priced — for SN74LVC1G08DCKR
    that is Tape & Reel (MOQ 3000), Cut Tape (MOQ 1) and Digi-Reel (MOQ 1 plus
    a reeling fee). `UNIQUE(part_id, supplier_id)` allows exactly one listing
    per distributor, so this choice IS the price the site publishes.

    Ordered by what a buyer comparing prices actually wants:
      1. lowest MinimumOrderQuantity — quoting a 3000-piece reel to someone
         buying one part is the wrong number, not a cheaper one;
      2. no reeling fee, between otherwise equal offers;
      3. DigiKeyProductNumber, purely so the choice is stable across runs.

    Marketplace variations are refused outright even though the request already
    filters them: a third-party seller's price shown as DigiKey stock is a
    misrepresentation, and one guard at the boundary is worth having.
    """
    priceable = [
        v
        for v in (variations or [])
        if (v.get("StandardPricing") or []) and not v.get("MarketPlace")
    ]
    if not priceable:
        return None
    return min(
        priceable,
        key=lambda v: (
            v.get("MinimumOrderQuantity") or 0,
            float(v.get("DigiReelFee") or 0) > 0,
            v.get("DigiKeyProductNumber") or "",
        ),
    )


def part_from_digikey(raw: dict) -> FeedPart | None:
    """One v4 search product → FeedPart, or None when it cannot be keyed.

    Dropped rather than guessed when the MPN or manufacturer is missing: part
    identity is (canonical manufacturer, case-folded MPN), and a row missing
    either half cannot be deduplicated against Mouser's copy of the same part —
    which would fork the catalog into two half-answers, the exact failure the
    multi-distributor work exists to prevent.
    """
    mpn = _text(raw.get("ManufacturerProductNumber"))
    maker = _text((raw.get("Manufacturer") or {}).get("Name"))
    # The Id sits beside the Name in the SAME dict and was being read past. It
    # is what lets the family sweep confirm a row came from the maker it
    # filtered on WITHOUT comparing spellings — the check that discarded 26 of
    # 476 mapped makers, 20,752 parts, including every one of the 22 hand pins
    # whose whole justification is that the two sides spell the company
    # differently.
    maker_id = (raw.get("Manufacturer") or {}).get("Id")
    if not mpn or not maker:
        return None

    variation = choose_variation(raw.get("ProductVariations"))
    breaks: list[FeedPriceBreak] = []
    supplier_sku = None
    stock = raw.get("QuantityAvailable") or 0
    if variation is not None:
        supplier_sku = _text(variation.get("DigiKeyProductNumber"))
        # Per-packaging stock is the honest number for the offer we publish;
        # the part-level total counts packagings we are not quoting.
        if variation.get("QuantityAvailableforPackageType") is not None:
            stock = variation["QuantityAvailableforPackageType"]
        breaks = sorted(
            (
                FeedPriceBreak(
                    min_quantity=int(b["BreakQuantity"]),
                    unit_price=float(b["UnitPrice"]),
                )
                for b in variation.get("StandardPricing") or []
                if b.get("BreakQuantity") is not None and b.get("UnitPrice") is not None
            ),
            key=lambda b: b.min_quantity,
        )

    package = _parameter(raw, "Package / Case", "Supplier Device Package")
    # Reshaped into the Mouser-shaped attribute list `map_mount` expects, so the
    # SMT/THT rule keeps ONE home rather than gaining a DigiKey-flavoured copy.
    mount_attrs = [
        {"AttributeName": p.get("ParameterText"), "AttributeValue": p.get("ValueText")}
        for p in (raw.get("Parameters") or [])
    ]

    return FeedPart(
        mpn=mpn,
        manufacturer=maker,
        provider_manufacturer_id=None if maker_id is None else str(maker_id),
        description=_description(raw),
        image_url=_text(raw.get("PhotoUrl")),
        datasheet_url=_text(raw.get("DatasheetUrl")),
        supplier_sku=supplier_sku,
        stock_quantity=int(stock or 0),
        lead_time_days=_lead_time_days(raw),
        currency="USD",
        price_breaks=breaks,
        lifecycle=_text((raw.get("ProductStatus") or {}).get("Status")),
        package=package,
        mount=map_mount(mount_attrs, package),
        rohs=map_rohs((raw.get("Classifications") or {}).get("RohsStatus")),
    )


class DigiKeyProvider:
    """Two-legged OAuth client for Product Information v4.

    Rate limit is 1,000 calls/day, confirmed live from `x-ratelimit-limit`, and
    it is POOLED across every endpoint. The provider therefore reads
    `x-ratelimit-remaining` off EVERY response and walls proactively at zero
    rather than spending a call to discover it had none left.
    """

    # MUST match the name `seed.py` creates, exactly. `get_or_create_supplier`
    # keys on NAME, so a provider whose supplier_name differs by a word makes
    # `_get_or_create_supplier` mint a SECOND Digi-Key row — and renaming the
    # row in /admin does the same from the other direction, because the next
    # seed re-creates the original by name. Both were observed locally: an
    # admin rename to "Digi-Key" left two rows, and BOTH matched the registry's
    # `digikey` domain fragment, so a feed run could have written real prices
    # onto either one.
    # BOTH values, and the registry requires every declared name to be
    # present. That generalises the rule this provider used to hardcode:
    # returning the id while the secret is missing lets an operator enable a
    # nightly run that can only ever 401. The id is what TRAVELS as the single
    # resolved key; the secret is read straight from settings by the provider.
    credential_env: tuple[str, ...] = ("DIGIKEY_CLIENT_ID", "DIGIKEY_CLIENT_SECRET")

    supplier_name = "Digi-Key Electronics"
    supplier_website = "digikey.com"
    records_per_call = 50  # v4 keyword-search page size

    # WHICH SWEEP THIS PROVIDER'S IMPORT RUNS.
    #
    # "category" (Mouser's, and the default for any provider that says nothing)
    # asks "what does this distributor sell on this shelf" and CREATES the parts
    # it does not already hold. That is how the catalog was built, and it is the
    # wrong question for a second distributor: 175,728 parts already exist and
    # only Mouser can price them, so what the site needs from DigiKey is a
    # SECOND price on parts we hold — the overlap.
    #
    # "family" asks that question by enumerating (manufacturer, MPN-prefix)
    # groups from OUR OWN catalog and scoping each one with
    # `ManufacturerFilter`. It creates nothing. See `importer.FamilyStrategy`.
    import_strategy = "family"

    # The paging ceiling the sweep must respect, exposed as a CLASS attribute so
    # the strategy can read it off any provider instead of importing a
    # provider-specific constant (which would point the importer at DigiKey).
    search_window = SEARCH_WINDOW

    # The token belongs to the CLIENT, not to a provider instance, and a BOM
    # resolve builds one provider per request. Instance-level caching would
    # re-authenticate on every miss; class-level with a lock mints once and
    # shares it, exactly as MouserProvider shares its throttle stamp.
    _token_lock = threading.Lock()
    _token: str | None = None
    _token_expires_at = 0.0

    # ~120 requests/minute is the documented burst ceiling; keep a small floor
    # between calls so two concurrent runs cannot breach it together.
    _throttle_lock = threading.Lock()
    _last_call = 0.0
    _MIN_GAP_SECONDS = 0.55

    def __init__(
        self,
        client_id: str | None = None,
        client_secret: str | None = None,
        client: httpx.Client | None = None,
        host: str | None = None,
    ):
        self.client_id = client_id or (settings.DIGIKEY_CLIENT_ID or "").strip() or None
        self.client_secret = client_secret or (settings.DIGIKEY_CLIENT_SECRET or "").strip() or None
        if not (self.client_id and self.client_secret):
            raise RuntimeError(
                "DigiKey needs BOTH DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET — "
                "unlike Mouser it authenticates with a client id/secret pair, not "
                "a single key"
            )
        self.host = host or PROD_HOST
        self._client = client or httpx.Client(timeout=60)
        self.calls_made = 0
        self.last_raw_count = 0
        # `ProductsCount` off the LAST response. None = the feed did not say,
        # which is NOT zero (see `_parse`). Required by the family strategy.
        self.last_total_count: int | None = None

    @classmethod
    def from_credential(cls, key: str, client: httpx.Client | None = None) -> DigiKeyProvider:
        """Build from the CLIENT ID; the secret comes from settings.

        `get_feed_key` deals in one string per provider, and for DigiKey that
        string is the client id — which is not secret (it rides on every
        request as X-DIGIKEY-Client-Id). The secret is read here rather than
        threaded through the generic credential path, so it never lands in a
        column, a log line or a route variable that was designed for a
        single-key feed.
        """
        return cls(client_id=key, client=client)

    def close(self) -> None:
        self._client.close()

    # ── manufacturer scoping (the family sweep's narrowing device) ──────────

    @classmethod
    def manufacturer_scope(
        cls, canonical_key: str, keyword: str, label: str | None = None
    ) -> FeedScope | None:
        """A keyword query narrowed to one manufacturer, or None if unmappable.

        None means "this distributor has no id for that maker", and the sweep
        must read it as "no work here" — NEVER as "run the query unfiltered".
        An unscoped family query is 350x-652x too wide for the 300-record
        window (Texas Instruments' DigiKey catalog is 104,993 products,
        Molex's is 195,588), so it would spend a rate-limited call reading
        somebody else's inventory.

        `FeedScope.manufacturer_id` is a PROVIDER-OPAQUE token — the importer
        never parses it, it only asks whether one is present. DigiKey's token
        is a comma-separated id list because `ManufacturerFilter` takes an
        ARRAY and 16 of the 454 mapped makers legitimately have several ids
        (Abracon is 535 and 6290). Emitting one scope per id instead would
        double those makers' call cost for no extra reach.
        """
        ids = manufacturer_ids_by_key().get(canonical_key)
        if not ids:
            return None
        return FeedScope(
            keyword=keyword,
            manufacturer_id=",".join(str(i) for i in ids),
            label=label or f"{canonical_key} · {keyword}",
        )

    # ── auth ────────────────────────────────────────────────────────────────

    def _bearer(self) -> str:
        """A live access token, minted at most once per expiry window.

        Token mints are NOT counted in `calls_made`: whether they draw on the
        1,000/day pool is undocumented, so the budget carries a reserve instead
        of guessing (a wrong guess either shrinks every run's budget silently
        or hides a refresh loop from the runaway ceiling).
        """
        with self._token_lock:
            cls = type(self)
            if cls._token and time.monotonic() < cls._token_expires_at:
                return cls._token
            response = self._client.post(
                f"{self.host}/v1/oauth2/token",
                data={
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "grant_type": "client_credentials",
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            if response.status_code != 200:
                # NEVER echo the body: it can carry the client_id.
                raise FeedFatalError(
                    f"DigiKey token request failed with HTTP {response.status_code}"
                )
            payload = response.json()
            token = payload.get("access_token")
            if not token:
                raise FeedFatalError("DigiKey token response carried no access_token")
            # 60s of slack so a call cannot start on a token that expires mid-flight.
            cls._token_expires_at = time.monotonic() + max(
                60.0, float(payload.get("expires_in") or 600) - 60.0
            )
            cls._token = token
            return token

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._bearer()}",
            "X-DIGIKEY-Client-Id": self.client_id or "",
            # Pinned, and VERIFIED on the way back (see `_check_locale`).
            # Locale decides which country's StandardPricing is returned, so an
            # unpinned request can silently write euros into a USD column —
            # a false price, which is the one thing this site cannot ship.
            "X-DIGIKEY-Locale-Site": "US",
            "X-DIGIKEY-Locale-Language": "en",
            "X-DIGIKEY-Locale-Currency": "USD",
            "Content-Type": "application/json",
        }

    # ── plumbing ────────────────────────────────────────────────────────────

    def _throttle(self) -> None:
        cls = type(self)
        with cls._throttle_lock:
            gap = time.monotonic() - cls._last_call
            if gap < cls._MIN_GAP_SECONDS:
                time.sleep(cls._MIN_GAP_SECONDS - gap)
            cls._last_call = time.monotonic()

    def _post(self, path: str, payload: dict) -> dict:
        self._throttle()
        response = self._client.post(f"{self.host}{path}", headers=self._headers(), json=payload)
        self.calls_made += 1
        self._raise_for_quota(response)
        if response.status_code == 400 and self._is_window_refusal(response):
            # Translated HERE rather than in a caller, because every caller
            # would have to know the wording and the first one to forget turns
            # a paging wall back into a night-ending outage.
            raise FeedWindowExhausted(
                f"DigiKey refused Offset {payload.get('Offset')} + Limit "
                f"{payload.get('Limit')} — the search window is {SEARCH_WINDOW} records"
            )
        if response.status_code != 200:
            raise FeedFatalError(f"DigiKey {path} returned HTTP {response.status_code}")
        return response.json()

    @staticmethod
    def _is_window_refusal(response: httpx.Response) -> bool:
        """Is this 400 the ``Offset + Limit`` wall, or a real bad request?

        Reads the RFC-7807 ``detail`` field, falling back to the raw text. A
        body that is not JSON at all (an HTML error page from a proxy in front
        of the API) is NOT a paging wall — it is an outage wearing a 400, and
        swallowing it would make the sweep grind silently through every unit
        reporting nothing wrong.
        """
        try:
            detail = str((response.json() or {}).get("detail") or "")
        except (ValueError, AttributeError):
            return False
        return _OFFSET_WINDOW_DETAIL in detail.lower()

    def _raise_for_quota(self, response: httpx.Response) -> None:
        """The account-wide wall, read from the response rather than inferred.

        401/403/429 all mean "stop the night": the quota belongs to the client
        credentials, so every remaining call would be refused identically.
        `x-ratelimit-remaining` reaching 0 means the NEXT call would be, which
        is worth acting on before spending it.
        """
        if response.status_code in (401, 403, 429):
            raise FeedFatalError(
                f"DigiKey refused the request with HTTP {response.status_code} — "
                "daily quota or credentials"
            )
        remaining = response.headers.get("x-ratelimit-remaining")
        if remaining is not None:
            try:
                if int(remaining) <= 0:
                    raise FeedFatalError("DigiKey daily call quota is exhausted")
            except ValueError:
                pass

    @staticmethod
    def _check_locale(body: dict) -> None:
        locale = body.get("SearchLocaleUsed") or {}
        currency = (locale.get("Currency") or "").upper()
        if currency and currency != "USD":
            raise FeedFatalError(
                f"DigiKey answered in {currency}, not USD — refusing to store "
                "prices in the wrong currency"
            )

    def _parse(self, body: dict) -> list[FeedPart]:
        products = body.get("Products") or []
        # RAW rows, not the ones that decoded: the import cursor advances by
        # this, and advancing by survivors would re-fetch undecodable rows
        # forever.
        self.last_raw_count = len(products)
        # `ProductsCount` rides free on every response and is the overlap
        # sweep's CONTROL SIGNAL — the number that decides whether a query can
        # be read out inside the 300-record window or has to be narrowed from
        # our own SKUs first. Absent means UNKNOWN, never zero: zero would read
        # as "this family is empty, mark it done" and permanently retire a
        # family we never looked at.
        raw_total = body.get("ProductsCount")
        self.last_total_count = int(raw_total) if isinstance(raw_total, int | float) else None
        return [fp for fp in (part_from_digikey(p) for p in products) if fp is not None]

    def _window_page(self, limit: int, start_at: int) -> tuple[int, int] | None:
        """`(offset, limit)` that fits inside :data:`SEARCH_WINDOW`, or None.

        None means "do not send this request": the live API answers Offset 280
        + Limit 50 with a 400 AND still decrements `x-ratelimit-remaining`, so
        a call we already know will be refused is a call worth not making — at
        1,000 a day and 0.55 s apiece, that arithmetic is the difference
        between a sweep and a stall.

        A page that merely STRADDLES the edge is trimmed rather than dropped:
        Offset 280 + Limit 20 is a legal request for the last 20 records, and
        throwing them away would leave reachable inventory unread forever.
        """
        offset = max(0, int(start_at))
        if offset >= SEARCH_WINDOW:
            return None
        return offset, max(1, min(int(limit), self.records_per_call, SEARCH_WINDOW - offset))

    def _empty_page(self) -> list[FeedPart]:
        """What a caller sees when a query has no more readable records.

        A ZERO-row page, which every sweep already reads as "this unit is
        finished" — no new branch upstream, and `last_total_count` is left
        alone so a narrowing decision made from the previous page survives.
        """
        self.last_raw_count = 0
        return []

    # ── the Protocol ────────────────────────────────────────────────────────

    def search(self, keyword: str, limit: int = 50, start_at: int = 0) -> list[FeedPart]:
        return self._search(keyword, limit, start_at, manufacturer_id=None)

    def search_scoped(self, scope, limit: int = 50, start_at: int = 0) -> list[FeedPart]:
        """A keyword search NARROWED to one manufacturer.

        The narrowing is the whole point of the family sweep: `SN74LV` on its
        own is a catalog-wide question, `SN74LV` scoped to Texas Instruments is
        a question about parts we actually hold. Verified live across 150
        records over two makers — every `Manufacturer.Name` came back uniformly
        scoped, 0 off-scope rows — which is why the importer's `off_scope`
        counter is a cheap rot gate rather than a filter it depends on.
        """
        return self._search(scope.keyword, limit, start_at, manufacturer_id=scope.manufacturer_id)

    def _search(
        self, keyword: str, limit: int, start_at: int, *, manufacturer_id: str | None
    ) -> list[FeedPart]:
        # An EMPTY Keywords value is a 400 that still spends quota — measured.
        # Refuse it here rather than paying to learn it once per unit.
        if not (keyword or "").strip():
            raise ValueError("DigiKey keyword search needs a non-empty keyword")
        page = self._window_page(limit, start_at)
        if page is None:
            return self._empty_page()
        offset, page_limit = page
        filters: dict = {
            # Third-party sellers priced as DigiKey stock would be a
            # misrepresentation on a comparison page.
            "MarketPlaceFilter": "ExcludeMarketPlace"
        }
        if manufacturer_id is not None:
            # The token may name SEVERAL ids (see `manufacturer_scope`) —
            # `ManufacturerFilter` is an array, so one call covers them all.
            filters["ManufacturerFilter"] = [
                {"Id": part.strip()} for part in str(manufacturer_id).split(",") if part.strip()
            ]
        try:
            body = self._post(
                "/products/v4/search/keyword",
                {
                    "Keywords": keyword,
                    "Limit": page_limit,
                    "Offset": offset,
                    "FilterOptionsRequest": filters,
                },
            )
        except FeedWindowExhausted:
            # Belt to the `_window_page` braces. The clamp covers every request
            # this class sends today; the translation covers the day DigiKey
            # moves the ceiling, or a caller reaches the API another way.
            return self._empty_page()
        self._check_locale(body)
        return self._parse(body)

    def lookup_mpn(self, mpn: str) -> FeedPart | None:
        """Exact part lookup, served by the keyword endpoint.

        Deliberately NOT `/search/{n}/productdetails`: that endpoint has not
        been exercised against the live API, and the keyword search returns the
        same fully-hydrated product for the same one call. `ExactMatches` is
        preferred over the general results when DigiKey supplies it.
        """
        body = self._post(
            "/products/v4/search/keyword",
            {
                "Keywords": mpn,
                "Limit": self.records_per_call,
                "Offset": 0,
                "FilterOptionsRequest": {"MarketPlaceFilter": "ExcludeMarketPlace"},
            },
        )
        self._check_locale(body)
        candidates = (body.get("ExactMatches") or []) + (body.get("Products") or [])
        self.last_raw_count = len(body.get("Products") or [])
        wanted = mpn.strip().upper()
        for raw in candidates:
            if (raw.get("ManufacturerProductNumber") or "").strip().upper() == wanted:
                return part_from_digikey(raw)
        return None
