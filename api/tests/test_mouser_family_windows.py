"""Mouser sweeps FAMILY windows, unscoped — the 8.4M-part unlock (2026-08-30).

Mouser's category-keyword sweep exhausted its reachable slice: measured live,
105 calls scanned 4,949 rows and found 25 new parts, because the 99 category
keywords can only ever surface ~130k of Mouser's 8.4M-part catalog and the
wrap was re-mining known pages. MPN-prefix family windows derived from our own
catalog open fresh pages anywhere in the space.

Mouser's API has no manufacturer filter, so its FeedScope is UNSCOPED by
construction — `search_scoped` takes its documented bare-keyword path and
`_resolve_maker` name-verifies every row against the family's maker. That is
not the FeedScopeUnsupported sin (dropping a REQUESTED filter): no filter is
ever requested, and nobody else's rows can land a price.

The prefix gate guards CREATION on fuzzy pages: keyword search matches
descriptions too, and a same-maker row that merely mentions the family must
not be filed under the family's category. Mutation-proven: dropping the
`startswith(family.prefix)` gate reddens the fuzzy-row test.
"""


from app.models import Category, Part
from app.services.part_feed.importer import FeedScope, grow_catalog
from app.services.part_feed.mouser import MouserProvider
from tests.feed_helpers import FakeProvider
from tests.feed_helpers import feed_part as _feed_part
from tests.test_overlap_sweep import _held, _maker


class UnscopedFamilyFake(FakeProvider):
    """Mouser's family contract: strategy + unscoped scope, NO search_scoped —
    the importer's `search_scoped` helper must take the bare-keyword path."""

    import_strategy = "family"

    def manufacturer_scope(self, canonical_key: str, keyword: str):
        return FeedScope(keyword=keyword, label=keyword)


class TestTheRealProviderDeclaresTheContract:
    def test_mouser_names_the_family_strategy(self):
        assert MouserProvider.import_strategy == "family"

    def test_mousers_scope_is_unscoped_on_purpose(self):
        scope = MouserProvider.manufacturer_scope("texas instruments", "SN74LV")
        assert scope.keyword == "SN74LV"
        assert scope.manufacturer_id is None


class TestUnscopedFamilyWindows:
    def _family(self, db, category=None):
        maker = _maker(db, "Texas Instruments", "texas instruments")
        _held(db, maker, "SN74LV1T08DBVR", category=category)
        _held(db, maker, "SN74LV2T45DCU", category=category)
        db.commit()
        return maker

    def _child(self, db):
        return db.query(Category).filter(Category.parent_id.isnot(None)).first()

    def test_an_unheld_sibling_is_created_through_the_bare_keyword_path(self, db, seeded_db):
        child = self._child(db)
        self._family(db, category=child)
        provider = UnscopedFamilyFake(
            results_by_keyword={
                "SN74LV": [_feed_part("SN74LV595APW", manufacturer="Texas Instruments")]
            }
        )

        events = list(grow_catalog(db, provider, seeded_db["supplier1"], call_budget=2))

        created = db.query(Part).filter(Part.sku == "SN74LV595APW").one()
        assert created.category_id == child.id
        assert events[-1]["counts"]["created"] == 1
        # The query that went out was the bare prefix — provider.search saw it.
        assert provider.search_calls and provider.search_calls[0][0] == "SN74LV"

    def test_someone_elses_row_on_the_shared_page_is_never_priced(self, db, seeded_db):
        """Unscoped pages carry other makers' rows; name-verification is what
        keeps their prices out. off_scope is the only trace they leave."""
        child = self._child(db)
        self._family(db, category=child)
        provider = UnscopedFamilyFake(
            results_by_keyword={"SN74LV": [_feed_part("SN74LVXYZ", manufacturer="Nexperia")]}
        )

        events = list(grow_catalog(db, provider, seeded_db["supplier1"], call_budget=2))

        assert db.query(Part).filter(Part.sku == "SN74LVXYZ").count() == 0
        assert events[-1]["counts"]["created"] == 0

    def test_a_fuzzy_same_maker_row_is_not_filed_under_the_family(self, db, seeded_db):
        """Keyword search matches descriptions too. A TI row whose MPN does not
        START with the prefix is not a sibling — creating it under the family's
        category would be a quiet mis-shelving."""
        child = self._child(db)
        self._family(db, category=child)
        provider = UnscopedFamilyFake(
            results_by_keyword={
                "SN74LV": [_feed_part("CD4011BE", manufacturer="Texas Instruments")]
            }
        )

        list(grow_catalog(db, provider, seeded_db["supplier1"], call_budget=2))

        assert db.query(Part).filter(Part.sku == "CD4011BE").count() == 0
