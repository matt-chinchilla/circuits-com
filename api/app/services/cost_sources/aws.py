"""Real AWS spend, from Cost Explorer, split by the `Application` tag.

Replaces nothing — ``app/services/aws_cost.py`` still computes the list-price
estimate, and that estimate stays the fallback for any month this cannot
report. What lands here is the invoiced number.

Facts that shaped every line below:

- **Cost Explorer lives in us-east-1 and nowhere else.** The region is pinned
  rather than inherited from the environment; a container with
  AWS_DEFAULT_REGION set to anything else would get an endpoint that does not
  exist.
- **Each GetCostAndUsage request costs $0.01.** That is the entire reason this
  function makes ONE call for a whole multi-month window instead of looping a
  month at a time, and why the job gates it behind a 22-hour staleness check.
- **Cost allocation tags are NOT retroactive.** The `Application` tag was
  activated on 2026-08-11; every month before that reports its whole spend
  under the untagged key `Application$`. Those dollars are real and land as
  'AWS - Other'. Reporting them as zero for the two apps would be a prettier
  chart and a lie.
- **Credentials come from the default chain.** In prod that is the
  `circuits-cost-explorer-read` instance profile reached through IMDS (hop
  limit 2, so a container can read it); in dev it is the operator's
  ~/.aws mounted read-only. Nothing here handles keys.

boto3 is imported INSIDE ``_ce_client`` on purpose: that function is the seam
tests monkeypatch, so the suite exercises the mapping against a canned
response without boto3 installed at all, and an api container that never syncs
costs pays no import cost for it.
"""

from __future__ import annotations

import calendar
import logging
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from .base import (
    AWS_SOURCE,
    ESTIMATE_SOURCE,
    CostSourceUnavailable,
    SyncedCost,
    to_cents,
)

logger = logging.getLogger(__name__)

# Cost Explorer has ONE endpoint region for every account, regardless of where
# the resources being billed actually run.
CE_REGION = "us-east-1"

# The cost-allocation tag key activated on the account. GetCostAndUsage returns
# group keys as "<TagKey>$<value>", with an empty value for untagged spend.
TAG_KEY = "Application"

# Tag value → the vendor string that shows in the admin Cost Breakdown. These
# strings are the identity of the row: `upsert_synced_costs` matches on
# (source, vendor, period_start), so renaming one here orphans its history and
# starts a parallel row. Change them only with a data migration.
VENDOR_BY_TAG: dict[str, str] = {
    f"{TAG_KEY}$circuits-com": "AWS - Circuit Center",
    f"{TAG_KEY}$circuits-mail": "AWS - Mail Server",
}
OTHER_VENDOR = "AWS - Other"

# Per-application category (user decision 2026-08-11): the MAIL server's AWS
# spend files under 'email' — that category exists precisely so the per-server
# pricing difference shows at the category level — while the web stack and the
# untagged remainder (which includes all pre-activation history) stay
# 'infrastructure'. The vendor string remains the row's identity either way.
CATEGORY_BY_VENDOR: dict[str, str] = {
    "AWS - Circuit Center": "infrastructure",
    "AWS - Mail Server": "email",
}
DEFAULT_CATEGORY = "infrastructure"
MAIL_VENDOR = "AWS - Mail Server"

# ── The mail carve-out (pre-tagging months only) ────────────────────────────
# The Application cost-allocation tag went Active 2026-08-11; AWS attribution
# is forward-only, so the mail box's spend BEFORE then sits inside untagged
# 'AWS - Other' and no API can retro-split it. But the box's costs are
# deterministic list-price arithmetic, so for a month where the box existed
# and no tagged mail actual came back, its share is ALLOCATED out of the real
# 'Other' total: an estimate line (category email, wearing the estimated
# badge) carved from — never added on top of — the invoiced amount, so the
# month's total stays exactly what AWS billed. The moment a real tagged mail
# line exists for a month, no carve happens and supersede removes any earlier
# carve row for it.
#
# Born 2026-08-01T00:50Z (vol-093371de006fea8ed CreateTime): months before
# August 2026 get NO carve because there was nothing to allocate.
MAIL_SERVER_LAUNCHED = date(2026, 8, 1)
# t4g.micro $0.0084/hr·24 + 10 GB gp3 $0.80/30.4d + public IPv4 $0.005/hr·24,
# us-east-1 list prices (same sourcing convention as services/aws_cost.py).
MAIL_DAILY_USD = Decimal("0.35")


def _ce_client() -> Any:
    """The boto3 Cost Explorer client — and the ONLY seam tests replace.

    Imported lazily so `import app` does not pull boto3 in, and so the test
    suite can run on a machine that has never installed it.
    """
    import boto3  # noqa: PLC0415 — deliberate: see the module docstring

    return boto3.client("ce", region_name=CE_REGION)


