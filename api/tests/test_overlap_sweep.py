"""The manufacturer-scoped overlap sweep — Import, for a distributor that is
not the one who filled the catalog.

WHAT THIS IS FOR. 175,728 parts, and until now exactly one of them could carry
a live price: Mouser's. A comparison site whose comparison column is empty is
the problem this sweep exists to fix, and the unit of work it needs is not the
one `grow_catalog` already has. Filling a CATEGORY asks "what does this
distributor sell on this shelf" and answers mostly with parts we do not hold;
the overlap question is the opposite one — "of the parts we ALREADY hold, which
does this distributor also sell" — and the only way to ask it inside a
distributor's API is to narrow the query until our own parts fall inside the
window it will return.

THE CONSTRAINT THAT DECIDES THE WHOLE DESIGN, measured live on 2026-08-24 (six
calls, quota 1000 -> 982, `x-ratelimit-limit: 1000`):

    POST /products/v4/search/keyword  with Offset=280, Limit=50
    -> HTTP 400 {"detail":"Offset + Limit must be less than or equal to 300"}

Every query gets a 300-record window and no more. So the sweep may never issue
a query whose result set is wider than that window without narrowing it first,
and the narrowing has to be derived from our OWN catalog, because deriving it
from the distributor costs the very calls we are rationing. `ProductsCount`
comes back free on every response (measured: `SN74LV` + ManufacturerFilter 296
-> ProductsCount 3689; `SN74LVC1` + the same filter -> 937), which makes it the
control signal: too wide, lengthen the prefix from our own SKUs and re-enqueue;
narrow enough, page the window out.

`ManufacturerFilter` was confirmed to work rather than assumed: across 150
records over two makers every `Manufacturer.Name` came back uniformly correct,
0 off-scope. It is a NARROWING device on a family query, not the unit of work —
a maker's own name is hopelessly too wide (Texas Instruments' whole catalog is
104,993 products against a 300-record window).
"""

from __future__ import annotations

import json
import pathlib
import time
import uuid
from decimal import Decimal

import httpx
import pytest

from app.jobs import feed_import_daily as job
from app.models import (
    Category,
    Manufacturer,
    ManufacturerAlias,
    Part,
    PartListing,
    ProviderCredential,
    Supplier,
    SupplierFeed,
)
from app.services.part_feed.digikey import (
    EXTRA_MANUFACTURER_IDS,
    SEARCH_WINDOW,
    DigiKeyProvider,
    FeedWindowExhausted,
    _fold_key,
    manufacturer_ids_by_key,
    part_from_digikey,
)
from app.services.part_feed.importer import (
    CURSOR_NS_CATEGORY,
    CURSOR_NS_FAMILY,
    FAMILY_PREFIX_MIN,
    IMPORT_CURSOR_EXHAUSTED,
    IMPORT_CURSOR_TOO_WIDE,
    FeedScope,
    FeedScopeUnsupported,
    WorkUnit,
    _CategorySweep,
    _cursor_clear_namespace,
    _cursor_get,
    _cursor_set,
    _Family,
    _FamilySweep,
    category_cursor_key,
    family_cursor_key,
    grow_catalog,
    search_scoped,
    sync_event,
)
from app.services.part_feed.mouser import FeedFatalError
from tests.feed_helpers import (
    FakeProvider,
    ScopedFakeProvider,
)
from tests.feed_helpers import feed_part as _feed_part

# The BYTE-FOR-BYTE body the live API answered with. Reproduced above; kept
# whole here because the translation in `_post` keys on its wording, and a
# paraphrase would certify a string DigiKey never sends.
OFFSET_WALL_BODY = {
    "type": "https://tools.ietf.org/html/rfc7231#section-6.5.1",
    "title": "Bad Request",
    "status": 400,
    "detail": "Offset + Limit must be less than or equal to 300",
    "instance": "",
    "correlationId": "53a4a7fb-24e3-491f-8833-907545c3ea31",
    "errors": {},
}


