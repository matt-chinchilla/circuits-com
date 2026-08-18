"""Mouser Search API provider (free key: mouser.com/api-search).

Key handling: the api container reads MOUSER_API_KEY, mapped in
docker-compose.yml / docker-compose.prod.yml from the HOST env var
MOUSER_SEARCH_API_KEY (empty default = feature off, 404 posture). Never
pass the key on a command line (shell history keeps it) and never let it
reach code, logs, or error text — `_post` already guarantees the latter.

Rate limits (free tier): ~30 calls/min, ~1,000/day — the provider sleeps
between calls, so batch sizes (--limit) are the real throttle knob.
"""

import math
import re
import threading
import time

import httpx

from app.config import settings
from app.services.part_feed.base import FeedPart, FeedPriceBreak

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
    """'14 Days' -> 14; absent/odd -> None."""
    if not text:
        return None
    m = re.search(r"(\d+)", text)
    return int(m.group(1)) if m else None


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
    )


class MouserProvider:
    supplier_name = "Mouser Electronics"
    supplier_website = "mouser.com"
    records_per_call = 50  # Mouser's keyword-search page size

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

    def close(self) -> None:
        """Release the HTTP connection pool. The sync route builds one
        provider per run and closes it when the stream ends; without this the
        keep-alive sockets sit until GC."""
        self._client.close()

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
        self._throttle()
        # Counted BEFORE the request, not after a 2xx: the quota is spent when
        # the call leaves, and a run that only counted successes would loop on
        # a failing key forever.
        self.calls_made += 1
        resp = self._client.post(f"{_BASE}{path}", params={"apiKey": self.api_key}, json=body)
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

    def search(self, keyword: str, limit: int = 50) -> list[FeedPart]:
        """Keyword search. COSTS AT MOST ``ceil(limit / records_per_call)``
        calls — one per page — so a caller with a call budget bounds the spend
        by the SIZE it asks for (pagination happens in here, out of the
        caller's reach).

        That ceiling is a HARD PAGE CAP, not a by-product of the loop
        condition: the loop measures PARSED parts, so a page whose rows partly
        fail to decode (no MPN/manufacturer) would otherwise leave
        `len(out) < limit` and buy another page — a caller who budgeted one
        call spending two. Undecodable rows shorten the RESULT; they never
        raise the COST."""
        # Mouser pages at 50 records; paginate so --count above 50 delivers
        # what it promised instead of silently capping.
        out: list[FeedPart] = []
        start = 0
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
