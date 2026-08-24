"""What the BOM tool is allowed to claim about how current a price is.

THE BUG THIS REPLACES. `_offers_for_part` used to publish
`price_stale = last_updated < now() - 30 days`. `part_listings.last_updated`
has a `default=` and NO `onupdate=`, so it is stamped once at INSERT and
nothing has ever bumped it: it means "created", not "confirmed". The flag was
therefore an age-of-row reading dressed up as a freshness reading, and it was
about to fail loudly rather than quietly. Measured on the local catalog
(2026-08-24, `count(*) FILTER (WHERE last_updated < <date> - interval
'30 days')` over 167,823 rows):

    stale today          38,442
    stale on 2026-09-20  97,580
    stale on 2026-09-24  167,823   <- every listing in the catalog

`availabilityRail` in BomTable.tsx tested `price_stale` ABOVE both stock
branches, so on that last date every row in every BOM would have printed
"price not refreshed in 30 days" and no row would have printed a stock figure.

WHAT REPLACES IT, AND WHAT IT DELIBERATELY DOES NOT SAY. `price_source` is
`live` when a distributor API sits behind that supplier AND we hold a key for
it today, `static` otherwise. It is a claim about the SOURCE, not about the
row: it does not distinguish "confirmed an hour ago" from "confirmed in June",
because nothing in the schema can support that claim. `last_updated` has one
reader and zero writers, `updated_at` moves only when a value actually changed
(5.0% of Mouser rows: 6,477 of 130,728 have `updated_at > last_updated +
interval '1 second'`), `supplier_feeds.last_synced_at` is stamped by a job that
by construction refreshes nothing, and `lifecycle_verified_at` covers 1.8% of
parts. Abandoning the recency claim outright is the point; faking it with a
proxy is what we are removing.

The split is real and it is large: of 167,823 listings, 130,728 sit behind the
2 provider-backed suppliers and 37,095 behind the other 57.
"""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.models import Part, PartListing, PriceBreak, ProviderCredential, Supplier
from app.services.bom_match import build_row
from app.services.part_feed import registry
from app.services.part_feed.registry import _PROVIDERS, live_feed_slugs

from .feed_helpers import StatementCounter

# A key-shaped string that is not a key. The suite must never depend on the
# ambient environment for this: measured 2026-08-24, `'MOUSER_API_KEY' in
# os.environ` is False under pytest and `provider_credentials` is empty, so
# `live_feed_slugs` returns the EMPTY set by default and every offer would read
# `static` whatever the rule said. A test that only passes because the box has
# no key is not testing the rule. Every `live` case below seeds the row.
STORED_KEY = "stored-key-not-real-7c31"


def _mouser(db) -> Supplier:
    """The one seeded supplier whose website matches the `mouser` fragment.

    Named exactly as `seed.py` names it — see test_provider_supplier_identity:
    a provider whose `supplier_name` is not a name the seed creates mints a
    duplicate row on the next feed run.
    """
    s = Supplier(id=uuid.uuid4(), name="Mouser Electronics", website="https://www.mouser.com/")
    db.add(s)
    db.flush()
    return s


def _sourceless(db, name="Distrelec", website="distrelec.com") -> Supplier:
    s = Supplier(id=uuid.uuid4(), name=name, website=website)
    db.add(s)
    db.flush()
    return s


def _listing(db, part, supplier, *, age_days: float = 0.0, price="1.00", stock=25):
    when = datetime.now(UTC) - timedelta(days=age_days)
    li = PartListing(
        id=uuid.uuid4(),
        part_id=part.id,
        supplier_id=supplier.id,
        unit_price=Decimal(price),
        stock_quantity=stock,
        last_updated=when,
    )
    db.add(li)
    db.flush()
    db.add(PriceBreak(id=uuid.uuid4(), listing_id=li.id, min_quantity=1, unit_price=Decimal(price)))
    db.commit()
    return li


def _part(db, sku="FRESH-1") -> Part:
    p = Part(id=uuid.uuid4(), sku=sku, manufacturer_name="Texas Instruments")
    db.add(p)
    db.flush()
    return p


def _offer(db, part, live_slugs) -> dict:
    row = build_row(db, 0, "exact", part, None, None, None, live_slugs)
    assert row["offers"], "the fixture must produce at least one offer to inspect"
    return row["offers"][0]