def _digikey(handler) -> DigiKeyProvider:
    """A provider whose transport is `handler` and whose throttle is off.

    The token request goes through the SAME transport, so `handler` has to
    answer `/v1/oauth2/token` too — see `_serve`.
    """
    provider = DigiKeyProvider(
        client_id="id-not-real",
        client_secret="secret-not-real",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    provider._throttle = lambda: None  # 0.55s per call would make this suite crawl
    return provider


def _serve(responder):
    """Wrap a search responder so the OAuth call is answered first."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth2/token"):
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 600})
        return responder(request)

    return handler


@pytest.fixture(autouse=True)
def _no_shared_token():
    """The access token is cached on the CLASS (one token per client, shared by
    every provider instance). A token minted by one test would otherwise be
    handed to the next one's transport, which never sees the token request it
    was written to answer."""
    DigiKeyProvider._token = None
    DigiKeyProvider._token_expires_at = 0.0
    yield
    DigiKeyProvider._token = None
    DigiKeyProvider._token_expires_at = 0.0


class TestTheOffsetWindowIsExhaustionNotAnOutage:
    """A paging wall must read as "this query has no more rows", never as
    "the feed is down".

    `_post` raised FeedFatalError on every non-200, and FeedFatalError is the
    quota wall: the generators catch it, emit `sync_error`, and the nightly job
    STOPS THE WHOLE NIGHT on it, because a real quota refusal is account-wide
    and every remaining supplier would only spend calls to be refused
    identically. So the first family or category to page past record 300 would
    have ended the run with "Feed unavailable" and starved every supplier
    behind it — a healthy feed reported as an outage.

    This is deliberately tested by feeding the REAL 400 body through `_post`
    over a mock transport, and NOT by handing a FakeProvider a short page. A
    FakeProvider structurally cannot produce this failure: it has no HTTP layer
    to return a 400 from, so a fake-based test would certify exhaustion
    behaviour on the one path where the defect cannot exist. That is exactly
    how this survived the design review.
    """

    def test_post_translates_the_real_400_into_exhaustion_not_a_fatal(self):
        provider = _digikey(_serve(lambda r: httpx.Response(400, json=OFFSET_WALL_BODY)))

        with pytest.raises(FeedWindowExhausted):
            provider._post("/products/v4/search/keyword", {"Keywords": "x", "Offset": 280})

        assert not issubclass(FeedWindowExhausted, FeedFatalError), (
            "the window wall must NOT be a FeedFatalError — the nightly job treats "
            "that as an account-wide quota refusal and abandons every remaining supplier"
        )

    def test_a_different_400_is_still_fatal(self):
        """Only the window refusal is benign. A malformed request is a bug and
        has to stay loud, or every 400 becomes an invisible empty page."""
        body = {**OFFSET_WALL_BODY, "detail": "Keywords is required"}
        provider = _digikey(_serve(lambda r: httpx.Response(400, json=body)))

        with pytest.raises(FeedFatalError):
            provider._post("/products/v4/search/keyword", {"Keywords": ""})

    def test_a_400_with_an_unparseable_body_is_still_fatal(self):
        """The translation reads the response body. A gateway that answers 400
        with HTML must not crash the reader — and must not be mistaken for the
        window wall either."""
        provider = _digikey(_serve(lambda r: httpx.Response(400, text="<html>nope</html>")))

        with pytest.raises(FeedFatalError):
            provider._post("/products/v4/search/keyword", {"Keywords": "x"})

    def test_search_reports_a_short_page_rather_than_raising(self):
        """What the sweep actually consumes. A generator advancing its cursor
        reads `last_raw_count`; exhaustion is a page of zero rows, which is the
        same signal a genuinely emptied shelf sends."""
        provider = _digikey(_serve(lambda r: httpx.Response(400, json=OFFSET_WALL_BODY)))

        out = provider.search("SN74LV", limit=50, start_at=280)

        assert out == []
        assert provider.last_raw_count == 0, (
            "a wall that leaves last_raw_count stale makes the cursor advance over "
            "records nobody read"
        )

    def test_an_offset_at_or_past_the_window_spends_no_call_at_all(self):
        """Cheaper than discovering it: the wall is arithmetic we already know.

        A call spent to be told 'Offset + Limit must be <= 300' is a call not
        spent on a part, and at a 1,000/day ceiling shared with the nightly
        sweep that is not a rounding error.
        """
        provider = _digikey(_serve(lambda r: pytest.fail("no request should be sent")))

        assert provider.search("SN74LV", limit=50, start_at=SEARCH_WINDOW) == []
        assert provider.calls_made == 0
        assert provider.last_raw_count == 0

    def test_a_page_that_would_straddle_the_window_is_trimmed_not_refused(self):
        """Offset 280 + Limit 50 is 330 and would 400. The last 20 records are
        real and reachable; asking for 20 is worth a call, throwing the page
        away is not."""
        asked: list[dict] = []

        def responder(request: httpx.Request) -> httpx.Response:
            asked.append(json.loads(request.content))
            return httpx.Response(200, json={"Products": [], "ProductsCount": 3689})

        provider = _digikey(_serve(responder))
        provider.search("SN74LV", limit=50, start_at=280)

        assert asked[-1]["Limit"] == SEARCH_WINDOW - 280 == 20
        assert asked[-1]["Offset"] == 280


class TestProductsCountIsTheControlSignal:
    """`ProductsCount` rides free on every response and is what tells the sweep
    whether a query fits its window. Measured live: SN74LV + TI -> 3689,
    SN74LVC1 + TI -> 937, both against a 300-record ceiling."""

    def _counting_provider(self, count: int, rows: int = 0):
        products = [
            {
                "ManufacturerProductNumber": f"MPN-{i}",
                "Manufacturer": {"Name": "Texas Instruments"},
            }
            for i in range(rows)
        ]
        return _digikey(
            _serve(
                lambda r: httpx.Response(200, json={"Products": products, "ProductsCount": count})
            )
        )

    def test_a_search_records_how_many_products_matched(self):
        provider = self._counting_provider(3689)
        provider.search("SN74LV")
        assert provider.last_total_count == 3689

    def test_it_belongs_to_the_LAST_search_not_the_run(self):
        """Same reasoning as `last_raw_count`: a stale total from the previous
        query would narrow (or fail to narrow) the wrong unit."""
        provider = self._counting_provider(3689)
        provider.search("SN74LV")
        provider._client = httpx.Client(
            transport=httpx.MockTransport(
                _serve(lambda r: httpx.Response(200, json={"Products": [], "ProductsCount": 937}))
            )
        )
        provider.search("SN74LVC1")
        assert provider.last_total_count == 937

    def test_a_response_without_it_reports_None_rather_than_zero(self):
        """None means "the feed did not say"; 0 would mean "no such products",
        and the sweep treats those differently — one is unknown width, the
        other is an exhausted unit."""
        provider = _digikey(_serve(lambda r: httpx.Response(200, json={"Products": []})))
        provider.search("SN74LV")
        assert provider.last_total_count is None

    def test_the_window_constant_is_the_measured_one(self):
        assert SEARCH_WINDOW == 300, (
            "SEARCH_WINDOW mirrors a limit the API enforces; changing it here does "
            "not change the API, it only stops us from predicting its refusals"
        )


def test_the_token_is_not_charged_to_the_call_budget():
    """Kept honest while the transport is in front of us: `calls_made` is the
    currency the sweep's budget spends, and whether a token mint draws on the
    1,000/day pool is undocumented. It is excluded deliberately — the budget
    carries a reserve instead of guessing."""
    provider = _digikey(
        _serve(lambda r: httpx.Response(200, json={"Products": [], "ProductsCount": 0}))
    )
    provider.search("anything")
    assert provider.calls_made == 1
    assert time.monotonic() < DigiKeyProvider._token_expires_at


class TestFeedScopeRefusesAQueryThatSpendsAndCannotWork:
    """An empty keyword is a 400 that STILL decrements the rate limit.

    Measured on the live API. A scope is constructed once per work unit and
    used for up to six pages, so one unusable scope is up to six calls bought
    and thrown away — and at 1,000/day shared with the nightly sweep that is
    real inventory nobody got.
    """

    def test_a_blank_keyword_is_refused_at_construction(self):
        with pytest.raises(ValueError):
            FeedScope(keyword="   ")

    def test_a_real_keyword_is_kept_verbatim(self):
        """No normalisation. The keyword is an MPN PREFIX taken from our own
        SKUs, and `1.5SMC6.8A` is a different part from `1.5SMC68A` — the
        decimal point is load-bearing, which is exactly why part identity
        refuses to strip punctuation."""
        scope = FeedScope(keyword="1.5SMC6.8A", manufacturer_id="296")
        assert scope.keyword == "1.5SMC6.8A"
        assert scope.manufacturer_id == "296"


class TestAScopeIsHonouredOrRefusedNeverSilentlyDropped:
    """The failure this prevents is a SILENT one, which is why it is loud.

    A provider with no scoped search that quietly ran the keyword unfiltered
    would still return 50 rows and still look like a working sweep. It would
    just be answering the catalog-wide question instead of the
    one-manufacturer question — 3,689 products' worth of noise where 376 of
    our parts live — and nothing in the counts would say so.
    """

    def test_an_unscoped_provider_serves_a_keyword_only_scope(self):
        """Mouser has no manufacturer filter and needs none: its work unit is
        a category, whose scope carries no manufacturer."""
        provider = FakeProvider(search_results=[_feed_part("KW-1")])

        out = search_scoped(provider, FeedScope(keyword="Resistors"), 50, 0)

        assert [fp.mpn for fp in out] == ["KW-1"]
        assert provider.search_calls == [("Resistors", 50, 0)]

    def test_an_unscoped_provider_REFUSES_a_manufacturer_scope(self):
        provider = FakeProvider(search_results=[_feed_part("KW-1")])

        with pytest.raises(FeedScopeUnsupported):
            search_scoped(provider, FeedScope(keyword="SN74LV", manufacturer_id="296"), 50, 0)

        assert provider.calls_made == 0, "a refusal must not spend a call first"

    def test_a_scoped_provider_is_handed_the_whole_scope(self):
        provider = ScopedFakeProvider(results_by_keyword={"SN74LV": [_feed_part("SN74LV1T08")]})

        search_scoped(provider, FeedScope(keyword="SN74LV", manufacturer_id="296"), 50, 0)

        assert provider.scopes_asked == [("SN74LV", "296", 50, 0)]


class TestCursorKeysAreNamespaced:
    """The collision is LIVE on production today, not hypothetical.

        SELECT e.key, e.value FROM supplier_feeds f,
               json_each_text(f.import_cursor::json) e WHERE e.key='diodes';
        -> diodes | 300

        SELECT canonical_key, name, catalog_part_count FROM manufacturers
         WHERE canonical_key='diodes';
        -> diodes | Diodes Inc. | 1312

    One map, one flat key space, and `diodes` means two entirely different
    things in it. Unnamespaced, the family sweep would open at record 300 of a
    query it has never issued, and the category sweep would be retired by a
    manufacturer it has never heard of.

    The read-shim is safe because no category slug can look like a namespaced
    key: `SELECT count(*) FROM categories WHERE slug !~ '^[a-z0-9-]+$'`
    returns 0 across all 189 of them.
    """

    def test_the_two_namespaces_cannot_produce_the_same_key(self):
        assert category_cursor_key("diodes") != family_cursor_key("diodes", "1N4148")

    def test_a_legacy_bare_slug_is_still_read_as_the_category_cursor(self):
        """60 of production's 189 keys are already marked exhausted. Losing the
        shim restarts every one of those categories from page 1 — a full
        re-read of the catalog at one call per 50 parts."""
        assert _cursor_get({"diodes": 300}, category_cursor_key("diodes")) == 300

    def test_a_legacy_bare_slug_is_never_read_as_a_family_cursor(self):
        assert _cursor_get({"diodes": 300}, family_cursor_key("diodes", "1N4148")) is None

    def test_a_namespaced_value_wins_over_its_legacy_twin(self):
        assert _cursor_get({"diodes": 300, "cat:diodes": 50}, category_cursor_key("diodes")) == 50

    def test_writing_retires_the_legacy_twin_rather_than_shadowing_it_forever(self):
        cursor = {"diodes": 300}
        _cursor_set(cursor, category_cursor_key("diodes"), 350)
        assert cursor == {"cat:diodes": 350}

    def test_a_family_key_lives_in_the_family_namespace(self):
        """Not merely "different from the category key" — IN the namespace, or
        the per-strategy wrap silently stops finding it and a family sweep can
        never restart."""
        key = family_cursor_key("diodes", "1N4148")
        assert key.startswith(f"{CURSOR_NS_FAMILY}:")
        assert _cursor_clear_namespace({key: 50}, CURSOR_NS_FAMILY) == {}
        assert _cursor_clear_namespace({key: 50}, CURSOR_NS_CATEGORY) == {key: 50}

    def test_clearing_one_namespace_leaves_the_other_untouched(self):
        """A wrap is per-strategy. Clearing the whole map would throw away the
        other distributor's paging depth for free."""
        cursor = {
            "cat:diodes": IMPORT_CURSOR_EXHAUSTED,
            "resistors": IMPORT_CURSOR_EXHAUSTED,  # legacy twin, same namespace
            "fam:diodes:1N4148": 50,
        }
        assert _cursor_clear_namespace(cursor, CURSOR_NS_CATEGORY) == {"fam:diodes:1N4148": 50}
        assert _cursor_clear_namespace(cursor, CURSOR_NS_FAMILY) == {
            "cat:diodes": IMPORT_CURSOR_EXHAUSTED,
            "resistors": IMPORT_CURSOR_EXHAUSTED,
        }


# ── fixtures for the family sweep ────────────────────────────────────────────


def _maker(db, name: str, key: str) -> Manufacturer:
    maker = Manufacturer(
        id=uuid.uuid4(), name=name, slug=key.replace(" ", "-"), canonical_key=key, source="catalog"
    )
    db.add(maker)
    db.flush()
    return maker


def _held(db, maker, sku, category=None) -> Part:
    """A part WE hold — the overlap sweep's whole subject."""
    part = Part(
        id=uuid.uuid4(),
        sku=sku,
        slug=sku.lower(),
        manufacturer_name=maker.name,
        manufacturer_id=maker.id,
        category_id=category.id if category is not None else None,
    )
    db.add(part)
    db.flush()
    return part


def _listing(db, part, supplier, price="1.00") -> PartListing:
    row = PartListing(
        id=uuid.uuid4(),
        part_id=part.id,
        supplier_id=supplier.id,
        unit_price=Decimal(price),
        stock_quantity=3,
    )
    db.add(row)
    db.flush()
    return row


def _counts(events: list[dict]) -> dict:
    return events[-1]["counts"]


def _actions(events: list[dict]) -> list[str]:
    return [e["action"] for e in events if e["kind"] == "part_synced"]


class TestTheFamilySweepOnlyEverAddsAnOffer:
    """The overlap sweep exists to put a SECOND price beside a part we already
    have. It creates nothing, refreshes nothing, and touches nothing it was not
    asked about — and each of those three is a separate way it could quietly
    turn into a different feature.

    Creating parts is deferred on purpose (0 of 175,728 parts have a NULL
    category today, so a DigiKey-only part would land uncategorised and
    unreachable — that needs a category map, which is Phase 4). Refreshing is
    Sync Inventory's job, and the `synced == 0` invariant is the assertion that
    catches it drifting back.
    """

    def _sweep(self, db, seeded_db, provider, budget=1):
        return list(grow_catalog(db, provider, seeded_db["supplier1"], call_budget=budget))

    def test_a_part_we_hold_gains_this_suppliers_first_offer(self, db, seeded_db):
        maker = _maker(db, "Texas Instruments", "texas instruments")
        part = _held(db, maker, "SN74LV1T08DBVR")
        db.commit()
        provider = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            results_by_keyword={
                "SN74LV": [_feed_part("SN74LV1T08DBVR", manufacturer="Texas Instruments")]
            },
        )

        events = self._sweep(db, seeded_db, provider)

        assert _actions(events) == ["listing_added"]
        listing = (
            db.query(PartListing)
            .filter_by(part_id=part.id, supplier_id=seeded_db["supplier1"].id)
            .one()
        )
        assert listing.unit_price is not None

    def test_it_asks_the_distributor_a_scoped_question(self, db, seeded_db):
        """The prefix comes from our own SKUs and the filter from the map. An
        unscoped `SN74LV` matches 3,689 products against a 300-record window;
        scoped to Texas Instruments it is a question about parts we hold."""
        maker = _maker(db, "Texas Instruments", "texas instruments")
        _held(db, maker, "SN74LV1T08DBVR")
        db.commit()
        provider = ScopedFakeProvider(manufacturer_ids={"texas instruments": 296})

        self._sweep(db, seeded_db, provider)

        assert provider.scopes_asked, "the sweep issued no scoped query at all"
        keyword, mfr, _limit, start_at = provider.scopes_asked[0]
        assert keyword == "SN74LV"  # left(sku, FAMILY_PREFIX_MIN)
        assert mfr == "296"
        assert start_at == 0

    def test_an_unheld_part_in_an_UNCATEGORISED_family_is_declined_with_no_write(
        self, db, seeded_db
    ):
        """Phase 4 creates ONLY under a family whose held members say where it
        lives. This family's one member has no category, so there is no anchor
        and the honest answer is still to leave it alone — a part with no
        category is a page no visitor can reach from anywhere on the site."""
        maker = _maker(db, "Texas Instruments", "texas instruments")
        _held(db, maker, "SN74LV1T08DBVR")
        db.commit()
        provider = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            results_by_keyword={
                "SN74LV": [_feed_part("SN74LV595APW", manufacturer="Texas Instruments")]
            },
        )

        events = self._sweep(db, seeded_db, provider)

        assert _actions(events) == []
        assert db.query(Part).filter(Part.sku == "SN74LV595APW").count() == 0
        assert _counts(events)["created"] == 0

    def test_an_unheld_sibling_is_created_into_the_familys_own_category(self, db, seeded_db):
        """Phase 4 (2026-08-29): the family window was derived from parts we
        hold, and when their categories agree the unheld sibling on the same
        page is filed with them — the measured alternative was 23,530 new
        parts read and discarded in one 850-call night."""
        child = db.query(Category).filter(Category.parent_id.isnot(None)).first()
        maker = _maker(db, "Texas Instruments", "texas instruments")
        _held(db, maker, "SN74LV1T08DBVR", category=child)
        _held(db, maker, "SN74LV2T45DCU", category=child)
        db.commit()
        provider = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            results_by_keyword={
                "SN74LV": [_feed_part("SN74LV595APW", manufacturer="Texas Instruments")]
            },
        )

        events = self._sweep(db, seeded_db, provider)

        assert _actions(events) == ["created"]
        assert _counts(events)["created"] == 1
        created = db.query(Part).filter(Part.sku == "SN74LV595APW").one()
        assert created.category_id == child.id
        assert created.sub_slug == child.slug
        assert created.manufacturer_id is not None
        # The offer rides in with the row — a created part is a priced part.
        assert (
            db.query(PartListing)
            .filter_by(part_id=created.id, supplier_id=seeded_db["supplier1"].id)
            .count()
            == 1
        )

    def test_a_family_split_down_the_middle_declines_the_sibling(self, db, seeded_db):
        """No two-thirds consensus, no anchor: a coin-flip category is worse
        than absence."""
        parent = db.query(Category).filter(Category.parent_id.is_(None)).first()
        cats = [
            Category(
                id=uuid.uuid4(),
                name=f"Split {i}",
                slug=f"split-{i}",
                icon="cpu",
                parent_id=parent.id,
                sort_order=90 + i,
            )
            for i in (1, 2)
        ]
        db.add_all(cats)
        db.flush()
        maker = _maker(db, "Texas Instruments", "texas instruments")
        _held(db, maker, "SN74LV1T08DBVR", category=cats[0])
        _held(db, maker, "SN74LV2T45DCU", category=cats[1])
        db.commit()
        provider = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            results_by_keyword={
                "SN74LV": [_feed_part("SN74LV595APW", manufacturer="Texas Instruments")]
            },
        )

        events = self._sweep(db, seeded_db, provider)

        assert _actions(events) == []
        assert db.query(Part).filter(Part.sku == "SN74LV595APW").count() == 0
        assert _counts(events)["created"] == 0

    def test_a_top_level_anchor_files_the_sibling_without_a_sub_slug(self, db, seeded_db):
        """Old seeds attach parts to TOP-LEVEL categories; a family anchored
        there must file the sibling the same way `create_part` would —
        `sub_slug` None, never the parent's slug (the category page filters
        on `sub_slug` and a parent slug there matches nothing)."""
        parent = db.query(Category).filter(Category.parent_id.is_(None)).first()
        maker = _maker(db, "Texas Instruments", "texas instruments")
        _held(db, maker, "SN74LV1T08DBVR", category=parent)
        db.commit()
        provider = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            results_by_keyword={
                "SN74LV": [_feed_part("SN74LV595APW", manufacturer="Texas Instruments")]
            },
        )

        self._sweep(db, seeded_db, provider)

        created = db.query(Part).filter(Part.sku == "SN74LV595APW").one()
        assert created.category_id == parent.id
        assert created.sub_slug is None

    def test_a_part_this_supplier_ALREADY_lists_is_left_untouched(self, db, seeded_db):
        maker = _maker(db, "Texas Instruments", "texas instruments")
        part = _held(db, maker, "SN74LV1T08DBVR")
        listing = _listing(db, part, seeded_db["supplier1"], price="9.99")
        db.commit()
        before = listing.unit_price
        provider = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            results_by_keyword={
                "SN74LV": [_feed_part("SN74LV1T08DBVR", manufacturer="Texas Instruments")]
            },
        )

        events = self._sweep(db, seeded_db, provider)

        db.expire_all()
        assert db.query(PartListing).filter_by(part_id=part.id).one().unit_price == before, (
            "the overlap sweep repriced a listing it already had — that is Sync "
            "Inventory's job and it spends a rate-limited call to do it twice"
        )
        assert _actions(events) == []

    def test_a_row_for_a_DIFFERENT_maker_is_counted_off_scope_not_written(self, db, seeded_db):
        """The rot gate on `ManufacturerFilter`. Measured live it holds — 0
        off-scope rows across 150 records over two makers — so this counter
        should stay at zero forever. It exists so that the day it does not, the
        run says so instead of writing another company's price onto our part."""
        ti = _maker(db, "Texas Instruments", "texas instruments")
        _maker(db, "Onsemi", "onsemi")
        _held(db, ti, "SN74LV1T08DBVR")
        db.commit()
        provider = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            results_by_keyword={"SN74LV": [_feed_part("SN74LV1T08DBVR", manufacturer="Onsemi")]},
        )

        events = self._sweep(db, seeded_db, provider)

        assert _actions(events) == []
        assert "off scope" in events[-1]["detail"]

    def test_an_unknown_maker_is_declined_WITHOUT_minting_a_manufacturer_row(self, db, seeded_db):
        """The rule that makes provisional rows structurally unreachable here.

        `part_identity.resolve_manufacturer_id` — the function every other feed
        path calls — MINTS a `source='catalog'` manufacturer plus an alias on a
        miss, which is correct where a part is about to be created and needs a
        key. It is exactly wrong for an unattended overlap sweep: DigiKey's
        catalog is far larger than ours, so every unrecognised maker on every
        page would become a row in a table whose merge queue a human reviews by
        hand, and this path never creates a part for them to belong to anyway.

        Asserted on the TABLE COUNT rather than on the counter, because the
        decline is visible either way — it is the side effect that is not.
        """
        ti = _maker(db, "Texas Instruments", "texas instruments")
        _held(db, ti, "SN74LV1T08DBVR")
        db.commit()
        before = db.query(Manufacturer).count()
        provider = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            results_by_keyword={
                "SN74LV": [
                    _feed_part("SN74LV1T08DBVR", manufacturer="Shenzhen Nobody Ever Heard Of")
                ]
            },
        )

        events = self._sweep(db, seeded_db, provider)

        assert _actions(events) == []
        assert db.query(Manufacturer).count() == before, (
            "the sweep invented a manufacturer for a row it then declined — an "
            "unattended run doing this fills the merge-review queue with a "
            "distributor's spelling variants"
        )
        assert (
            db.query(ManufacturerAlias)
            .filter(ManufacturerAlias.alias_canon == "shenzhen nobody ever heard of")
            .count()
            == 0
        )

    def test_an_alias_of_the_scoped_maker_is_NOT_off_scope(self, db, seeded_db):
        """`canon()` equality is not the only way two names are one company.
        DigiKey writes 'Texas Instruments'; a feed that writes 'TI' resolves
        through `manufacturer_aliases` to the same row, and declining it as
        off-scope would silently drop every part that maker sells."""
        ti = _maker(db, "Texas Instruments", "texas instruments")
        db.add(
            ManufacturerAlias(
                manufacturer_id=ti.id,
                alias_canon="ti",
                alias="TI",
                source="catalog",
                confidence="auto",
            )
        )
        _held(db, ti, "SN74LV1T08DBVR")
        db.commit()
        provider = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            results_by_keyword={"SN74LV": [_feed_part("SN74LV1T08DBVR", manufacturer="TI")]},
        )

        events = self._sweep(db, seeded_db, provider)

        assert _actions(events) == ["listing_added"]

    def test_an_import_run_never_increments_synced(self, db, seeded_db):
        """The invariant that catches this becoming Sync Inventory again. If
        `synced` ever moves on an overlap run, the sweep is refreshing listings
        it already had — the exact defect commit b380922 removed from the
        category sweep."""
        maker = _maker(db, "Texas Instruments", "texas instruments")
        held = _held(db, maker, "SN74LV1T08DBVR")
        _listing(db, _held(db, maker, "SN74LVC2T45"), seeded_db["supplier1"])
        db.commit()
        assert held is not None
        provider = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            results_by_keyword={
                "SN74LV": [
                    _feed_part("SN74LV1T08DBVR", manufacturer="Texas Instruments"),
                    _feed_part("SN74LVC2T45", manufacturer="Texas Instruments"),
                    _feed_part("SN74LV595APW", manufacturer="Texas Instruments"),
                ]
            },
        )

        counts = _counts(self._sweep(db, seeded_db, provider))

        assert counts["synced"] == 0
        assert counts["created"] == 0
        assert counts["listing_added"] == 1

    def test_a_maker_the_distributor_cannot_scope_produces_no_work(self, db, seeded_db):
        """No id in the map means no way to narrow the query. Running it
        unfiltered would spend calls reading another manufacturer's catalog."""
        maker = _maker(db, "Obscure Passives", "obscure passives")
        _held(db, maker, "OBS1234567")
        db.commit()
        provider = ScopedFakeProvider(manufacturer_ids={})

        events = self._sweep(db, seeded_db, provider)

        assert provider.calls_made == 0
        assert events[-1]["kind"] == "sync_finished"


