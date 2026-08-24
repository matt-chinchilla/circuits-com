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

import threading
import time

import httpx

from app.config import settings
from app.services.part_feed.base import FeedPart, FeedPriceBreak
from app.services.part_feed.mouser import FeedFatalError
from app.services.part_feed.specmap import map_mount, map_rohs

PROD_HOST = "https://api.digikey.com"
SANDBOX_HOST = "https://sandbox-api.digikey.com"


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
    supplier_name = "Digi-Key Electronics"
    supplier_website = "digikey.com"
    records_per_call = 50  # v4 keyword-search page size

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

    @classmethod
    def from_credential(cls, key: str) -> DigiKeyProvider:
        """Build from the CLIENT ID; the secret comes from settings.

        `get_feed_key` deals in one string per provider, and for DigiKey that
        string is the client id — which is not secret (it rides on every
        request as X-DIGIKEY-Client-Id). The secret is read here rather than
        threaded through the generic credential path, so it never lands in a
        column, a log line or a route variable that was designed for a
        single-key feed.
        """
        return cls(client_id=key)

    def close(self) -> None:
        self._client.close()

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
        if response.status_code != 200:
            raise FeedFatalError(f"DigiKey {path} returned HTTP {response.status_code}")
        return response.json()

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
        return [fp for fp in (part_from_digikey(p) for p in products) if fp is not None]

    # ── the Protocol ────────────────────────────────────────────────────────

    def search(self, keyword: str, limit: int = 50, start_at: int = 0) -> list[FeedPart]:
        body = self._post(
            "/products/v4/search/keyword",
            {
                "Keywords": keyword,
                "Limit": min(limit, self.records_per_call),
                "Offset": start_at,
                # Third-party sellers priced as DigiKey stock would be a
                # misrepresentation on a comparison page.
                "FilterOptionsRequest": {"MarketPlaceFilter": "ExcludeMarketPlace"},
            },
        )
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
