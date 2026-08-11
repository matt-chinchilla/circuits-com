"""Cost sources — providers that report what we actually spent.

Each module here answers one question ("what did AWS bill this month?") and
returns plain ``SyncedCost`` values; ``base.upsert_synced_costs`` is the only
thing that writes to `expenses`, and ``app/jobs/sync_costs.py`` is the only
thing that schedules any of it.

Nothing here is imported by the API process at request time. That is
deliberate: a Cost Explorer outage, a missing credential or a slow Stripe page
must not be able to affect a page load.
"""

from .anthropic import fetch_anthropic_cost_lines
from .aws import fetch_aws_cost_lines
from .base import (
    ANTHROPIC_SOURCE,
    AWS_SOURCE,
    RECURRING_SOURCE,
    STRIPE_SOURCE,
    CostSourceUnavailable,
    SyncedCost,
    upsert_synced_costs,
)
from .recurring import fetch_recurring_lines
from .stripe_fees import fetch_stripe_fee_lines

__all__ = [
    "ANTHROPIC_SOURCE",
    "AWS_SOURCE",
    "RECURRING_SOURCE",
    "STRIPE_SOURCE",
    "CostSourceUnavailable",
    "SyncedCost",
    "fetch_anthropic_cost_lines",
    "fetch_aws_cost_lines",
    "fetch_recurring_lines",
    "fetch_stripe_fee_lines",
    "upsert_synced_costs",
]