class TestProductsCountNarrowsTheQueryInsteadOfPagingIt:
    """The 300-record window is the constraint the whole strategy answers to.

    `SN74LV` scoped to Texas Instruments matches 3,689 products. Paging it out
    reads 300 of them — 8% — and the other 3,389 are unreachable at that
    keyword FOREVER, however many calls are spent. Lengthening the prefix from
    our own SKUs opens a NEW window over a different slice, which is why the
    family sweep has somewhere to go and a maker-name sweep does not.
    """

    def _ti_with_two_families(self, db):
        maker = _maker(db, "Texas Instruments", "texas instruments")
        _held(db, maker, "SN74LVC2T45DCUR")
        _held(db, maker, "SN74LV1T08DBVR")
        db.commit()
        return maker

    def test_a_query_wider_than_the_window_is_marked_too_wide(self, db, seeded_db):
        self._ti_with_two_families(db)
        provider = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            totals_by_keyword={"SN74LV": 3689},
        )

        list(grow_catalog(db, provider, seeded_db["supplier1"], call_budget=1))

        row = db.query(SupplierFeed).filter_by(supplier_id=seeded_db["supplier1"].id).one()
        assert row.import_cursor[family_cursor_key("texas instruments", "SN74LV")] == (
            IMPORT_CURSOR_TOO_WIDE
        )

    def test_the_next_run_asks_a_LONGER_prefix_taken_from_our_own_skus(self, db, seeded_db):
        """`SN74LV` becomes `SN74LVC` and `SN74LV1` — the two seven-character
        prefixes our catalog actually holds under it. Deriving them from our
        SKUs rather than from the alphabet costs nothing and asks only about
        parts we own."""
        self._ti_with_two_families(db)
        provider = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            totals_by_keyword={"SN74LV": 3689},
        )
        list(grow_catalog(db, provider, seeded_db["supplier1"], call_budget=1))

        second = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            totals_by_keyword={"SN74LVC": 41, "SN74LV1": 37},
        )
        list(grow_catalog(db, provider=second, supplier=seeded_db["supplier1"], call_budget=4))

        assert {kw for kw, *_ in second.scopes_asked} == {"SN74LVC", "SN74LV1"}

    def test_a_query_INSIDE_the_window_is_paged_not_narrowed(self, db, seeded_db):
        self._ti_with_two_families(db)
        provider = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            totals_by_keyword={"SN74LV": 120},
            results_by_keyword={
                "SN74LV": [
                    _feed_part(f"SN74LV-{i}", manufacturer="Texas Instruments") for i in range(50)
                ]
            },
        )

        list(grow_catalog(db, provider, seeded_db["supplier1"], call_budget=1))

        row = db.query(SupplierFeed).filter_by(supplier_id=seeded_db["supplier1"].id).one()
        assert row.import_cursor[family_cursor_key("texas instruments", "SN74LV")] == 50

    def test_a_family_read_to_the_end_of_its_window_is_exhausted(self, db, seeded_db):
        """`min(ProductsCount, 300)` is the reachable window, and reaching it
        must retire the unit — otherwise every later run re-buys the same 300
        records and reports nothing new, which is the plateau the category
        cursor was built to fix."""
        self._ti_with_two_families(db)
        provider = ScopedFakeProvider(
            manufacturer_ids={"texas instruments": 296},
            totals_by_keyword={"SN74LV": 40},
            results_by_keyword={
                "SN74LV": [
                    _feed_part(f"SN74LV-{i}", manufacturer="Texas Instruments") for i in range(40)
                ]
            },
        )

        list(grow_catalog(db, provider, seeded_db["supplier1"], call_budget=1))

        row = db.query(SupplierFeed).filter_by(supplier_id=seeded_db["supplier1"].id).one()
        assert row.import_cursor[family_cursor_key("texas instruments", "SN74LV")] == (
            IMPORT_CURSOR_EXHAUSTED
        )

    def test_the_minimum_prefix_is_the_measured_one(self):
        """Measured over the live catalog (175,728 parts, all covered at every
        length): 3-char yields 23,047 (maker, prefix) groups, 4-char 36,310,
        6-char 71,170. Six is where a group is narrow enough to be worth a
        probe without the tree of shorter prefixes above it costing a call per
        level — but it is a TUNABLE, and night one's ProductsCount histogram is
        what should actually set it."""
        assert FAMILY_PREFIX_MIN == 6


