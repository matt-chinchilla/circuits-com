"""Pure-logic synthetic data generators for the Revenium seed tool.

Deterministic producers for:
  * daily_volume()        — weekday/weekend-aware volume curve with jitter
  * token_counts()        — uniform-range token sampling keyed by tx id
  * compute_cost()        — per-million-token cost math
  * is_anomaly_day()      — flags the single injected spike window
  * build_completions_for_day() — yields CompletionEvent objects for one day

No I/O, no network, no async. All randomness is seeded so the same inputs
always produce the same outputs across machines (for CTO demo repeatability).
"""
from __future__ import annotations

import random
import uuid
from datetime import datetime, timedelta
from typing import Iterator

from .models import CompletionEvent, CustomerOrg, Product

# ---------------------------------------------------------------- constants

_BASELINE_START = 5      # day_offset=89 volume floor
_WEEKEND_FACTOR = 0.4    # Sat/Sun multiplier
_JITTER = 0.15           # ±15%
_ANOMALY_MULTIPLIER = 10
_ANOMALY_DAY = 60
_ANOMALY_ORG = "newark"
_ANOMALY_WINDOW_HOURS = 6
_ANOMALY_START_HOUR = 10  # 10:00 UTC

_WEEKDAY_START_HOUR = 9   # 09:00 UTC
_WEEKDAY_END_HOUR = 18    # 18:00 UTC (exclusive)
_WEEKEND_START_HOUR = 6
_WEEKEND_END_HOUR = 23

_RESPONSE_MIN_MS = 400
_RESPONSE_MAX_MS = 2500


# ------------------------------------------------------------- helpers

def _rng(seed: int, org_slug: str, product_key: str, day_offset: int) -> random.Random:
    """Stable 32-bit seeded RNG keyed to (seed, org, product, day)."""
    return random.Random(hash((seed, org_slug, product_key, day_offset)) & 0xFFFFFFFF)


def _day_date(now: datetime, day_offset: int) -> datetime:
    """Return midnight UTC datetime for the given day_offset (0 = today)."""
    base = now - timedelta(days=day_offset)
    return base.replace(hour=0, minute=0, second=0, microsecond=0)


# ---------------------------------------------------------- daily_volume

def daily_volume(
    org_slug: str,
    product_key: str,
    day_offset: int,
    peak: int,
    now: datetime,
    seed: int = 42,
) -> int:
    """# completions for (org, product) on given day_offset. Never negative."""
    # Linear ramp: day 89 → _BASELINE_START, day 0 → peak.
    if day_offset >= 89:
        base = float(_BASELINE_START)
    else:
        progress = (89 - day_offset) / 89.0
        base = _BASELINE_START + (peak - _BASELINE_START) * progress

    # Weekend dip
    dt = _day_date(now, day_offset)
    if dt.weekday() >= 5:  # 5=Sat, 6=Sun
        base *= _WEEKEND_FACTOR

    # Jitter
    rng = _rng(seed, org_slug, product_key, day_offset)
    jitter = 1.0 + rng.uniform(-_JITTER, _JITTER)
    value = int(round(base * jitter))
    return max(0, value)


# ---------------------------------------------------------- token_counts

def token_counts(
    input_range: tuple[int, int],
    output_range: tuple[int, int],
    seed_key: str,
) -> tuple[int, int]:
    """Uniformly sample (input_tokens, output_tokens) from ranges."""
    rng = random.Random(hash(seed_key) & 0xFFFFFFFF)
    return rng.randint(*input_range), rng.randint(*output_range)


# ----------------------------------------------------------- compute_cost

def compute_cost(
    input_tok: int,
    output_tok: int,
    input_rate_per_mtok: float,
    output_rate_per_mtok: float,
) -> tuple[float, float, float]:
    """Return (input_cost, output_cost, total) USD, rounded to 6 decimals."""
    in_cost = round(input_tok / 1_000_000 * input_rate_per_mtok, 6)
    out_cost = round(output_tok / 1_000_000 * output_rate_per_mtok, 6)
    total = round(in_cost + out_cost, 6)
    return in_cost, out_cost, total


# -------------------------------------------------------- is_anomaly_day

def is_anomaly_day(day_offset: int, org_slug: str) -> bool:
    """True iff Newark's injected spike day (day 60)."""
    return day_offset == _ANOMALY_DAY and org_slug == _ANOMALY_ORG


# --------------------------------------------------- build_completions_for_day

def build_completions_for_day(
    org: CustomerOrg,
    product: Product,
    day_offset: int,
    now: datetime,
    seed: int = 42,
) -> Iterator[CompletionEvent]:
    """Yield one CompletionEvent per completion for this (org, product, day)."""
    count = daily_volume(org.slug, product.key, day_offset, product.peak_daily_volume, now, seed)
    anomaly = is_anomaly_day(day_offset, org.slug)
    if anomaly:
        count *= _ANOMALY_MULTIPLIER

    if count <= 0:
        return

    day_start = _day_date(now, day_offset)

    if anomaly:
        window_start_s = _ANOMALY_START_HOUR * 3600
        window_end_s = window_start_s + _ANOMALY_WINDOW_HOURS * 3600
    elif day_start.weekday() >= 5:  # weekend
        window_start_s = _WEEKEND_START_HOUR * 3600
        window_end_s = _WEEKEND_END_HOUR * 3600
    else:
        window_start_s = _WEEKDAY_START_HOUR * 3600
        window_end_s = _WEEKDAY_END_HOUR * 3600

    rng = _rng(seed + 1, org.slug, product.key, day_offset)

    for _ in range(count):
        offset_s = rng.uniform(window_start_s, window_end_s)
        request_time = day_start + timedelta(seconds=offset_s)
        duration_ms = rng.randint(_RESPONSE_MIN_MS, _RESPONSE_MAX_MS)
        response_time = request_time + timedelta(milliseconds=duration_ms)

        tx_id = str(uuid.UUID(int=rng.getrandbits(128), version=4))
        trace_id = str(uuid.UUID(int=rng.getrandbits(128), version=4))

        inp, out = token_counts(
            product.input_tokens_range, product.output_tokens_range, seed_key=tx_id
        )

        yield CompletionEvent(
            transaction_id=tx_id,
            trace_id=trace_id,
            organization_name=org.name,
            product_name=product.name,
            product_key=product.key,
            model=product.model,
            provider=product.provider,
            input_tokens=inp,
            output_tokens=out,
            total_tokens=inp + out,
            request_time=request_time,
            response_time=response_time,
            duration_ms=duration_ms,
            subscriber_email=org.contact_email,
            is_anomaly=anomaly,
        )
