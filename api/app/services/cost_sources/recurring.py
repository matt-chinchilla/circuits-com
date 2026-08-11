"""Recurring known costs — flat bills that no API anywhere can report.

The canonical case is the Claude Max subscription: Anthropic's Admin cost
API covers metered API usage for a developer organization, and a claude.ai
subscription appears in NO programmatic surface at all. But a flat bill does
not need an API — it needs to be declared once and planted every month, which
is exactly what a sync source is for.

Spec format (``settings.RECURRING_MONTHLY_EXPENSES``), semicolon-separated
triples of ``category:vendor:amount``:

    ai:Claude Max subscription:200.00;domain:Name.com:1.50

Vendors may contain spaces but not colons. A malformed entry is one warning
line and a skipped entry — a typo in one bill must not silence the others.

Lines are written for the CURRENT month only: history is not fabricated for
months before the spec existed (type those by hand if they matter). Being a
REAL source, a recurring line supersedes the seeded estimate in its
category+month — the $120 "Anthropic" placeholder retires the first pass
after this ships. The ownership rules apply unchanged: editing the planted
row promotes it to manual, deleting it is refused while the spec still
names it.
"""

from __future__ import annotations

import calendar
import logging
from datetime import date
from decimal import Decimal, InvalidOperation

from app.models.expense import EXPENSE_CATEGORIES

from .base import RECURRING_SOURCE, SyncedCost

logger = logging.getLogger(__name__)


def fetch_recurring_lines(spec: str | None, *, today: date | None = None) -> list[SyncedCost]:
    """The configured flat bills, as this month's cost lines."""
    if not spec or not spec.strip():
        return []
    anchor = today or date.today()
    month_start = anchor.replace(day=1)
    month_end = anchor.replace(day=calendar.monthrange(anchor.year, anchor.month)[1])

    lines: list[SyncedCost] = []
    for raw in spec.split(";"):
        entry = raw.strip()
        if not entry:
            continue
        parts = entry.split(":")
        if len(parts) != 3:
            logger.warning(
                "[cost-sync] recurring entry %r is not category:vendor:amount — skipped", entry
            )
            continue
        category, vendor, amount_text = (part.strip() for part in parts)
        if category not in EXPENSE_CATEGORIES:
            logger.warning(
                "[cost-sync] recurring entry %r names unknown category %r — skipped",
                entry,
                category,
            )
            continue
        try:
            amount = Decimal(amount_text).quantize(Decimal("0.01"))
        except InvalidOperation:
            logger.warning(
                "[cost-sync] recurring entry %r has a non-numeric amount — skipped", entry
            )
            continue
        if amount <= 0 or not vendor:
            logger.warning("[cost-sync] recurring entry %r is empty or non-positive — skipped", entry)
            continue
        lines.append(
            SyncedCost(
                source=RECURRING_SOURCE,
                category=category,
                vendor=vendor,
                amount=amount,
                period_start=month_start,
                period_end=month_end,
            )
        )
    return lines
