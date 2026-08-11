"""Anthropic API spend — the seam, not the implementation.

Deliberately a stub. The Admin API cost report is a real endpoint:

    GET https://api.anthropic.com/v1/organizations/cost_report
    headers: x-api-key: sk-ant-admin…          (an ADMIN key, not an API key)
             anthropic-version: 2023-06-01
    params:  starting_at / ending_at (RFC 3339), bucket_width=1d, group_by

Wiring it needs an organization admin key, which the account does not have
provisioned yet, and an admin key is a far larger credential than anything
else this job holds — it can read and manage the whole organization. Shipping
an untested network call against a key nobody has would be code that has never
run once, guarding a credential nobody has reviewed.

Until then the Anthropic line in the Cost Breakdown stays a MANUAL row typed
from the invoice (see db/seed.py), which is honest: a hand-entered number that
says it is hand-entered beats an automated one that silently returns nothing.
"""

from __future__ import annotations

import logging

from .base import SyncedCost

logger = logging.getLogger(__name__)

COST_REPORT_URL = "https://api.anthropic.com/v1/organizations/cost_report"
API_VERSION = "2023-06-01"


def fetch_anthropic_cost_lines(admin_key: str | None) -> list[SyncedCost]:
    """Always returns [] today — see the module docstring.

    Warns when a key IS configured, because that is someone expecting numbers
    to appear. Returning silently there would be exactly the "documented
    setting that does nothing" failure the compose allowlist tests exist for.
    """
    if not admin_key:
        return []
    logger.warning(
        "[cost-sync] ANTHROPIC_ADMIN_KEY is set but the cost report call is not "
        "implemented yet (%s) — the Anthropic line stays a manual entry",
        COST_REPORT_URL,
    )
    return []
