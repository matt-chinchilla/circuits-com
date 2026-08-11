"""What Stripe actually kept, from settlement data — not 2.9% + $0.30 by hand.

Balance transactions are the authoritative record: every charge, refund and
payout carries the `fee` Stripe deducted, in cents, already net of whatever
pricing the account is on. Summing those per calendar month is the real
processing cost for that month.

Free to call, unlike Cost Explorer, so the job runs this every pass.

The one rule this file exists to obey, learned the expensive way in
`services/stripe_quotes.py`: **a query string is built with httpx `params=`
and never with an f-string.** An f-string ships `+` verbatim, which Stripe
decodes as a space, and lets `&` or `#` in any interpolated value inject or
truncate the query. `created[gte]` and `starting_after` both go through
`params` here for that reason.
"""

from __future__ import annotations

import calendar
import logging
from datetime import UTC, date, datetime
from decimal import Decimal

import httpx

from .base import STRIPE_SOURCE, CostSourceUnavailable, SyncedCost, to_cents

logger = logging.getLogger(__name__)

STRIPE_API = "https://api.stripe.com"
CATEGORY = "payment"
VENDOR = "Stripe fees"

# Stripe's maximum page size. Fewer round trips per pass, and this list is
# short for a business of this size.
PAGE_LIMIT = 100

# A hard stop on pagination. A bug in the cursor handling (or a Stripe change)
# that stopped advancing `starting_after` would otherwise loop forever inside
# an hourly job; 100 pages is 10,000 transactions, far past anything two
# months of sponsorship billing can produce.
MAX_PAGES = 100


def _month_start(anchor: date, months_back: int) -> date:
    index = anchor.year * 12 + (anchor.month - 1) - months_back
    return date(index // 12, index % 12 + 1, 1)


def _month_end(first: date) -> date:
    return first.replace(day=calendar.monthrange(first.year, first.month)[1])


def fetch_stripe_fee_lines(
    secret_key: str,
    *,
    now: datetime | None = None,
    transport: httpx.BaseTransport | None = None,
) -> list[SyncedCost]:
    """Processing fees per calendar month, from the previous month onward.

    The window starts at the first day of the PREVIOUS month so a month that
    is still settling keeps getting corrected — a charge that lands on the 1st
    can still produce fee adjustments days later, and re-summing the whole
    month is both simpler and more correct than trying to patch deltas.

    `transport` is the test seam (httpx.MockTransport plays Stripe with no
    network). Raises CostSourceUnavailable on any non-200 or transport error.
    """
    moment = now or datetime.now(UTC)
    window_start = _month_start(moment.date(), 1)
    created_gte = int(datetime(window_start.year, window_start.month, 1, tzinfo=UTC).timestamp())

    fees_by_month: dict[date, int] = {}

    with httpx.Client(
        base_url=STRIPE_API,
        headers={"Authorization": f"Bearer {secret_key}"},
        timeout=20.0,
        transport=transport,
    ) as client:
        # `params` — never an f-string. See the module docstring.
        params: dict[str, str | int] = {"created[gte]": created_gte, "limit": PAGE_LIMIT}
        for _ in range(MAX_PAGES):
            body = _get(client, "/v1/balance_transactions", params)
            rows = body.get("data") or []
            for row in rows:
                # Two shapes of Stripe cost. Charges carry their processing
                # cut in `fee`. But Stripe ALSO bills some products (Billing,
                # Tax — both live on this account) as standalone transactions
                # of type 'stripe_fee', whose cost is a NEGATIVE `amount` with
                # `fee` = 0 — counting only `fee` misses every one of those.
                fee = int(row.get("fee") or 0)
                if row.get("type") == "stripe_fee":
                    fee += -int(row.get("amount") or 0)
                created = row.get("created")
                if not fee or created is None:
                    continue
                try:
                    stamp = datetime.fromtimestamp(int(created), tz=UTC)
                except (TypeError, ValueError, OSError):
                    logger.warning("[cost-sync] Stripe transaction with bad `created` %r", created)
                    continue
                bucket = stamp.date().replace(day=1)
                fees_by_month[bucket] = fees_by_month.get(bucket, 0) + int(fee)

            if not body.get("has_more") or not rows:
                break
            last_id = rows[-1].get("id")
            if not last_id:
                # No cursor to advance on: stopping is right. Continuing would
                # re-request page one until MAX_PAGES and double-count it.
                logger.warning("[cost-sync] Stripe page had has_more but no id to page on")
                break
            params = {
                "created[gte]": created_gte,
                "limit": PAGE_LIMIT,
                "starting_after": last_id,
            }
        else:
            logger.warning(
                "[cost-sync] Stripe pagination hit the %d-page ceiling — totals may be partial",
                MAX_PAGES,
            )

    return [
        SyncedCost(
            source=STRIPE_SOURCE,
            category=CATEGORY,
            vendor=VENDOR,
            # Fees are integer CENTS in the API. Dividing by 100 as Decimal
            # keeps it exact; float would round $1,234.35 to something else.
            amount=to_cents(Decimal(cents) / Decimal(100)),
            period_start=month,
            period_end=_month_end(month),
        )
        for month, cents in sorted(fees_by_month.items())
        # A month with no fees is not a $0.00 cost line; it is a month with no
        # transactions.
        if cents > 0
    ]


def _get(client: httpx.Client, path: str, params: dict) -> dict:
    try:
        response = client.get(path, params=params)
    except httpx.HTTPError as exc:
        raise CostSourceUnavailable(f"could not reach Stripe ({type(exc).__name__})") from exc
    if response.status_code != 200:
        # The body may carry a Stripe error message, but it may also carry the
        # request that produced it — so only the status is surfaced.
        raise CostSourceUnavailable(f"Stripe returned {response.status_code} for {path}")
    try:
        body = response.json()
    except ValueError as exc:
        raise CostSourceUnavailable("Stripe returned a non-JSON body") from exc
    if not isinstance(body, dict):
        raise CostSourceUnavailable("Stripe returned an unexpected payload shape")
    return body
