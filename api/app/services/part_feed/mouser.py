"""Mouser Search API provider (free key: mouser.com/api-search).

Key handling: pass MOUSER_API_KEY as a process env var. Do NOT wire it
through docker-compose `environment:` (the allowlist gotcha) — run one-off
imports with `docker compose exec -e MOUSER_API_KEY=... api python -m
app.jobs.import_parts ...` so the key never lives in a file.

Rate limits (free tier): ~30 calls/min, ~1,000/day — the provider sleeps
between calls, so batch sizes (--limit) are the real throttle knob.
"""

import os
import re
import time

import httpx

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

    def __init__(self, api_key: str | None = None, client: httpx.Client | None = None):
        self.api_key = api_key or os.environ.get("MOUSER_API_KEY") or None
        if not self.api_key:
            raise RuntimeError(
                "MOUSER_API_KEY is not set — pass it via "
                "`docker compose exec -e MOUSER_API_KEY=... api ...`"
            )
        self._client = client or httpx.Client(timeout=30)
        self._last_call = 0.0

    def _throttle(self) -> None:
        wait = _CALL_GAP_SECONDS - (time.monotonic() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()

    def _post(self, path: str, body: dict) -> dict:
        self._throttle()
        resp = self._client.post(
            f"{_BASE}{path}", params={"apiKey": self.api_key}, json=body
        )
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
        # Mouser pages at 50 records; paginate so --count above 50 delivers
        # what it promised instead of silently capping.
        out: list[FeedPart] = []
        start = 0
        while len(out) < limit:
            page = min(50, limit - len(out))
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
