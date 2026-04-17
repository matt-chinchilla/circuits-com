"""Tests for revenium_seed.generators — pure-logic synthetic data generators.

Written BEFORE the implementation exists (strict TDD). Must fail on first run
with ImportError, then pass after generators.py is written.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from revenium_seed.generators import (
    build_completions_for_day,
    compute_cost,
    daily_volume,
    is_anomaly_day,
    token_counts,
)
from revenium_seed.models import CustomerOrg, Product


# ------------------------------------------------------------------ fixtures

@pytest.fixture
def now_saturday() -> datetime:
    """A known Saturday at UTC midnight. 2025-11-15 is a Saturday."""
    return datetime(2025, 11, 15, 0, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def now_wednesday() -> datetime:
    """A known Wednesday at UTC midnight. 2025-11-19 is a Wednesday."""
    return datetime(2025, 11, 19, 0, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def org() -> CustomerOrg:
    return CustomerOrg(
        slug="newark",
        name="Newark Electronics",
        website="https://newark.com",
        contact_email="demo@newark.com",
    )


@pytest.fixture
def org_mouser() -> CustomerOrg:
    return CustomerOrg(
        slug="mouser",
        name="Mouser",
        website="https://mouser.com",
        contact_email="demo@mouser.com",
    )


@pytest.fixture
def product() -> Product:
    return Product(
        key="part-lookup",
        name="Part Lookup",
        description="LLM part lookup",
        model="claude-3-5-sonnet",
        input_tokens_range=(800, 1500),
        output_tokens_range=(200, 600),
        input_cost_per_mtok_usd=3.0,
        output_cost_per_mtok_usd=15.0,
        peak_daily_volume=100,
    )


# ----------------------------------------------------------- daily_volume

def test_daily_volume_grows_over_time(now_wednesday, product):
    """Day 89 volume ~5, day 0 close to peak (±25%)."""
    slug, key, peak = "newark", "part-lookup", product.peak_daily_volume

    v_start = daily_volume(slug, key, 89, peak, now_wednesday)
    v_end = daily_volume(slug, key, 0, peak, now_wednesday)

    # Day 89 should be small (near 5, allow jitter + weekend)
    assert v_start <= 10, f"day 89 should be ~5, got {v_start}"
    # Day 0 should land in ±25% of peak (account for weekend/jitter)
    # Wednesday is a weekday, so no weekend dip at day 0.
    lower = peak * 0.75
    upper = peak * 1.25
    assert lower <= v_end <= upper, f"day 0 should be near peak {peak}, got {v_end}"


def test_daily_volume_weekend_dip(now_saturday, product):
    """Saturday volume < average of the Mon-Fri of the same week."""
    slug, key, peak = "newark", "part-lookup", product.peak_daily_volume

    # now_saturday is day_offset=0 — Saturday
    sat_v = daily_volume(slug, key, 0, peak, now_saturday)

    # Compute Mon-Fri of the same week (day_offsets -5..-1 relative to Saturday,
    # but we only use positive offsets so use prior week's Mon-Fri: offsets 1..5
    # Saturday d0 → Friday d1 → Thursday d2 → Wednesday d3 → Tuesday d4 → Monday d5
    weekday_vals = [daily_volume(slug, key, d, peak, now_saturday) for d in range(1, 6)]
    weekday_avg = sum(weekday_vals) / len(weekday_vals)

    assert sat_v < weekday_avg, (
        f"Saturday volume {sat_v} should be < weekday avg {weekday_avg}"
    )


def test_daily_volume_deterministic(now_wednesday, product):
    """Same args called twice → identical return."""
    args = ("newark", "part-lookup", 30, product.peak_daily_volume, now_wednesday)
    assert daily_volume(*args) == daily_volume(*args)


def test_daily_volume_never_negative(now_wednesday, product):
    """Sweep 100 days, all ≥ 0."""
    for d in range(100):
        v = daily_volume("newark", "part-lookup", d, product.peak_daily_volume, now_wednesday)
        assert v >= 0, f"day {d} got negative volume {v}"


# ------------------------------------------------------------- token_counts

def test_token_counts_within_range():
    """50 calls, all pairs in their ranges."""
    input_range = (100, 500)
    output_range = (50, 250)
    for i in range(50):
        inp, out = token_counts(input_range, output_range, seed_key=f"tx-{i}")
        assert input_range[0] <= inp <= input_range[1]
        assert output_range[0] <= out <= output_range[1]


# -------------------------------------------------------------- compute_cost

def test_compute_cost_math():
    """1M tokens at $3.0/Mtok → $3.0. Sum correct."""
    in_cost, out_cost, total = compute_cost(
        input_tok=1_000_000,
        output_tok=500_000,
        input_rate_per_mtok=3.0,
        output_rate_per_mtok=15.0,
    )
    assert in_cost == pytest.approx(3.0, abs=1e-6)
    assert out_cost == pytest.approx(7.5, abs=1e-6)
    assert total == pytest.approx(10.5, abs=1e-6)
    # rounded to 6 decimals
    assert round(in_cost, 6) == in_cost
    assert round(out_cost, 6) == out_cost
    assert round(total, 6) == total


# -------------------------------------------------------- is_anomaly_day

@pytest.mark.parametrize(
    "day,slug,expected",
    [
        (60, "newark", True),
        (60, "mouser", False),
        (59, "newark", False),
        (61, "newark", False),
        (0, "newark", False),
        (89, "newark", False),
    ],
)
def test_is_anomaly_day_only_newark_day60(day, slug, expected):
    assert is_anomaly_day(day, slug) is expected


# -------------------------------------------------- build_completions_for_day

def test_build_completions_yield_count_matches_volume(now_wednesday, org_mouser, product):
    """Non-anomaly day yields count within ±25% of daily_volume() for same args."""
    day = 0
    expected = daily_volume(org_mouser.slug, product.key, day, product.peak_daily_volume, now_wednesday)
    events = list(build_completions_for_day(org_mouser, product, day, now_wednesday))

    # Non-anomaly: yielded count should equal expected (same RNG key).
    # Use a tolerance band to give the impl some flexibility.
    lower = int(expected * 0.75)
    upper = int(expected * 1.25) + 1
    assert lower <= len(events) <= upper, (
        f"got {len(events)} events, expected in [{lower}, {upper}]"
    )


def test_build_completions_anomaly_10x(now_wednesday, org, product):
    """Newark day 60 yields ≥ 8× normal (allow rounding)."""
    normal = daily_volume(org.slug, product.key, 60, product.peak_daily_volume, now_wednesday)
    anomaly_events = list(build_completions_for_day(org, product, 60, now_wednesday))
    assert len(anomaly_events) >= normal * 8, (
        f"anomaly yielded {len(anomaly_events)}, expected ≥ 8× normal {normal}"
    )
    # And every event should be flagged as anomaly
    assert all(e.is_anomaly for e in anomaly_events)


def test_build_completions_events_have_valid_timestamps(now_wednesday, org_mouser, product):
    """Every event: response_time > request_time, duration_ms = delta in ms."""
    events = list(build_completions_for_day(org_mouser, product, 10, now_wednesday))
    assert events, "expected some events"
    for e in events:
        assert e.response_time > e.request_time
        delta_ms = (e.response_time - e.request_time).total_seconds() * 1000
        # Allow tiny floating error (<=1 ms)
        assert abs(e.duration_ms - delta_ms) <= 1


def test_build_completions_uuids_unique(now_wednesday, org_mouser, product):
    """No duplicate transaction_ids within a day's output."""
    events = list(build_completions_for_day(org_mouser, product, 5, now_wednesday))
    tx_ids = [e.transaction_id for e in events]
    assert len(tx_ids) == len(set(tx_ids))
    trace_ids = [e.trace_id for e in events]
    assert len(trace_ids) == len(set(trace_ids))
