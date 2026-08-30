"""Mouser Search API provider (free key: mouser.com/api-search).

Key handling: the api container reads MOUSER_API_KEY, mapped in
docker-compose.yml / docker-compose.prod.yml from the HOST env var
MOUSER_SEARCH_API_KEY (empty default = feature off, 404 posture). Never
pass the key on a command line (shell history keeps it) and never let it
reach code, logs, or error text — `_post` already guarantees the latter.

Rate limits (free tier): ~30 calls/min, ~1,000/day — the provider sleeps
between calls, so batch sizes (--limit) are the real throttle knob.
"""

import logging
import math
import re
import threading
import time

import httpx

from app.config import settings
from app.services.part_feed.base import FeedPart, FeedPriceBreak, send_with_retries
from app.services.part_feed.specmap import map_mount, map_rohs

# Mouser's API takes the key ONLY as a `?apiKey=` query parameter, and httpx
# logs every request URL at INFO — which printed the live production key into
# the container logs on every call (seen in the feed-import log 2026-08-28).
# The logger is capped at WARNING here, in the module that puts the secret in
# the URL, so every process that can make the call (api, feed-import, jobs)
# inherits the redaction without each entrypoint remembering to.
logging.getLogger("httpx").setLevel(logging.WARNING)

_BASE = "https://api.mouser.com/api/v1"
_CALL_GAP_SECONDS = 2.1  # ~28/min, under the 30/min ceiling


class FeedFatalError(RuntimeError):
    """Auth/quota failure — retrying other work only burns more quota.
    Batch loops must ABORT on this, not continue per-item."""


def _parse_availability(text: str | None) -> int:
    """'12,345 In Stock' -> 12345; anything else -> 0."""
    if not text:
        return 0
    m = re.search(r"([\d,]+)", text)
    return int(m.group(1).replace(",", "")) if m else 0


def _parse_lead_time(text: str | None) -> int | None:
    """'14 Days' -> 14; '6 Weeks' -> 42; bare number -> days; absent/odd -> None.

    Weeks-aware since search v2 (§1.2), deliberately IN PLACE — this is the
    single home, so PartListing.lead_time_days changes for week-denominated
    feed values too (6 was wrong; 42 is right)."""
    if not text:
        return None
    m = re.search(r"(\d+)", text)
    if not m:
        return None
    days = int(m.group(1))
    if re.search(r"week", text, re.IGNORECASE):
        days *= 7
    return days


def _parse_price(text: str | None) -> float | None:
    """Locale-tolerant money parse: '$0.52', '0,52 €', '1.234,56', '1,234'.

    Both separators present -> the LAST one is the decimal point. A lone
    comma is a decimal ONLY when followed by 1-2 digits ('0,52'); otherwise
    it is thousands grouping ('1,234' is 1234, not 1.234 — a 1000x error
    caught in review)."""
    if not text:
        return None
    cleaned = re.sub(r"[^\d.,]", "", text)
    if not cleaned:
        return None
    if "," in cleaned and "." in cleaned:
        if cleaned.rfind(",") > cleaned.rfind("."):
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    elif "," in cleaned:
        head, _, tail = cleaned.rpartition(",")
        if cleaned.count(",") == 1 and 1 <= len(tail) <= 2:
            cleaned = head + "." + tail
        else:
            cleaned = cleaned.replace(",", "")
    try:
        return float(cleaned)
    except ValueError:
        return None


def part_from_mouser(raw: dict) -> FeedPart | None:
    """Map one entry of SearchResults.Parts into a FeedPart."""
    mpn = (raw.get("ManufacturerPartNumber") or "").strip()
    manufacturer = (raw.get("Manufacturer") or "").strip()
    if not mpn or not manufacturer:
        return None
    breaks = []
    for pb in raw.get("PriceBreaks") or []:
        price = _parse_price(pb.get("Price"))
        qty = pb.get("Quantity")
        if price is not None and isinstance(qty, int) and qty > 0:
            breaks.append(FeedPriceBreak(min_quantity=qty, unit_price=price))
    # DEFENSIVE: the Mouser field names for these two were never verified
    # against a live response, so an absent key must degrade to None (the
    # part then renders unverified) rather than fabricate a claim.
    lifecycle = (raw.get("LifecycleStatus") or "").strip() or None
    package = None
    for attr in raw.get("ProductAttributes") or []:
        name = (attr.get("AttributeName") or "").strip().lower()
        if name in ("package / case", "package/case", "package"):
            package = (attr.get("AttributeValue") or "").strip() or None
            break
    return FeedPart(
        mpn=mpn,
        manufacturer=manufacturer,
        description=(raw.get("Description") or "").strip() or None,
        image_url=(raw.get("ImagePath") or "").strip() or None,
        datasheet_url=(raw.get("DataSheetUrl") or "").strip() or None,
        supplier_sku=(raw.get("MouserPartNumber") or "").strip() or None,
        stock_quantity=_parse_availability(raw.get("Availability")),
        lead_time_days=_parse_lead_time(raw.get("LeadTime")),
        currency=(raw.get("PriceBreaks") or [{}])[0].get("Currency") or "USD",
        price_breaks=breaks,
        lifecycle=lifecycle,
        package=package,
        mount=map_mount(raw.get("ProductAttributes"), package),
        rohs=map_rohs(raw.get("ROHSStatus")),
    )