class TestLiveFeedSlugs:
    """`live_feed_slugs` answers ONE question: which provider slugs can we
    actually call right now. It is the credential half only — the supplier half
    stays with `match_provider`, so there is no second definition of which
    distributor a row belongs to."""

    def test_a_provider_with_a_stored_credential_is_live(self, db):
        db.add(ProviderCredential(provider="mouser", api_key=STORED_KEY))
        db.commit()
        assert live_feed_slugs(db) == frozenset({"mouser"})

    def test_with_no_credentials_at_all_nothing_is_live(self, db):
        assert live_feed_slugs(db) == frozenset()

    def test_matching_a_domain_is_not_enough_a_keyless_provider_stays_dormant(self, db):
        # DigiKey is in _PROVIDERS and matches `digikey.com` on the domain
        # fragment, but production has never had DIGIKEY_CLIENT_ID installed.
        # If a domain match alone counted as live we would be telling buyers a
        # feed is refreshing prices that has never run there once.
        db.add(ProviderCredential(provider="mouser", api_key=STORED_KEY))
        db.commit()
        assert "digikey" in {slug for slug, _ in _PROVIDERS}
        assert "digikey" not in live_feed_slugs(db)

    def test_a_blanked_out_credential_row_is_not_a_key(self, db):
        # get_feed_key already treats whitespace as absent and falls back to the
        # environment; live_feed_slugs must inherit that rather than restate it.
        db.add(ProviderCredential(provider="mouser", api_key="   "))
        db.commit()
        assert live_feed_slugs(db) == frozenset()


class TestPriceSource:
    def test_a_four_hundred_day_old_mouser_listing_still_reads_live(self, db):
        # THE headline case. Under the old rule this row was "stale". It is a
        # row a live feed sweeps nightly; the row's own age says nothing about
        # that, and reintroducing any date arithmetic here brings the bug back.
        db.add(ProviderCredential(provider="mouser", api_key=STORED_KEY))
        part = _part(db)
        _listing(db, part, _mouser(db), age_days=400)
        assert _offer(db, part, live_feed_slugs(db))["price_source"] == "live"

    def test_a_five_second_old_listing_from_a_sourceless_distributor_reads_static(self, db):
        # The mirror image: recency is not the signal in EITHER direction. 57 of
        # the 59 suppliers have no API behind them, and a row we inserted
        # seconds ago is no more refreshable than one from June.
        db.add(ProviderCredential(provider="mouser", api_key=STORED_KEY))
        part = _part(db)
        _listing(db, part, _sourceless(db), age_days=5.0 / 86400)
        assert _offer(db, part, live_feed_slugs(db))["price_source"] == "static"

    def test_a_provider_backed_supplier_with_no_key_reads_static(self, monkeypatch, db):
        # Matching the registry table is not the claim — HOLDING A KEY is. The
        # patch lands because feed_configured resolves get_feed_key as a module
        # global (the same reason pick_feed_source reaches through the module).
        monkeypatch.setattr(registry, "get_feed_key", lambda _db, _slug="mouser": None)
        part = _part(db)
        _listing(db, part, _mouser(db))
        assert _offer(db, part, live_feed_slugs(db))["price_source"] == "static"

    def test_a_supplier_with_no_website_reads_static_and_does_not_crash(self, db):
        # `Thunder Electronics` is a real row on the local catalog with a NULL
        # website and 3 listings. An unguarded .lower() on it is a 500 on a
        # public endpoint, which is the whole BOM tool down for one bad row.
        db.add(ProviderCredential(provider="mouser", api_key=STORED_KEY))
        part = _part(db)
        _listing(db, part, _sourceless(db, name="Thunder Electronics", website=None))
        assert _offer(db, part, live_feed_slugs(db))["price_source"] == "static"

    def test_price_as_of_is_the_listings_own_date(self, db):
        db.add(ProviderCredential(provider="mouser", api_key=STORED_KEY))
        part = _part(db)
        li = _listing(db, part, _mouser(db), age_days=12)
        offer = _offer(db, part, live_feed_slugs(db))
        assert offer["price_as_of"] is not None
        assert offer["price_as_of"].startswith(li.last_updated.date().isoformat())

    def test_price_stale_is_gone_from_the_wire(self, db):
        # Cheap, and it catches a half-finished refactor: a row still shipping
        # both keys would keep the old client branch alive against a new server.
        part = _part(db)
        _listing(db, part, _sourceless(db))
        offer = _offer(db, part, live_feed_slugs(db))
        assert "price_stale" not in offer
        assert {"price_source", "price_as_of"} <= set(offer)