class TestTheCategorySweepStillBehavesExactlyAsItDid:
    """The refactor's only defensible outcome. `grow_catalog` now dispatches a
    STRATEGY into one shared generator; if that changed a single byte of what
    Mouser's nightly run does, the extraction was not worth making."""

    def _shelf(self, db, seeded_db, name="Voltage References", slug="voltage-references"):
        cat = Category(
            id=uuid.uuid4(),
            name=name,
            slug=slug,
            icon="cpu",
            parent_id=seeded_db["parent"].id,
            sort_order=0,
        )
        db.add(cat)
        db.commit()
        return cat

    def test_a_legacy_bare_cursor_still_resumes_where_it_stopped(self, db, seeded_db):
        """Production's live cursor map holds 189 BARE slugs. If the namespace
        change cannot read them, every one of those categories silently
        restarts at page 1 and the next nightly run re-buys the whole catalog."""
        shelf = self._shelf(db, seeded_db)
        supplier = seeded_db["supplier1"]
        db.add(SupplierFeed(supplier_id=supplier.id, import_cursor={shelf.slug: 100}))
        db.commit()
        provider = FakeProvider(results_by_keyword={shelf.name: []})

        list(grow_catalog(db, provider, supplier, call_budget=1))

        assert provider.search_calls[0][2] == 100, (
            "the sweep restarted at record 0 — the legacy cursor was not read"
        )

    def test_the_cursor_it_writes_back_is_namespaced(self, db, seeded_db):
        shelf = self._shelf(db, seeded_db)
        supplier = seeded_db["supplier1"]
        db.add(SupplierFeed(supplier_id=supplier.id, import_cursor={shelf.slug: 100}))
        db.commit()

        list(grow_catalog(db, FakeProvider(), supplier, call_budget=1))

        row = db.query(SupplierFeed).filter_by(supplier_id=supplier.id).one()
        assert category_cursor_key(shelf.slug) in row.import_cursor
        assert shelf.slug not in row.import_cursor, (
            "the legacy twin was left behind — it will be read forever and never written"
        )


def _finished_event(supplier_id: str, **counts) -> dict:
    event = sync_event("sync_finished", supplier_id, "supplier", "done")
    event["counts"] = {
        "synced": 0,
        "media_filled": 0,
        "not_found": 0,
        "no_data": 0,
        "created": 0,
        "listing_added": 0,
        **counts,
    }
    return event


class TestTheNightlyJobCountsAListingAdded:
    """`listing_added` reached NEITHER the activity table NOR the nightly log,
    and the work it names has been shipping since commit b380922.

        $ grep -rn listing_added api/app/
        app/services/part_feed/importer.py: ...        # and nowhere else

    `grow_catalog` has been emitting this action — a distributor's FIRST offer
    on a part we already hold, which is the single most valuable thing an
    import can produce on a comparison site — and `_import_one` counted only
    `created` and `updated`/`media_filled`. So a night that added four hundred
    comparison rows logged `created=0 updated=0` and looked like a night that
    did nothing. That is not a future risk; it is a report that has been wrong
    for as long as the feature has existed.
    """

    def _target(self, supplier):
        return job._Target(
            supplier=supplier, name=supplier.name, provider_cls=FakeProvider, api_key="k-not-real"
        )

    def test_a_first_offer_is_counted_rather_than_dropped(self, db, seeded_db, monkeypatch):
        supplier = seeded_db["supplier1"]
        sid = str(supplier.id)
        monkeypatch.setattr(
            job,
            "grow_catalog",
            lambda *a, **k: iter(
                [
                    sync_event("part_synced", sid, "AAA — Mfr", action="listing_added"),
                    sync_event("part_synced", sid, "BBB — Mfr", action="listing_added"),
                    _finished_event(sid, listing_added=2),
                ]
            ),
        )

        stats = job._import_one(db, self._target(supplier), call_budget=1)

        assert stats["listing_added"] == 2
        assert stats["created"] == 0
        assert stats["synced"] == 0, (
            "a first offer is NEW inventory, not a refresh — folding it into `synced` "
            "is what made Import look like Sync"
        )

    def test_the_night_summary_carries_it(self, db, seeded_db, monkeypatch):
        """`run_once`'s dict IS the closing log line. A counter the per-supplier
        call tracks but the summary drops is invisible where anyone looks."""
        supplier = seeded_db["supplier1"]
        monkeypatch.setattr(job, "_eligible", lambda _db: [self._target(supplier)])
        monkeypatch.setattr(
            job,
            "_import_one",
            lambda _db, _t, _b: {
                "created": 1,
                "synced": 0,
                "listing_added": 7,
                "calls": 3,
                "fatal": False,
                "error": False,
                "skipped_locked": False,
            },
        )

        stats = job.run_once(db, now=None)

        assert stats["listing_added"] == 7