def _month_start(anchor: date, months_back: int) -> date:
    """First day of the month `months_back` months before `anchor`'s month."""
    index = anchor.year * 12 + (anchor.month - 1) - months_back
    return date(index // 12, index % 12 + 1, 1)


def _month_end(first: date) -> date:
    """Last day of `first`'s calendar month.

    The row's period_end is the whole month even when the data is month-to-date
    — the seeded rows use calendar-month bounds and the dashboard buckets on
    period_start, so a half-month end date would make the current month sort
    and render differently from every other one.
    """
    return first.replace(day=calendar.monthrange(first.year, first.month)[1])


def _mail_carve_usd(
    period_start: date, anchor: date, totals: dict[str, float] | None
) -> Decimal:
    """The mail box's allocated share of this month's untagged spend, in USD.

    Zero — meaning "no carve line" — whenever: a tagged mail actual exists
    for the month (``totals is None`` by the caller's convention), the box
    did not exist yet, there is no 'Other' spend to allocate from, or the
    proration rounds below a cent. Days are prorated to the overlap of
    [month, box lifetime, elapsed time], so the current month allocates only
    the days that have actually happened.
    """
    if totals is None:
        return Decimal("0")
    other = totals.get(OTHER_VENDOR)
    if not other or other <= 0:
        return Decimal("0")
    month_last = _month_end(period_start)
    overlap_start = max(period_start, MAIL_SERVER_LAUNCHED)
    overlap_end = min(month_last, anchor)
    days = (overlap_end - overlap_start).days + 1
    if days <= 0:
        return Decimal("0")
    estimate = to_cents(float(MAIL_DAILY_USD * days))
    return min(estimate, to_cents(other))


def fetch_aws_cost_lines(months_back: int = 2, *, today: date | None = None) -> list[SyncedCost]:
    """Actual AWS spend per Application tag, one line per (month, tag).

    `months_back` COUNTS THE CURRENT MONTH: 2 is "this month and last", which
    is the routine case (last month can still move for a few days after it
    ends, as usage records settle). 13 is the first-ever backfill.

    Raises CostSourceUnavailable for anything that goes wrong reaching AWS —
    no credentials, an expired role, a throttle, a network partition. The
    caller decides what that means; here it just means "no numbers".
    """
    anchor = today or date.today()
    start = _month_start(anchor, max(1, months_back) - 1)
    # Cost Explorer's End is EXCLUSIVE, and asking for a period that ends today
    # returns nothing for today. Tomorrow gets the month-to-date figure.
    end = anchor + timedelta(days=1)

    try:
        client = _ce_client()
        response = client.get_cost_and_usage(
            TimePeriod={"Start": start.isoformat(), "End": end.isoformat()},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
            GroupBy=[{"Type": "TAG", "Key": TAG_KEY}],
        )
    except Exception as exc:  # noqa: BLE001 — botocore raises a wide family
        # Deliberately broad: botocore's errors are generated per service
        # (ClientError, NoCredentialsError, EndpointConnectionError, and the
        # ImportError if boto3 is missing entirely), and every one of them
        # means the same thing to the caller. The type name is kept so the log
        # line still identifies which.
        raise CostSourceUnavailable(
            f"AWS Cost Explorer unavailable ({type(exc).__name__}: {exc})"
        ) from exc

    return _lines_from_response(response, anchor)


def _lines_from_response(response: dict, anchor: date) -> list[SyncedCost]:
    """Map a GetCostAndUsage payload to SyncedCost values.

    Split out from the network call so the mapping — the part with the real
    edge cases — is testable against a canned response dict. ``anchor`` bounds
    the mail carve-out's proration for the in-progress month.
    """
    lines: list[SyncedCost] = []

    for result in response.get("ResultsByTime") or []:
        period = result.get("TimePeriod") or {}
        try:
            period_start = date.fromisoformat(period["Start"])
        except (KeyError, TypeError, ValueError):
            logger.warning("[cost-sync] AWS result with no usable TimePeriod — skipped")
            continue
        period_end = _month_end(period_start)

        # Untagged spend and any tag value we do not recognise are SUMMED into
        # one 'AWS - Other' line rather than dropped. Pre-activation months are
        # entirely untagged, so dropping it would report those months as $0.
        totals: dict[str, float] = {}
        for group in result.get("Groups") or []:
            keys = group.get("Keys") or []
            tag = keys[0] if keys else ""
            vendor = VENDOR_BY_TAG.get(tag, OTHER_VENDOR)
            raw = ((group.get("Metrics") or {}).get("UnblendedCost") or {}).get("Amount", "0")
            try:
                totals[vendor] = totals.get(vendor, 0.0) + float(raw)
            except (TypeError, ValueError):
                logger.warning("[cost-sync] AWS group %r had a non-numeric amount %r", tag, raw)

        # Carve the mail allocation out of 'Other' for months the box existed
        # but carried no tag. Capped at what 'Other' actually holds — an
        # allocation may split the bill, never grow it.
        carve_amount = _mail_carve_usd(
            period_start, anchor, totals if MAIL_VENDOR not in totals else None
        )
        if carve_amount > 0:
            totals[OTHER_VENDOR] -= float(carve_amount)
            lines.append(
                SyncedCost(
                    source=ESTIMATE_SOURCE,
                    category=CATEGORY_BY_VENDOR[MAIL_VENDOR],
                    vendor=MAIL_VENDOR,
                    amount=carve_amount,
                    period_start=period_start,
                    period_end=period_end,
                )
            )

        # Stable order: the two named applications first, then the catch-all.
        ordered = [*VENDOR_BY_TAG.values(), OTHER_VENDOR]
        for vendor in ordered:
            if vendor not in totals:
                continue
            amount = to_cents(totals[vendor])
            # A zero line is not information — it is what an application with
            # no spend, or a month before the tag existed, legitimately looks
            # like. Writing it would put "$0.00 AWS - Mail Server" rows in the
            # breakdown for every pre-activation month.
            if amount == 0:
                continue
            lines.append(
                SyncedCost(
                    source=AWS_SOURCE,
                    category=CATEGORY_BY_VENDOR.get(vendor, DEFAULT_CATEGORY),
                    vendor=vendor,
                    amount=amount,
                    period_start=period_start,
                    period_end=period_end,
                )
            )

    return lines