class MouserProvider:
    # The environment settings this provider needs, ALL of them required. The
    # registry reads this instead of knowing Mouser by name — see
    # registry.env_feed_key. One value here; Digi-Key declares two.
    credential_env: tuple[str, ...] = ("MOUSER_API_KEY",)

    supplier_name = "Mouser Electronics"
    supplier_website = "mouser.com"
    records_per_call = 50  # Mouser's keyword-search page size

    # FAMILY windows, not category keywords (2026-08-30). The 99 category
    # keywords exhausted their reachable slice (~130k of Mouser's 8.4M parts)
    # and the sweep was wrapping back over fully-known pages — measured live:
    # 105 calls, 4,949 rows, 25 new. MPN-prefix families derived from our own
    # catalog open fresh windows anywhere in the space.
    import_strategy = "family"

    # The rate ceiling belongs to the API KEY, not to a provider instance, and
    # the sync route builds ONE provider per run — two admins syncing at once
    # are two instances in two threadpool threads. Per-instance timestamps let
    # them both fire at full speed and blow the ~30/min limit for the account,
    # so the last-call stamp and its lock are CLASS-level shared state.
    # 0.0 means "long ago" (monotonic() - 0 is huge), so a first call in a
    # fresh process never sleeps — exactly the previous behaviour.
    _throttle_lock = threading.Lock()
    _last_call = 0.0

    def __init__(self, api_key: str | None = None, client: httpx.Client | None = None):
        self.api_key = api_key or (settings.MOUSER_API_KEY or "").strip() or None
        if not self.api_key:
            raise RuntimeError(
                "MOUSER_API_KEY is not set — set MOUSER_SEARCH_API_KEY in the host "
                ".env; docker-compose maps it into the container (see module docstring)"
            )
        self._client = client or httpx.Client(timeout=30)
        # Per-INSTANCE (unlike the throttle stamp): a budget belongs to the
        # run that set it, and the sync/import routes build one provider per
        # run. Counting is what the import sweep spends against `call_budget`.
        self.calls_made = 0
        # RAW rows the last `search` received (see the Protocol in base.py):
        # the import cursor advances by this, so it counts rows the API
        # returned, not the ones that decoded.
        self.last_raw_count = 0

    @classmethod
    def from_credential(cls, key: str, client: "httpx.Client | None" = None) -> "MouserProvider":
        """Build from the one string `get_feed_key` resolved.

        The seam that lets a provider decide what constructing it needs:
        Mouser's whole credential IS this key, while DigiKey's is half of a
        pair. Callers no longer assume `provider_cls(api_key=…)` fits every
        feed.
        """
        return cls(api_key=key, client=client)

    def close(self) -> None:
        """Release the HTTP connection pool. The sync route builds one
        provider per run and closes it when the stream ends; without this the
        keep-alive sockets sit until GC."""
        self._client.close()

    @classmethod
    def manufacturer_scope(cls, canonical_key: str, keyword: str, label: str | None = None):
        """A family window, deliberately UNSCOPED — Mouser's search has no
        manufacturer filter to ask for.

        This is NOT the sin FeedScopeUnsupported exists to prevent (dropping a
        REQUESTED filter silently): no filter is ever requested, `search_scoped`
        takes its documented bare-keyword path, and `_resolve_maker`
        name-verifies every row against the family's maker — anyone else's rows
        are counted off-scope, never priced. The economics also differ from
        DigiKey's refusal rationale: DigiKey serves a hard 300-record window
        (unscoped = reading somebody else's inventory), while Mouser pages
        keyword results deeply, so an unscoped prefix window can actually be
        read out. `canonical_key` is unused by construction — every maker gets
        the same bare window and the absorb side sorts the rows.
        """
        from app.services.part_feed.importer import FeedScope  # circular at module load only

        return FeedScope(keyword=keyword, label=label)

    def _throttle(self) -> None:
        """Hold the account-wide gap before the next call.

        SLOT RESERVATION, not a plain stamp-after-sleep: under the lock the
        caller computes its wait and immediately moves `_last_call` to when
        its own call will actually FIRE (now + wait), then sleeps outside the
        lock. Two threads therefore reserve consecutive slots and queue up.
        Stamping only after the sleep would let both read the same old value,
        both compute zero wait, and both fire at once — the exact burst the
        gap exists to prevent. Sleeping under the lock would work but would
        block every other thread inside the critical section.
        """
        with MouserProvider._throttle_lock:
            wait = max(0.0, _CALL_GAP_SECONDS - (time.monotonic() - MouserProvider._last_call))
            MouserProvider._last_call = time.monotonic() + wait
        if wait > 0:
            time.sleep(wait)

    def _post(self, path: str, body: dict) -> dict:
        def _send() -> httpx.Response:
            # Throttle + count INSIDE the attempt: a retry must re-pace the
            # account-wide gap, and it spends real quota — counted BEFORE the
            # request, not after a 2xx, so a run that only counted successes
            # can't loop on a failing key forever.
            self._throttle()
            self.calls_made += 1
            return self._client.post(f"{_BASE}{path}", params={"apiKey": self.api_key}, json=body)

        resp = send_with_retries(_send, f"Mouser {path}")
        # NEVER raise_for_status / chain httpx errors: their messages embed
        # the full request URL, and the key rides the query string — a bad
        # key would print itself into the operator's terminal (review-caught).
        if resp.status_code >= 400:
            msg = f"Mouser API HTTP {resp.status_code} on {path}"
            if resp.status_code in (401, 403, 429):
                raise FeedFatalError(msg)
            raise RuntimeError(msg)
        data = resp.json()
        errors = data.get("Errors") or []
        if errors:
            raise RuntimeError(f"Mouser API error: {errors}")
        return data

    def search(self, keyword: str, limit: int = 50, start_at: int = 0) -> list[FeedPart]:
        """Keyword search. COSTS AT MOST ``ceil(limit / records_per_call)``
        calls — one per page — so a caller with a call budget bounds the spend
        by the SIZE it asks for (pagination happens in here, out of the
        caller's reach).

        That ceiling is a HARD PAGE CAP, not a by-product of the loop
        condition: the loop measures PARSED parts, so a page whose rows partly
        fail to decode (no MPN/manufacturer) would otherwise leave
        `len(out) < limit` and buy another page — a caller who budgeted one
        call spending two. Undecodable rows shorten the RESULT; they never
        raise the COST.

        ``start_at`` is where in Mouser's result set to begin (its
        ``startingRecord``) — the depth an import cursor keeps per category so
        the next run reads PAST what the last one absorbed. It shifts the
        window; it does NOT widen it, so the page cap above stays relative to
        ``limit`` alone.

        ``last_raw_count`` is left holding the RAW rows this call received
        (decoded or not) — the number the cursor must advance by."""
        # Mouser pages at 50 records; paginate so --count above 50 delivers
        # what it promised instead of silently capping.
        out: list[FeedPart] = []
        start = start_at
        # Per-search, never cumulative: a stale count would make an empty
        # category look like a full page and never register as exhausted.
        self.last_raw_count = 0
        pages_left = max(1, math.ceil(limit / self.records_per_call))
        while len(out) < limit and pages_left > 0:
            pages_left -= 1
            page = min(self.records_per_call, limit - len(out))
            data = self._post(
                "/search/keyword",
                {
                    "SearchByKeywordRequest": {
                        "keyword": keyword,
                        "records": page,
                        "startingRecord": start,
                    }
                },
            )
            raw_parts = (data.get("SearchResults") or {}).get("Parts") or []
            if not raw_parts:
                break
            self.last_raw_count += len(raw_parts)
            for raw in raw_parts:
                part = part_from_mouser(raw)
                if part is not None:
                    out.append(part)
            if len(raw_parts) < page:
                break
            start += len(raw_parts)
        return out[:limit]

    def lookup_mpn(self, mpn: str) -> FeedPart | None:
        data = self._post(
            "/search/partnumber",
            {"SearchByPartRequest": {"mouserPartNumber": mpn}},
        )
        raw_parts = (data.get("SearchResults") or {}).get("Parts") or []
        for raw in raw_parts:
            part = part_from_mouser(raw)
            # partnumber search is prefix-fuzzy — demand the exact MPN
            if part is not None and part.mpn.upper() == mpn.upper():
                return part
        return None