class TestTheFamilySweepStaysGatedOnTheOperatorSwitch:
    """Unattended, but only for suppliers the operator switched on.

    This class used to be `TestAFamilySweepIsNotRunUnattendedYet` and asserted
    the opposite. Both of its reasons were addressed rather than waived: the
    night now budgets per provider, and the `lifecycle_status` worry was
    measured away (Mouser reported no lifecycle on 12 of 12 sampled parts while
    Digi-Key reported one on 10, so one feed authors the column in practice;
    only 1.8% of parts have ever been feed-stamped and `_stamp_feed_facts`
    writes only on a real change).

    THE FIRST VERSION OF THIS CLASS COULD NOT FAIL. Both tests iterated
    `_eligible(db)` and asserted inside the loop — but the fixture creates no
    `SupplierFeed` rows, so `_eligible` returned [] and the bodies never ran.
    A mutation deleting the entire `auto_import_enabled` gate left them green,
    and so did deleting `provider_slug=` from `_Target` (it defaults to
    "mouser", which would bill Digi-Key against Mouser's budget). The tell was
    an `_enable` helper the class defined and never called. Everything here now
    builds a real eligible supplier first.
    """

    def _feedable(self, db, name: str, website: str, slug: str, *, enabled: bool):
        """A supplier the nightly job could actually pick up: matched by the
        registry, holding a credential, with the switch in a known state."""
        supplier = Supplier(id=uuid.uuid4(), name=name, website=website)
        db.add(supplier)
        db.add(ProviderCredential(provider=slug, api_key=f"key-for-{slug}"))
        db.flush()
        db.add(SupplierFeed(supplier_id=supplier.id, auto_import_enabled=enabled))
        db.commit()
        return supplier

    def test_the_switch_being_off_is_what_keeps_a_supplier_out(self, db):
        from app.jobs.feed_import_daily import _eligible

        off = self._feedable(
            db, "Switched Off Dist", "https://www.mouser.com", "mouser", enabled=False
        )
        assert off.id not in {t.supplier.id for t in _eligible(db)}, (
            "a supplier whose auto-import is OFF was selected for the nightly run"
        )

    def test_the_switch_being_on_is_what_lets_one_in(self, db):
        """The other half — without it, 'nothing is eligible' passes trivially."""
        from app.jobs.feed_import_daily import _eligible

        on = self._feedable(
            db, "Switched On Dist", "https://www.mouser.com", "mouser", enabled=True
        )
        picked = [t for t in _eligible(db) if t.supplier.id == on.id]
        assert picked, "a switched-ON supplier with a provider and a key was not selected"

    def test_a_selected_target_carries_the_slug_it_actually_matched(self, db, monkeypatch):
        """`_Target.provider_slug` defaults to "mouser", and the night budgets by
        it — so a Digi-Key target that forgot to set it would silently spend
        Mouser's allowance. Assert the MATCHED slug, not merely a truthy one."""
        from app.jobs.feed_import_daily import _eligible
        from app.services.part_feed import registry

        # Digi-Key declares TWO credential_env values and `_usable_credential`
        # requires every one beyond the travelling id from settings — a stored
        # row alone must not make a half-configured provider usable. Supplying
        # the secret here is what makes this a slug test rather than an
        # accidental re-test of that guard.
        monkeypatch.setattr(registry.settings, "DIGIKEY_CLIENT_SECRET", "s", raising=False)
        dk = self._feedable(
            db, "Digi-Key Electronics", "https://www.digikey.com", "digikey", enabled=True
        )
        picked = [t for t in _eligible(db) if t.supplier.id == dk.id]
        assert picked, "the Digi-Key supplier was not eligible at all"
        assert picked[0].provider_slug == "digikey", (
            f"target carries provider_slug={picked[0].provider_slug!r}; it would be "
            "billed against the wrong provider's budget"
        )


class TestTheManufacturerMap:
    """`ManufacturerFilter` is what makes a six-character prefix a precise
    question, and it needs DigiKey's id, which nothing in our schema knows.

    The map is GENERATED (`scripts/gen_digikey_manufacturers.py`) and committed
    for two reasons: the Docker build stage has no network or database, and a
    hand-typed id does not fail — it narrows to the WRONG COMPANY and writes
    that company's prices onto our parts, with nothing announcing it.

    Measured 2026-08-24 against the live catalog and DigiKey's 3,718-name list:
    454 of our 1,068 part-bearing makers match, covering 126,395 of 175,728
    parts (71.9%) and 93,459 of 130,728 Mouser-priced ones (71.5%). The
    exact-canon variant — no diacritic fold — reproduces the design's figures
    to the digit (452 / 124,548 / 92,169), which is the evidence the matcher is
    the right one; the fold is kept because it reaches 1,847 more parts for the
    same call budget and accented makers are real.
    """

    def test_the_committed_map_is_the_measured_size(self):
        """A regeneration that halves the map is a regression the diff would
        show and a test should refuse to let past silently."""
        assert len(manufacturer_ids_by_key()) >= 454

    def test_every_value_is_a_LIST_of_ids(self):
        """59 fold-keys inside DigiKey's OWN 3,718-name list collide with each
        other — `abracon` is 535 AND 6290. Storing one id would sweep a
        coin-flip half of such a maker's catalog and call it complete."""
        ids = manufacturer_ids_by_key()
        assert all(isinstance(v, tuple) and v for v in ids.values())
        assert all(isinstance(i, int) for v in ids.values() for i in v)
        assert len(ids["abracon"]) > 1, "the multi-id case must survive the round trip"

    def test_a_known_maker_resolves_to_a_scoped_query(self):
        scope = DigiKeyProvider.manufacturer_scope("texas instruments", "SN74LV")
        assert scope is not None
        assert scope.keyword == "SN74LV"
        assert scope.manufacturer_id == "296"

    def test_several_ids_ride_ONE_scope_not_several_queries(self):
        """`ManufacturerFilter` takes an array, so one call covers every id a
        maker has. A scope per id would double those makers' cost for no reach."""
        scope = DigiKeyProvider.manufacturer_scope("abracon", "ABM8G")
        assert scope is not None
        assert set(scope.manufacturer_id.split(",")) == {"535", "6290"}

    def test_the_ids_reach_the_wire_as_a_ManufacturerFilter_array(self):
        """The token is opaque to the importer, so the ONLY place its shape is
        checked is here, against the request DigiKey actually receives."""
        sent: list[dict] = []

        def responder(request: httpx.Request) -> httpx.Response:
            sent.append(json.loads(request.content))
            return httpx.Response(200, json={"Products": [], "ProductsCount": 0})

        provider = _digikey(_serve(responder))
        scope = DigiKeyProvider.manufacturer_scope("abracon", "ABM8G")
        provider.search_scoped(scope, limit=50, start_at=0)

        assert sent[-1]["FilterOptionsRequest"]["ManufacturerFilter"] == [
            {"Id": "535"},
            {"Id": "6290"},
        ]

    def test_an_unmapped_maker_yields_no_scope_rather_than_an_open_query(self):
        assert DigiKeyProvider.manufacturer_scope("no such company at all", "X") is None

    def test_a_hand_pin_wins_over_the_generated_block(self):
        """Pins are code because the REASON a pin is safe lives beside it. A
        regeneration must never quietly delete a human's decision."""
        ids = manufacturer_ids_by_key()
        for key, pinned in EXTRA_MANUFACTURER_IDS.items():
            assert ids[key] == pinned, f"the generated map overrode the pin for {key!r}"

    def test_the_largest_unmatched_maker_is_pinned(self):
        """`Analog Devices / Maxim Integrated` is 2,975 parts — our single
        biggest miss, and `canon` will never merge it because the same rule
        that keeps `Microchip USA` separate from `Microchip Technology` is
        load-bearing elsewhere."""
        scope = DigiKeyProvider.manufacturer_scope("analog devices maxim integrated", "AD8232")
        assert scope is not None
        assert set(scope.manufacturer_id.split(",")) == {"505", "175"}

    def test_the_diacritic_fold_is_what_reaches_wurth(self):
        """`canon()` NFKC-normalises but does not decompose accents, so our
        `Wurth Elektronik` and DigiKey's `Würth Elektronik` would never meet.
        Two makers and 1,847 parts turn on this one line."""
        assert _fold_key("Würth Elektronik") == _fold_key("Wurth Elektronik")
        assert DigiKeyProvider.manufacturer_scope("wurth elektronik", "WE-") is not None

    def test_the_fold_agrees_with_the_generator_that_built_the_file(self):
        """Two homes, one rule — the same trap as the password policy. If they
        drift, every accented maker silently stops resolving and the map still
        looks fine."""
        from scripts.gen_digikey_manufacturers import fold as generator_fold

        for name in ("Würth Elektronik", "Texas Instruments", "TDK-Lambda Americas Inc.", "3M"):
            assert _fold_key(name) == generator_fold(name)

    def test_an_unreadable_map_degrades_to_the_pins_rather_than_breaking_boot(self, monkeypatch):
        """Every other feature in this process is unrelated to DigiKey. A
        provider that can only sweep its pinned makers is a degraded feed; an
        ImportError at start-up is an outage."""
        monkeypatch.setattr(
            "app.services.part_feed.digikey._MANUFACTURER_MAP_PATH",
            pathlib.Path("/nonexistent/digikey_manufacturers.json"),
        )
        manufacturer_ids_by_key.cache_clear()
        try:
            degraded = manufacturer_ids_by_key()
            assert degraded == EXTRA_MANUFACTURER_IDS
        finally:
            manufacturer_ids_by_key.cache_clear()


# ── the two halves, wired together ──────────────────────────────────────────


