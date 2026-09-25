"""The ONE price rule (spec §4) — every worked value the spec pins, the 30% floor,
and the cross-language guard that the Join cards advertise what we charge."""

import pathlib
import re

import pytest

import app
from app.services import sales_pricing as sp


def test_this_suite_imports_the_app_it_sits_beside():
    """A worktree checkout must test ITS code, never the editable install's."""
    here = pathlib.Path(__file__).resolve().parents[1]
    assert pathlib.Path(app.__file__).resolve().is_relative_to(here)


@pytest.mark.parametrize(
    "tier,pts,expected",
    [
        ("silver", 0, 210),
        ("gold", 0, 2100),
        ("platinum", 0, 8500),
        ("gold", 10, 1850),
        ("gold", 15, 1750),
        ("platinum", 10, 7500),
        ("platinum", 15, 7000),
        ("silver", 15, 175),
        ("silver", 10, 185),
    ],
)
def test_price_table(tier, pts, expected):
    assert sp.price_usd(tier, pts) == expected


def test_never_below_seventy_percent_of_list():
    for tier in sp.TIERS:
        for pts in range(0, sp.MAX_CODE_POINTS + 1):
            assert sp.price_usd(tier, pts) >= sp.list_usd(tier) * 70 // 100


def test_list_founder_and_floor():
    assert [sp.list_usd(t) for t in sp.TIERS] == [250, 2500, 10000]
    assert [sp.founder_usd(t) for t in sp.TIERS] == [210, 2100, 8500]
    assert [sp.floor_usd(t) for t in sp.TIERS] == [175, 1750, 7000]


def test_tier_casing_is_normalised():
    assert sp.price_usd("Gold", 0) == 2100
    assert sp.price_usd(" PLATINUM ", 10) == 7500


@pytest.mark.parametrize("pts", [-1, 16, 100])
def test_points_out_of_range_rejected(pts):
    with pytest.raises(ValueError):
        sp.price_usd("gold", pts)


@pytest.mark.parametrize("pts", [True, 1.0, "5", None])
def test_points_must_be_a_plain_int(pts):
    with pytest.raises(ValueError):
        sp.price_usd("gold", pts)


def test_unknown_tier_rejected():
    with pytest.raises(ValueError):
        sp.price_usd("diamond", 0)
    with pytest.raises(ValueError):
        sp.list_usd(None)


def test_coupon_naming():
    assert sp.coupon_id("gold", 1850) == "GOLD-AT-1850"
    assert sp.coupon_name("platinum", 8500) == "Platinum Founder's Deal — $8,500/mo"


def test_founder_literals_match_the_join_page():
    """Cross-language guard: the site advertises the Founder's Deal from ONE home,
    frontend founderDeal.ts (the Join cards and the About page both read it); every
    tier it names must equal what we charge."""
    src = (
        pathlib.Path(__file__).parents[2] / "frontend/src/public/pages/join/founderDeal.ts"
    ).read_text()
    for tier in ("silver", "gold", "platinum"):
        m = re.search(rf"{tier}:\s*'\$([\d,]+)'", src)
        assert m, f"founderDeal.ts has no {tier} price"
        assert int(m.group(1).replace(",", "")) == sp.FOUNDER_USD[tier], tier
