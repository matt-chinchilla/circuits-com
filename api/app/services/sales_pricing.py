"""The ONE price rule (spec §4). Nothing else computes a sponsorship price.

    price(tier, code_pts) = max(FLOOR, FOUNDER - ceil(code_pts * LIST / 100))

LIST is the ladder's first entry (the list price's single home stays
``stripe_quotes.QUOTE_LADDER``); FOUNDER is the Founder's Deal, charged forever
(owner D5/D8); FLOOR is 70% of list — no path discounts more than 30% off list
in total (D2/D9). Whole dollars. The browser only renders numbers this returns.
"""

import math

from app.services.stripe_quotes import QUOTE_LADDER

TIERS: tuple[str, ...] = ("silver", "gold", "platinum")
EXCLUSIVE_TIERS: tuple[str, ...] = ("gold", "platinum")
# The Founder's Deal (owner, 2026-09-21 / D8): charged, forever. The Join
# page's JOIN_TIERS.fd literals are pinned to these by test_sales_pricing.py.
FOUNDER_USD: dict[str, int] = {"silver": 210, "gold": 2100, "platinum": 8500}
MAX_CODE_POINTS: int = 15


def _tier(tier: str) -> str:
    t = tier.strip().lower() if isinstance(tier, str) else None
    if t not in TIERS:
        raise ValueError(f"unknown tier {tier!r}")
    return t


def list_usd(tier: str) -> int:
    return QUOTE_LADDER[_tier(tier)][0]


def founder_usd(tier: str) -> int:
    return FOUNDER_USD[_tier(tier)]


def floor_usd(tier: str) -> int:
    return list_usd(tier) * 70 // 100


def price_usd(tier: str, code_points: int = 0) -> int:
    # bool is an int subclass; a JSON `true` must never read as one point.
    if (
        isinstance(code_points, bool)
        or not isinstance(code_points, int)
        or not 0 <= code_points <= MAX_CODE_POINTS
    ):
        raise ValueError(f"code_points must be an int 0..{MAX_CODE_POINTS}")
    base = list_usd(tier)
    discount = math.ceil(code_points * base / 100)
    return max(floor_usd(tier), founder_usd(tier) - discount)


def coupon_id(tier: str, price: int) -> str:
    return f"{_tier(tier).upper()}-AT-{price}"


def coupon_name(tier: str, price: int) -> str:
    return f"{_tier(tier).capitalize()} Founder's Deal — ${price:,}/mo"