class TestPriceSourceOverTheWire:
    """The same rule as the route serves it — build_row is only half the
    contract if /api/bom/match never passes it the right argument."""

    def _post(self, client, lines, ip):
        return client.post("/api/bom/match", json={"lines": lines}, headers={"X-Real-IP": ip})

    def test_the_match_route_labels_each_supplier(self, client, db):
        db.add(ProviderCredential(provider="mouser", api_key=STORED_KEY))
        part = _part(db, "ROUTE-1")
        _listing(db, part, _mouser(db), price="2.00")
        _listing(db, part, _sourceless(db), price="1.00")
        row = self._post(client, [{"index": 0, "mpn": "ROUTE-1"}], "203.0.113.11").json()["rows"][0]
        by_name = {o["supplier_name"]: o["price_source"] for o in row["offers"]}
        assert by_name == {"Mouser Electronics": "live", "Distrelec": "static"}

    def test_price_as_of_is_per_listing_not_per_supplier(self, client, db):
        # Catches hoisting the DATE onto the supplier map alongside the slug —
        # the over-claim this whole design refuses. One supplier, two parts,
        # two different insert dates: the two rows must disagree.
        db.add(ProviderCredential(provider="mouser", api_key=STORED_KEY))
        mouser = _mouser(db)
        old, new = _part(db, "AGE-OLD"), _part(db, "AGE-NEW")
        _listing(db, old, mouser, age_days=300)
        _listing(db, new, mouser, age_days=1)
        rows = self._post(
            client,
            [{"index": 0, "mpn": "AGE-OLD"}, {"index": 1, "mpn": "AGE-NEW"}],
            "203.0.113.12",
        ).json()["rows"]
        seen = [r["offers"][0]["price_as_of"][:10] for r in rows]
        assert seen[0] != seen[1], (
            "both rows carry the same date — the listing's own last_updated is "
            f"no longer reaching the wire (got {seen})"
        )

    def test_two_offers_on_ONE_part_report_their_own_dates(self, client, db):
        # The other half of the same rule, and the half a mutation check caught
        # missing: the test above uses two PARTS, so every part there holds a
        # single listing and `part.listings[0].last_updated` is trivially the
        # right answer. A hoist off the first listing of the row survived it
        # untouched. Two listings on ONE part, added months apart, is the case
        # that kills it — and it is also the realistic one, because a part with
        # offers from several distributors is the entire premise of the
        # comparison table.
        db.add(ProviderCredential(provider="mouser", api_key=STORED_KEY))
        part = _part(db, "TWOOFFERS-1")
        _listing(db, part, _mouser(db), age_days=300, price="2.00")
        _listing(db, part, _sourceless(db), age_days=1, price="1.00")
        row = self._post(client, [{"index": 0, "mpn": "TWOOFFERS-1"}], "203.0.113.14").json()[
            "rows"
        ][0]
        dated = {o["supplier_name"]: o["price_as_of"][:10] for o in row["offers"]}
        assert len(row["offers"]) == 2
        assert dated["Mouser Electronics"] != dated["Distrelec"], (
            "both offers on this part carry the same date — one listing's age is "
            f"being printed against the other's price (got {dated})"
        )

    def test_the_live_slugs_lookup_is_hoisted_out_of_the_per_line_loop(self, client, db):
        # A 500-line BOM is a normal upload. Per-line this was 2 SELECTs a line.
        # The parameter is REQUIRED precisely so this test is a backstop and not
        # the only thing holding the hoist in place — a default would let the
        # loop silently pay for it again.
        #
        # This asserted `== len(_PROVIDERS)`, which was true when live_feed_slugs
        # read one credential row per registered distributor. It now resolves
        # them in a single `WHERE provider IN (...)`, so the honest expectation
        # is ONE — a count that grows with providers is the cost that change
        # removed, and pinning it to len(_PROVIDERS) would quietly re-license it.
        db.add(ProviderCredential(provider="mouser", api_key=STORED_KEY))
        part = _part(db, "HOIST-1")
        _listing(db, part, _mouser(db))
        lines = [{"index": i, "mpn": "HOIST-1"} for i in range(5)]
        with StatementCounter(db) as counter:
            assert self._post(client, lines, "203.0.113.13").status_code == 200
        credential_reads = counter.matching("from provider_credentials")
        assert len(credential_reads) == 1, (
            f"{len(credential_reads)} credential SELECTs for {len(lines)} lines — "
            "expected exactly one for the whole request, independent of both the "
            f"line count and the {len(_PROVIDERS)} registered providers"
        )


class TestTheParameterIsRequired:
    def test_build_row_has_no_live_slugs_default(self):
        """Correction 7, made structural. A defaulted `live_slugs` is a foot-gun
        that reads as working: the row still renders, every offer just quietly
        reads `static`, and a live distributor is libelled by omission."""
        import inspect

        param = inspect.signature(build_row).parameters["live_slugs"]
        assert param.default is inspect.Parameter.empty

    def test_calling_build_row_without_it_is_an_error(self, db):
        part = _part(db)
        _listing(db, part, _sourceless(db))
        with pytest.raises(TypeError):
            build_row(db, 0, "exact", part, None, None, None)