class TestTheRealProviderAndTheSweepFitTogether:
    """Everything above tests one half against a stand-in. This drives the
    REAL `DigiKeyProvider` — its map, its scope, its window clamp, its
    `ProductsCount` — through the real `grow_catalog`, over a mock transport.

    Worth its own class because the two halves were written against each other
    from a shared design rather than from each other's code, and the seam
    between them (`import_strategy`, `manufacturer_scope`, `search_window`,
    `last_total_count`, `search_scoped`) is five attributes that fail
    independently and silently: a misspelled one makes the sweep do nothing,
    which is also what an empty catalog looks like.
    """

    def _catalog(self, db, seeded_db):
        """Two TI parts we hold and nobody prices, under one 6-char prefix."""
        supplier = Supplier(id=uuid.uuid4(), name="Digi-Key Electronics", website="digikey.com")
        db.add(supplier)
        maker = _maker(db, "Texas Instruments", "texas instruments")
        held = [
            _held(db, maker, "SN74LVC1G08DCKR"),
            _held(db, maker, "SN74LVC2G04DCKR"),
        ]
        db.commit()
        return supplier, maker, held

    def _page(self, mpns: list[str], total: int) -> dict:
        return {
            "ProductsCount": total,
            "SearchLocaleUsed": {"Currency": "USD"},
            "Products": [
                {
                    "ManufacturerProductNumber": mpn,
                    "Manufacturer": {"Name": "Texas Instruments"},
                    "Description": {"ProductDescription": "IC GATE"},
                    "QuantityAvailable": 4200,
                    "ProductVariations": [
                        {
                            "DigiKeyProductNumber": f"296-{mpn}-ND",
                            "MinimumOrderQuantity": 1,
                            "StandardPricing": [
                                {"BreakQuantity": 1, "UnitPrice": 0.41},
                                {"BreakQuantity": 100, "UnitPrice": 0.19},
                            ],
                        }
                    ],
                }
                for mpn in mpns
            ],
        }

    def test_a_real_provider_puts_a_second_price_on_a_part_we_already_hold(self, db, seeded_db):
        supplier, _maker_row, held = self._catalog(db, seeded_db)
        asked: list[dict] = []

        def responder(request: httpx.Request) -> httpx.Response:
            asked.append(json.loads(request.content))
            return httpx.Response(
                200, json=self._page(["SN74LVC1G08DCKR", "SN74LVC2G04DCKR"], total=2)
            )

        provider = _digikey(_serve(responder))

        events = list(grow_catalog(db, provider, supplier, call_budget=1))

        # It ran the FAMILY sweep, scoped to Texas Instruments, from our own SKUs.
        assert asked[-1]["Keywords"] == "SN74LV"
        assert asked[-1]["FilterOptionsRequest"]["ManufacturerFilter"] == [{"Id": "296"}]
        # Two comparison rows, created nothing, refreshed nothing.
        assert _actions(events) == ["listing_added", "listing_added"]
        counts = events[-1]["counts"]
        assert counts["listing_added"] == 2
        assert counts["created"] == 0
        assert counts["synced"] == 0
        prices = {
            row.unit_price
            for row in db.query(PartListing).filter(PartListing.supplier_id == supplier.id)
        }
        assert prices == {Decimal("0.4100")}
        # and it invented nothing: the two parts it priced are the two we held.
        assert {
            row.part_id for row in db.query(PartListing).filter_by(supplier_id=supplier.id)
        } == {part.id for part in held}

    def test_a_real_ProductsCount_over_the_window_marks_the_family_too_wide(self, db, seeded_db):
        """The measured case: `SN74LV` + TI answers ProductsCount 3,689 against
        a 300-record window. Paging it reads 8% and the rest is unreachable at
        that keyword however many calls are spent — so the cursor has to say
        'narrow me', not 'carry on'."""
        supplier, _maker_row, _held_rows = self._catalog(db, seeded_db)
        provider = _digikey(
            _serve(lambda r: httpx.Response(200, json=self._page(["SN74LVC1G08DCKR"], total=3689)))
        )

        list(grow_catalog(db, provider, supplier, call_budget=1))

        row = db.query(SupplierFeed).filter_by(supplier_id=supplier.id).one()
        assert row.import_cursor == {
            family_cursor_key("texas instruments", "SN74LV"): IMPORT_CURSOR_TOO_WIDE
        }


class TestNarrowingIsNotStarvedByTheUnitCap:
    """Found by running the enumeration against the real 175,728-part catalog,
    not by reading it.

    `units()` caps how many WorkUnits it BUILDS, because level 6 yields 71,170
    groups and a pass can spend at most `call_budget` of them. The first
    version of that cap broke out of the scan — and on real data `kept` fills
    inside the first few hundred rows, so the loop never reached the too-wide
    entries below and never queried the level below that. Measured: 56,689
    scopeable base units would have had to be exhausted before a single prefix
    ever grew, which at 850 calls a day is months during which the strategy's
    one distinguishing move never happens.

    The cap now skips CONSTRUCTION and lets the scan finish. Children of a
    too-wide parent are built regardless of it: they are few, and they are the
    only route to parts no shorter query can return.
    """

    def test_a_too_wide_family_is_expanded_even_when_the_cap_is_full(self, db, seeded_db):
        maker = _maker(db, "Texas Instruments", "texas instruments")
        # Six base families of THREE parts each against a too-wide family of
        # two, and `keep` is 4 (call_budget=1 x _FAMILY_UNIT_SLACK). The counts
        # are what make this test able to fail: `_groups` orders thickest-first,
        # so the fat stems fill the cap and `SN74LV` is reached only AFTER it is
        # full. Give the too-wide family the higher count instead and it sorts
        # first, the cap is never in front of it, and the test passes whether
        # the scan continues or breaks — which is exactly what it did on the
        # first attempt (mutation-checked: `continue` -> `break` stayed GREEN).
        for stem in ("AAAAAA", "BBBBBB", "CCCCCC", "DDDDDD", "EEEEEE", "FFFFFF"):
            for n in range(3):
                _held(db, maker, f"{stem}0{n}")
        _held(db, maker, "SN74LVC2T45")
        _held(db, maker, "SN74LV1T08")
        db.commit()
        provider = ScopedFakeProvider(manufacturer_ids={"texas instruments": 296})
        cursor = {family_cursor_key("texas instruments", "SN74LV"): IMPORT_CURSOR_TOO_WIDE}

        units = _FamilySweep().units(db, provider, seeded_db["supplier1"].id, cursor, 1)

        keywords = {u.scope.keyword for u in units}
        assert {"SN74LVC", "SN74LV1"} <= keywords, (
            f"the too-wide family was never narrowed — the unit cap ate its children: "
            f"{sorted(keywords)}"
        )
        assert "SN74LV" not in keywords, "the too-wide parent was re-asked at its own width"


class TestTheFamilySweepCanActuallyWrap:
    """Once every family is exhausted the sweep must restart, not go silent.

    `_sweep_run` decides wrap with
        wrapped = bool(units) and all(cursor[u.cursor_key] == EXHAUSTED for u in units)
    but `_FamilySweep.units()` filtered exhausted units OUT of the very list
    that expression reads. So the list can never contain one: `all(...)` is
    False for any non-empty list, `bool(units)` is False for the empty one, and
    `wrapped` is False in BOTH terminal states. `_cursor_clear_namespace` was
    unreachable for this strategy.

    `_CategorySweep.units()` returns every category unconditionally, which is
    exactly why wrap works there — the shared `pending` comprehension in
    `_sweep_run` already drops exhausted units, so a strategy that filters them
    itself is applying the same rule twice and breaking the other reader.

    Consequence: after roughly two months at ~1,000 calls/day (56,689 scopeable
    groups, about one call retires one) the sweep returns 0 units, spends 0
    calls, and emits sync_started/sync_finished with all-zero counts and no
    "catalog fully swept — restarting from the top" suffix. Indistinguishable
    from a healthy run that found nothing, and a part added under an exhausted
    prefix is never picked up again.

    The filter is NOT simply deleted: exhausted families would then occupy the
    `keep` budget and crowd out live work. The strategy answers the wrap
    question itself instead.
    """

    def test_the_strategy_reports_wrapped_when_it_has_nothing_left(self, db):
        strategy = _FamilySweep()
        assert hasattr(strategy, "is_wrapped"), (
            "the strategy cannot state its own terminal condition, so _sweep_run "
            "has to infer it from a list the strategy already filtered"
        )
        # No units left AND the scan saw families: that is 'wrapped', not 'idle'.
        strategy._exhausted_everything = True
        assert strategy.is_wrapped({}, []) is True

    def test_an_empty_catalog_is_idle_not_wrapped(self, db):
        """Nothing to sweep must not look like 'finished a full pass' — clearing
        the namespace on an empty catalog would loop forever doing nothing."""
        strategy = _FamilySweep()
        strategy._exhausted_everything = False
        assert strategy.is_wrapped({}, []) is False

    def test_the_category_strategy_keeps_its_existing_rule(self, db):
        """Mouser's behaviour is asserted verbatim elsewhere; it must not move."""
        strategy = _CategorySweep()
        unit = WorkUnit(
            cursor_key=category_cursor_key("diodes"),
            scope=FeedScope(keyword="Diodes", label="Diodes"),
            label="Diodes",
            payload=(None, "diodes"),
        )
        assert strategy.is_wrapped({unit.cursor_key: IMPORT_CURSOR_EXHAUSTED}, [unit]) is True
        assert strategy.is_wrapped({unit.cursor_key: 300}, [unit]) is False
        assert strategy.is_wrapped({}, []) is False


