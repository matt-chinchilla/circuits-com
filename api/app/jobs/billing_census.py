"""How many sponsorships a ``--reseed`` would orphan in Stripe (F11).

    python -m app.jobs.billing_census

Prints ONE line of two fields, ``<db> <stripe>``:

* ``db`` — sponsors that are not Expired (NULL counts as Active) and name a
  Stripe subscription, on the ``sponsors`` row itself (the self-serve owner
  key) OR on its ``sponsor_billing`` row (rep-sold and 057-era sales).
* ``stripe`` — Stripe's own count of non-canceled subscriptions stamped
  ``metadata.managed_by = circuits-com`` (every quote and every Checkout this
  site mints stamps it), via the Search API. It catches the case the database
  cannot: a rep-quoted subscription whose sponsor row never got a billing row
  (R13's "needs resolution"). ``unavailable`` when there is no
  ``STRIPE_SECRET_KEY`` or Stripe could not be asked — never a guessed 0.

``deploy.sh``'s ``confirm_reseed`` runs this inside the api container on the
box and refuses unless BOTH fields are 0, or the operator types the larger
number back. The TRUNCATE cascades through ``sponsors`` into
``sponsor_billing`` but never cancels anything in Stripe, so every counted
subscription would keep charging a customer whose board is gone.

Read-only: one SELECT, and GETs against Stripe. Exit 0 whenever it printed a
line; the parsing side decides what an ``unavailable`` means.
"""

from __future__ import annotations

import asyncio
import logging
import sys

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Sponsor
from app.models.sales import SponsorBilling
from app.services import stripe_quotes
from app.services.stripe_billing import MANAGED_BY
from app.services.stripe_quotes import StripeApiError

logger = logging.getLogger(__name__)

UNAVAILABLE = "unavailable"

# Search pages cap at 100; a runaway guard, not a budget (a thousand pages is
# 100k subscriptions — far past anything this site sells).
_PAGE = 100
_MAX_PAGES = 1000


def db_count(db: Session) -> int:
    """Distinct non-Expired sponsors with a stored subscription id."""
    return (
        db.query(func.count(func.distinct(Sponsor.id)))
        .outerjoin(SponsorBilling, SponsorBilling.sponsor_id == Sponsor.id)
        .filter(
            or_(Sponsor.status.is_(None), func.lower(func.trim(Sponsor.status)) != "expired"),
            or_(
                Sponsor.stripe_subscription_id.isnot(None),
                SponsorBilling.stripe_subscription_id.isnot(None),
            ),
        )
        .scalar()
        or 0
    )


async def stripe_count(secret_key: str) -> int:
    """Non-canceled subscriptions this site manages, across every search page.

    Search is eventually consistent (a subscription minted in the last minute
    may be missing) — acceptable for a guard an operator runs by hand."""
    query = f"metadata['managed_by']:'{MANAGED_BY}' AND -status:'canceled'"
    params: dict[str, object] = {"query": query, "limit": _PAGE}
    seen: set[str] = set()
    async with stripe_quotes.make_client(secret_key) as client:
        for _ in range(_MAX_PAGES):
            page = await stripe_quotes._call(
                client, "GET", "/v1/subscriptions/search", params=params
            )
            for sub in page.get("data") or []:
                if sub.get("status") != "canceled" and sub.get("id"):
                    seen.add(sub["id"])
            next_page = page.get("next_page")
            if not page.get("has_more") or not next_page:
                return len(seen)
            params = {**params, "page": next_page}
    raise StripeApiError("subscription search did not finish paging", status=502)


def census(db: Session) -> tuple[int, int | str]:
    """``(db count, stripe count | "unavailable")``."""
    in_db = db_count(db)
    key = (settings.STRIPE_SECRET_KEY or "").strip()
    if not key:
        return in_db, UNAVAILABLE
    try:
        return in_db, asyncio.run(stripe_count(key))
    except StripeApiError as exc:
        logger.warning("billing census: Stripe could not be counted: %s", exc.message)
        return in_db, UNAVAILABLE


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        in_db, in_stripe = census(db)
    finally:
        db.close()
    print(f"{in_db} {in_stripe}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
