"""F11 — the reseed census: how many sponsorships a ``--reseed`` would orphan.

``python -m app.jobs.billing_census`` prints ``<db> <stripe>``. The DB side
counts non-Expired sponsors naming a subscription on EITHER the sponsor row or
its billing row; the Stripe side counts non-canceled ``managed_by``
subscriptions through the Search API — which is what catches a rep-quoted
subscription whose sponsor never got a billing row. ``deploy.sh`` refuses the
reseed unless both are 0 or the operator types the larger number back.
"""

import re
from decimal import Decimal

import httpx
import pytest

from app.config import settings
from app.jobs import billing_census
from app.models import Sponsor
from app.models.sales import SponsorBilling
from app.services import stripe_quotes
from tests.fake_stripe import FakeStripe


class CensusStripe(FakeStripe):
    """The shared fake plus a ``metadata['managed_by']`` search that pages
    like Stripe's (``has_more`` + an opaque ``next_page`` token)."""

    search_fails = False

    def _route(self, method, path, form, params, expand):
        query = params.get("query", "") if isinstance(params, dict) else ""
        if path == "/v1/subscriptions/search" and "managed_by" in query:
            if self.search_fails:
                return httpx.Response(500, json={"error": {"message": "search is down"}})
            wanted = re.search(r"metadata\['managed_by'\]:'([^']*)'", query).group(1)
            rows = [
                s
                for s in self.subscriptions.values()
                if s["metadata"].get("managed_by") == wanted
                and not ("-status:'canceled'" in query and s["status"] == "canceled")
            ]
            start = int(params.get("page") or 0)
            limit = int(params.get("limit") or 10)
            chunk = rows[start : start + limit]
            more = start + limit < len(rows)
            return httpx.Response(
                200,
                json={
                    "object": "search_result",
                    "data": [self._sub_view(s, []) for s in chunk],
                    "has_more": more,
                    "next_page": str(start + limit) if more else None,
                },
            )
        return super()._route(method, path, form, params, expand)


@pytest.fixture
def stripe(monkeypatch):
    fake = CensusStripe()
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_census")
    monkeypatch.setattr(stripe_quotes, "make_client", fake.make_client)
    return fake


def _sponsor(db, supplier, keyword, *, status="Active", own_sub=None, billing_sub=False):
    row = Sponsor(
        supplier_id=supplier.id,
        keyword=keyword,
        tier="Gold",
        status=status,
        amount=Decimal("2100"),
        stripe_subscription_id=own_sub,
    )
    db.add(row)
    db.flush()
    if billing_sub is not False:
        db.add(
            SponsorBilling(
                sponsor_id=row.id,
                stripe_subscription_id=billing_sub,
                channel="rep_code",
                list_usd=2500,
                price_usd=2100,
            )
        )
    db.commit()
    return row


def test_the_db_side_counts_every_live_stored_subscription_once(db, seeded_db):
    supplier = seeded_db["supplier1"]
    _sponsor(db, supplier, "c-billing", billing_sub="sub_census000001")
    _sponsor(db, supplier, "c-legacy", status=None, own_sub="sub_census000002")
    _sponsor(db, supplier, "c-paused", status="Paused", billing_sub="sub_census000003")
    # Both keys on one sponsor: still ONE sponsorship.
    _sponsor(db, supplier, "c-both", own_sub="sub_census000004", billing_sub="sub_census000004")
    # Not counted: expired (any stored casing), a billing row with no id, no billing.
    _sponsor(db, supplier, "c-expired", status="Expired", billing_sub="sub_census000005")
    _sponsor(db, supplier, "c-expired-lc", status="expired", own_sub="sub_census000006")
    _sponsor(db, supplier, "c-no-id", billing_sub=None)
    _sponsor(db, supplier, "c-unbilled")

    assert billing_census.db_count(db) == 4


def test_the_stripe_side_counts_live_managed_subscriptions_across_pages(
    db, seeded_db, stripe, monkeypatch
):
    monkeypatch.setattr(billing_census, "_PAGE", 2)
    managed = {"managed_by": "circuits-com"}
    stripe.add_subscription("sub_census000011", metadata=managed)
    stripe.add_subscription("sub_census000012", metadata=managed, status="past_due")
    stripe.add_subscription("sub_census000013", metadata=managed, status="unpaid")
    stripe.add_subscription("sub_census000014", metadata=managed, status="canceled")
    stripe.add_subscription("sub_census000015", metadata={"managed_by": "someone-else"})
    stripe.add_subscription("sub_census000016")  # no metadata at all

    assert billing_census.census(db) == (0, 3)

    searches = stripe.calls("GET", "/v1/subscriptions/search")
    assert len(searches) == 2, "3 rows at 2 per page is two pages"
    assert searches[0].params["query"] == (
        "metadata['managed_by']:'circuits-com' AND -status:'canceled'"
    )
    assert "page" not in searches[0].params
    assert searches[1].params["page"] == "2"


def test_a_rep_quoted_subscription_with_no_billing_row_is_seen_by_stripe(db, seeded_db, stripe):
    """The case the DB side cannot see — the reason this job exists."""
    _sponsor(db, seeded_db["supplier1"], "c-quoted")  # no subscription stored
    stripe.add_subscription(
        "sub_census000021", metadata={"managed_by": "circuits-com", "sponsor_id": "x"}
    )
    assert billing_census.census(db) == (0, 1)


def test_no_key_is_unavailable_never_zero(db, seeded_db, monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", None)
    _sponsor(db, seeded_db["supplier1"], "c-billing", billing_sub="sub_census000031")
    assert billing_census.census(db) == (1, "unavailable")


def test_a_stripe_failure_is_unavailable_never_zero(db, seeded_db, stripe):
    stripe.search_fails = True
    assert billing_census.census(db) == (0, "unavailable")


def test_main_prints_the_two_fields_on_one_line(db, seeded_db, stripe, monkeypatch, capsys):
    _sponsor(db, seeded_db["supplier1"], "c-billing", billing_sub="sub_census000041")
    stripe.add_subscription("sub_census000041", metadata={"managed_by": "circuits-com"})
    stripe.add_subscription("sub_census000042", metadata={"managed_by": "circuits-com"})
    monkeypatch.setattr("app.db.session.SessionLocal", lambda: db)

    assert billing_census.main([]) == 0
    assert capsys.readouterr().out == "1 2\n"


def test_the_census_only_reads_stripe(db, seeded_db, stripe):
    stripe.add_subscription("sub_census000051", metadata={"managed_by": "circuits-com"})
    billing_census.census(db)
    assert stripe.tape and all(r.method == "GET" for r in stripe.tape)