class TestTheWrapFlagCountsOutstandingWork:
    """My own `is_wrapped` fix had two defects; this pins both.

    `_FamilySweep.units()` records whether the scan found anything left to do,
    because the returned list has exhausted families filtered out of it and
    `_sweep_run` therefore cannot read the terminal state off it. Two mistakes
    in that recording:

    1. `saw_family` / `saw_unfinished` were initialised INSIDE the `while True:`
       narrowing loop, so every iteration reset them and only the last one
       survived to the assignment. A first pass that found plenty of work
       followed by a final narrowing pass that found none would report wrapped.
    2. Two `continue` arms that represent REAL outstanding work did not set
       `saw_unfinished`: a TOO_WIDE family (which goes to `expand` and is very
       much unfinished) and the keep-cap arm (which exists precisely because
       there is more work than budget).

    Either one makes `_exhausted_everything` true while work remains, which
    clears the family cursor namespace — so the sweep restarts from the top
    every run, re-reading pages it has already absorbed and never advancing.
    That is worse than the silence the flag was added to fix.

    A family whose scope cannot be built is deliberately NOT counted as
    outstanding: it can never be swept, so waiting for it would mean never
    wrapping. It is also not counted as *swept*, or an entirely unmappable
    catalog would report a full pass on every run forever.
    """

    def test_the_flags_survive_the_narrowing_loop(self):
        import ast
        import inspect
        import textwrap

        src = textwrap.dedent(inspect.getsource(_FamilySweep.units))
        tree = ast.parse(src).body[0]

        def _assigns(node) -> list[int]:
            return [
                n.lineno
                for n in ast.walk(node)
                if isinstance(n, ast.Assign)
                and any(
                    isinstance(t, ast.Name) and t.id in ("saw_sweepable", "saw_unfinished")
                    for t in n.targets
                )
                and isinstance(n.value, ast.Constant)
                and n.value.value is False
            ]

        whiles = [n for n in ast.walk(tree) if isinstance(n, ast.While)]
        assert whiles, "the narrowing loop is gone; this test needs rewriting"
        inside = {ln for w in whiles for ln in _assigns(w)}
        assert inside == set(), (
            "the wrap flags are reset inside the narrowing loop, so only its last "
            "iteration is remembered — hoist them above `while True:`"
        )
        assert _assigns(tree), "the wrap flags are never initialised at all"

    def test_an_unfinished_scan_is_not_a_wrap(self):
        strategy = _FamilySweep()
        strategy._exhausted_everything = False
        assert strategy.is_wrapped({}, []) is False

    def test_outstanding_work_is_recorded_before_the_branch_arms(self):
        """`saw_unfinished` is set ONCE, above the arms, so every one inherits it.

        Checked as ordering rather than per-arm, because that is the property
        that actually holds: TOO_WIDE (queued for narrowing) and the keep-cap
        (more work than budget) are both outstanding, and setting the flag
        before either branch is what makes adding a third arm safe by default.
        The one arm that must NOT inherit it — a family with no scope, which
        can never be swept — unwinds it explicitly.
        """
        import inspect

        src = inspect.getsource(_FamilySweep.units)
        set_at = src.index("saw_unfinished = True")
        too_wide_at = src.index("if state == IMPORT_CURSOR_TOO_WIDE")
        assert set_at < too_wide_at, (
            "outstanding work is recorded per-arm rather than before them, so a "
            "new arm defaults to 'nothing left to do' — which clears the cursor "
            "namespace and restarts the sweep from page one"
        )
        assert "saw_unfinished = _unfinished_before" in src, (
            "a family this distributor has no id for is being counted as "
            "outstanding work; with 592 unmapped makers the sweep can then never "
            "report a completed pass"
        )


class TestTheMakerGateComparesIdsNotSpellings:
    """The scope is built from distributor IDs; the gate compared NAMES.

    `units()` narrows every family query with `ManufacturerFilter=<ids>`, taken
    from a map whose entries exist BECAUSE our name and Digi-Key's name are the
    same company. `_resolve_maker` then asked whether the two sides SPELL the
    company identically. For the makers whose spellings already match, that is
    a tautology. For the rest it is exactly inverted — those entries are in the
    map PRECISELY because the spellings differ.

    Measured against the real catalog and the live Digi-Key list: 26 of 476
    mapped makers were discarded, 20,752 parts, 14.3% of everything mapped —
    including ALL 22 hand pins, whose entire justification is "canon correctly
    refuses to merge these two names". Those 24 live makers own 8,384 six-char
    families; each one, when scheduled, spends a call from a 1,000/day shared
    quota and can never write a row. Roughly eight days of quota structurally
    incapable of producing a listing.

    The fix is a join that was thrown away twice. Digi-Key returns
    `Manufacturer: {"Id": 296, "Name": "Texas Instruments"}` and
    `_parse_product` kept only the Name; the generator held the Name beside the
    Id and persisted only the Id. Carrying the ID through means the gate can
    ask the only question that matters — is this row from one of the makers I
    filtered on — in the distributor's own identifiers, with no spelling,
    canon, fold or regenerated data file involved.

    It also makes the rot gate STRONGER, which is why the earlier
    "trust the scope entirely" attempt was correctly reverted: a genuinely
    foreign row carries a different Id and is still refused, so
    `test_an_unknown_maker_is_declined_WITHOUT_minting_a_manufacturer_row`
    keeps passing on its own merits.
    """

    def test_a_scoped_row_is_accepted_on_its_id_however_it_is_spelled(self, db):
        maker = _maker(db, "Analog Devices / Maxim Integrated", "analog devices maxim integrated")
        db.commit()
        family = _Family(
            canonical_key="analog devices maxim integrated",
            manufacturer_id=maker.id,
            manufacturer_name=maker.name,
            prefix="ADM325",
            unlisted=5,
        )
        scope = FeedScope(keyword="ADM325", manufacturer_id="505,175", label="ADI")
        assert (
            _FamilySweep._resolve_maker(
                db, "Analog Devices Inc.", family, scope, provider_maker_id="505"
            )
            == maker.id
        ), "a row Digi-Key returned under our own id filter was refused on its spelling"

    def test_a_foreign_id_is_still_refused(self, db):
        """The rot gate, now in the distributor's own identifiers."""
        maker = _maker(db, "Texas Instruments", "texas instruments")
        db.commit()
        family = _Family(
            canonical_key="texas instruments",
            manufacturer_id=maker.id,
            manufacturer_name=maker.name,
            prefix="SN74",
            unlisted=5,
        )
        scope = FeedScope(keyword="SN74", manufacturer_id="296", label="TI")
        assert (
            _FamilySweep._resolve_maker(
                db, "Texas Instruments", family, scope, provider_maker_id="9999"
            )
            is None
        ), "a row from a maker we did not filter on was accepted on its name"

    def test_a_row_with_no_provider_id_falls_back_to_the_name_rule(self, db):
        """Mouser sends no manufacturer id, so the old rule stays reachable."""
        maker = _maker(db, "Texas Instruments", "texas instruments")
        db.commit()
        family = _Family(
            canonical_key="texas instruments",
            manufacturer_id=maker.id,
            manufacturer_name=maker.name,
            prefix="SN74",
            unlisted=5,
        )
        scope = FeedScope(keyword="SN74", manufacturer_id="296", label="TI")
        assert (
            _FamilySweep._resolve_maker(
                db, "Texas Instruments", family, scope, provider_maker_id=None
            )
            == maker.id
        )
        assert (
            _FamilySweep._resolve_maker(db, "Someone Else", family, scope, provider_maker_id=None)
            is None
        )

    def test_the_parser_keeps_the_manufacturer_id(self):
        """The join has to survive the parse or the gate has nothing to compare."""
        import json
        import pathlib

        raw = json.loads(pathlib.Path("tests/fixtures/digikey_keyword_product.json").read_text())
        fp = part_from_digikey(raw)
        assert fp is not None
        assert fp.provider_manufacturer_id == "296", (
            "Digi-Key sends Manufacturer.Id beside Manufacturer.Name and the "
            f"parser dropped it (got {fp.provider_manufacturer_id!r})"
        )


class TestCanNarrowAsksAboutChildrenNotArithmetic:
    """`can_narrow` is asked one question and answers a different one.

    `next_cursor` reads it as "does this family have somewhere narrower to
    actually go?":

        if total is not None and total > window and unit.can_narrow:
            return IMPORT_CURSOR_TOO_WIDE

    `units()` computes it as "is there room left in the level arithmetic?":
    `can_narrow=level < FAMILY_PREFIX_MAX`. Those coincide only when a longer
    prefix would in fact split the group.

    `_reemit` is the one place that knows the truth — it is called precisely
    for a too-wide family that produced no child, and hardcodes
    `can_narrow=False`. But that knowledge dies the moment the cursor stops
    being TOO_WIDE: `_reemit` fires only for families whose cursor IS the
    sentinel, so once the re-emitted unit pages once and writes a positive
    depth, the next scan rebuilds it through the ordinary path with
    `can_narrow` back to the level arithmetic, it is marked too wide again, and
    round it goes — re-reading the same first page and spending a call each
    time.

    The fact is already in the one aggregate the sweep runs: whether any SKU in
    the group is longer than the prefix is the exact complement of the child
    filter `_groups` already applies. It is a property of OUR catalog, which is
    why the level counter can never stand in for it.
    """

    def test_a_family_knows_whether_it_has_narrower_children(self):
        import dataclasses

        fields = {f.name for f in dataclasses.fields(_Family)}
        assert "has_longer" in fields, (
            "_Family carries no answer to 'is there a narrower prefix that would "
            "actually split this group', so can_narrow has to guess from the "
            "level counter"
        )

    def test_can_narrow_comes_from_the_family_not_the_level(self):
        """Structural, because the wrong answer is only visible across runs."""
        import inspect

        src = inspect.getsource(_FamilySweep.units)
        assert "can_narrow=level < FAMILY_PREFIX_MAX" not in src, (
            "can_narrow is still the level arithmetic; a family with no narrower "
            "children is re-marked TOO_WIDE on every scan and re-reads its first "
            "page forever"
        )
        assert "has_longer" in src, "units() does not consult the family's own answer"

    def test_a_group_whose_skus_all_stop_at_the_prefix_cannot_narrow(self, db):
        """The real catalog case: every part in the family has an SKU no longer
        than the prefix, so no longer prefix can ever split it."""
        maker = _maker(db, "Stubby Corp", "stubby corp")
        for sku in ("ABC123", "ABC124", "ABC125"):
            _held(db, maker, sku)
        db.commit()

        groups = _FamilySweep()._groups(db, None, 6, None)
        ours = [g for g, _p in groups if g.canonical_key == "stubby corp"]
        assert ours, "the fixture family was not enumerated at all"
        assert ours[0].has_longer is False, (
            "a family whose SKUs are exactly the prefix length reports narrower "
            "children; narrowing it returns the same group and the cursor "
            "oscillates"
        )

    def test_a_group_with_longer_skus_can_narrow(self, db):
        maker = _maker(db, "Longer Corp", "longer corp")
        for sku in ("XYZ123", "XYZ123456", "XYZ1237890"):
            _held(db, maker, sku)
        db.commit()

        groups = _FamilySweep()._groups(db, None, 6, None)
        ours = [g for g, _p in groups if g.canonical_key == "longer corp"]
        assert ours and ours[0].has_longer is True


class TestTheCursorIsNotRewrittenOnEveryPage:
    """The whole cursor map was persisted after every single page.

    `_save_import_cursor` reassigns `row.import_cursor = dict(cursor)` and
    commits, and `_sweep_run` called it once per work unit. For the category
    sweep that is 189 keys and free. The family sweep adds one key per
    (maker, prefix), growing toward 56,689 — and the map PERSISTS between runs,
    so it starts each night where the last one stopped.

    Measured against the local Postgres, cost per save by map size:

        100 keys      2.8 KB     1.03 ms
        1,000         29 KB      1.53 ms
        20,000        590 KB     9.26 ms
        56,689        1.67 MB   29.24 ms      <- 28x

    Linear per write, and the map only grows, so the run is quadratic overall:
    that is exactly "starts fast and gets slower and slower". At full size a
    1,000-page night spends ~29 s rewriting bookkeeping and roughly 1.7 GB of
    WAL doing it. `jsonb_set` would not help — Postgres rewrites the TOASTed
    value whichever way the new JSON is computed.

    Batching is safe because the WORK is already durable: `absorb` commits per
    part, so a lost flush costs only paging DEPTH, and re-reading a page costs
    one call. The flush interval is therefore a bound on wasted calls after an
    ungraceful stop, not on data loss — and the run must still flush on every
    exit path, or a clean finish would lose up to a whole interval.
    """

    def test_the_flush_interval_is_a_named_constant(self):
        from app.services.part_feed import importer

        assert hasattr(importer, "CURSOR_FLUSH_EVERY"), (
            "the cursor flush cadence is inlined; it bounds how many API calls "
            "an ungraceful stop wastes and deserves a name and a rationale"
        )
        assert importer.CURSOR_FLUSH_EVERY > 1

    def test_a_multi_unit_sweep_saves_the_cursor_fewer_times_than_it_pages(
        self, db, seeded_db, monkeypatch
    ):
        """Counts real saves across MORE units than the flush interval.

        Two earlier versions of this test were worthless and a mutation check
        caught both. The first grepped the source for CURSOR_FLUSH_EVERY — the
        constant's NAME survives in the surrounding comments, so reverting the
        batching left it green. The second counted saves but built a fixture
        producing a single page, where one save is one save either way. The
        distinguishing condition is units > CURSOR_FLUSH_EVERY, so the fixture
        has to make that many.
        """
        from app.services.part_feed import importer

        units = importer.CURSOR_FLUSH_EVERY + 5
        saves = []
        real = importer._save_import_cursor
        monkeypatch.setattr(
            importer,
            "_save_import_cursor",
            lambda db_, sid, cur: (saves.append(1), real(db_, sid, cur))[1],
        )

        # One family per maker, so each is its own work unit.
        ids = {}
        for n in range(units):
            key = f"maker{n:03d}"
            mk = _maker(db, f"Maker {n:03d}", key)
            _held(db, mk, f"MK{n:03d}AAA")
            ids[key] = 1000 + n
        db.commit()

        provider = ScopedFakeProvider(manufacturer_ids=ids, results_by_keyword={})
        list(grow_catalog(db, provider, seeded_db["supplier1"], call_budget=units))

        assert len(saves) <= 2 + units // importer.CURSOR_FLUSH_EVERY, (
            f"{len(saves)} cursor saves across {units} work units — the whole map "
            "is being rewritten per page again, which is the 28x-at-scale cost "
            "(1.03 ms at 100 keys, 29.24 ms and 1.67 MB at 56,689)"
        )
        assert saves, "the cursor was never persisted at all"

    def test_every_exit_path_flushes(self):
        """A clean finish, a quota wall and a pause must all leave the cursor
        current. Batching that only flushes mid-loop silently discards the last
        partial interval, which is worse than the slowdown it fixes."""
        import inspect

        from app.services.part_feed.importer import _sweep_run

        src = inspect.getsource(_sweep_run)
        assert "finally:" in src, (
            "there is no finally block, so a FeedFatalError or a pause returns "
            "without flushing the pages it did absorb"
        )
        tail = src[src.index("finally:") :]
        assert "_save_import_cursor" in tail or "_flush_cursor" in tail, (
            "the exit path does not persist the cursor"
        )


class TestTheNightlyBudgetIsPerProvider:
    """Quotas are not pooled, so the budget must not be either.

    `run_once` took ONE `FEED_IMPORT_CALL_BUDGET`, divided it evenly across
    every enabled supplier, and capped the whole night against that same
    number. Mouser and Digi-Key each sell their own ~1,000 calls/day, so with
    both enabled each got 425 of a shared 850 — under-using both by half while
    still letting whichever ran first starve the other. It also makes a reach
    estimate unstateable, because "how much can we price tonight" only has an
    answer per distributor.

    The registry already resolves a per-provider budget
    (`registry.call_budget(slug)`, backed by `FEED_IMPORT_CALL_BUDGETS` with
    the scalar as fallback). The night has to spend against that, per provider,
    and its running cap has to be per provider too — a global cap re-creates
    the starvation it was supposed to remove.
    """

    def test_the_budget_is_resolved_per_provider_not_from_the_scalar(self):
        import inspect

        from app.jobs import feed_import_daily

        src = inspect.getsource(feed_import_daily.run_once)
        assert "call_budget(" in src, (
            "run_once still reads settings.FEED_IMPORT_CALL_BUDGET directly; with "
            "two distributors that pools two separate quotas into one"
        )

    def test_two_providers_get_their_own_allowances(self, monkeypatch):
        from app.services.part_feed import registry

        monkeypatch.setattr(
            registry.settings,
            "FEED_IMPORT_CALL_BUDGETS",
            {"mouser": 300, "digikey": 900},
            raising=False,
        )
        assert registry.call_budget("mouser") == 300
        assert registry.call_budget("digikey") == 900


class TestTheFamilySweepRunsUnattended:
    """The two reasons to hold were removed and measured away, in that order.

    (1) Per-provider budgets now exist, so Digi-Key burning its day fast no
        longer takes Mouser's allowance with it.

    (2) The `lifecycle_status` worry — two vocabularies over one column, each
        disagreement rewriting all eight indexes — was UNMEASURED when the hold
        was written. Measured since, against both live feeds: Mouser reported
        no lifecycle at all on 12 of 12 sampled parts while Digi-Key reported
        one on 10 of them, so in practice a single feed authors the column.
        Catalog-wide only 3,181 of 175,728 parts (1.8%) have ever been
        feed-stamped, and `_stamp_feed_facts` writes only when the value
        actually changes, so a genuine disagreement costs one UPDATE per part
        per alternating run — hundreds a night, not the index storm feared.
    """

    def test_family_is_allowed_to_run_unattended(self):
        from app.jobs.feed_import_daily import NIGHTLY_STRATEGIES

        assert "family" in NIGHTLY_STRATEGIES, (
            "the overlap sweep is still interactive-only, so a supplier whose "
            "auto-import the operator switched on is skipped every night"
        )

    def test_category_still_runs_unattended_too(self):
        """Enabling family must not displace Mouser's nightly sweep."""
        from app.jobs.feed_import_daily import NIGHTLY_STRATEGIES

        assert "category" in NIGHTLY_STRATEGIES

    def test_the_nightly_run_is_still_never_continuous(self):
        """Unattended does NOT mean unbounded: `continuous` stays off at night,
        or one supplier sweeps until the quota wall and nobody else runs."""
        import inspect

        from app.jobs import feed_import_daily

        src = inspect.getsource(feed_import_daily._import_one)
        assert "continuous=True" not in src


class TestTheSweepDoesNotReAskAboutPartsItAlreadyLists:
    """`_base_query`'s NOT EXISTS is the sweep's whole subject, and had NO test.

    The family sweep exists to find a SECOND price for parts we already hold,
    so `_base_query` excludes every part this supplier already lists. A
    mutation deleting that NOT EXISTS left all 79 tests in this file green —
    the exclusion that saves the rate-limited calls was completely uncovered.

    The consequence is not subtle: a supplier whose coverage is already good
    would spend its entire daily budget re-asking about parts it lists, write
    nothing, and report a healthy-looking run. Verified against the real
    catalog — Mouser lists 130,728 of 175,728 parts, so the filter is the
    difference between sweeping 45,000 candidates and sweeping all of them.

    The neighbouring `..._ALREADY_lists_is_left_untouched` test does not cover
    this: its only part is already listed, so the family is filtered out before
    `absorb` ever runs and its assertions pass vacuously. Both halves are
    pinned here — a fully-covered family must produce NO unit and spend NO
    call, and a family with one unlisted part must still be swept.
    """

    def test_a_fully_covered_family_produces_no_unit_and_spends_no_call(self, db, seeded_db):
        supplier = seeded_db["supplier1"]
        maker = _maker(db, "Fully Covered Inc", "fully covered inc")
        for n in range(4):
            part = _held(db, maker, f"FCOV{n:03d}AAA")
            _listing(db, part, supplier)
        db.commit()

        provider = ScopedFakeProvider(
            manufacturer_ids={"fully covered inc": 4242},
            results_by_keyword={},
        )
        events = list(grow_catalog(db, provider, supplier, call_budget=5))

        assert provider.calls_made == 0, (
            f"{provider.calls_made} rate-limited call(s) spent re-asking about parts "
            "this supplier already lists — the NOT EXISTS in _base_query is gone"
        )
        assert _actions(events) == []

    def test_a_family_with_one_unlisted_part_is_still_swept(self, db, seeded_db):
        """The other direction. Without it, 'never sweeps anything' passes."""
        supplier = seeded_db["supplier1"]
        maker = _maker(db, "Mostly Covered Inc", "mostly covered inc")
        for n in range(3):
            part = _held(db, maker, f"MCOV{n:03d}AAA")
            _listing(db, part, supplier)
        _held(db, maker, "MCOV999AAA")  # the one gap
        db.commit()

        provider = ScopedFakeProvider(
            manufacturer_ids={"mostly covered inc": 4243},
            results_by_keyword={},
        )
        list(grow_catalog(db, provider, supplier, call_budget=5))

        assert provider.calls_made > 0, (
            "a family holding an unlisted part was skipped — the sweep can no "
            "longer find a second price for anything"
        )
