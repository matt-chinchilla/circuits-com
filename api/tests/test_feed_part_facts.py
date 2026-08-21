"""Lifecycle/package flow from a feed response onto Part rows.

The Mouser field name for lifecycle was UNVERIFIED in research (spec §4), so
part_from_mouser reads it DEFENSIVELY: absent key → None → nothing stamped →
the UI stays honest-unverified. A wrong guess here can never fabricate an
Active claim.
"""

from app.models import Part
from app.services.part_feed.base import FeedPart
from app.services.part_feed.importer import _stamp_feed_facts, map_lifecycle
from app.services.part_feed.mouser import part_from_mouser


def _fp(**kw) -> FeedPart:
    base = dict(
        mpn="LM317T",
        manufacturer="TI",
        description=None,
        image_url=None,
        datasheet_url=None,
        supplier_sku=None,
        stock_quantity=5,
        lead_time_days=None,
        currency="USD",
        price_breaks=[],
    )
    base.update(kw)
    return FeedPart(**base)


class TestMouserParse:
    RAW = {
        "ManufacturerPartNumber": "LM317T",
        "Manufacturer": "TI",
        "Availability": "5 In Stock",
        "PriceBreaks": [{"Price": "$0.50", "Quantity": 1, "Currency": "USD"}],
    }

    def test_absent_fields_stay_none(self):
        fp = part_from_mouser(self.RAW)
        assert fp.lifecycle is None
        assert fp.package is None

    def test_lifecycle_and_package_parse_when_present(self):
        raw = {
            **self.RAW,
            "LifecycleStatus": "Obsolete",
            "ProductAttributes": [
                {"AttributeName": "Package / Case", "AttributeValue": "TO-220-3"},
            ],
        }
        fp = part_from_mouser(raw)
        assert fp.lifecycle == "Obsolete"
        assert fp.package == "TO-220-3"


class TestLifecycleMap:
    def test_known_words_map_to_the_enum(self):
        assert map_lifecycle("Obsolete") == "obsolete"
        assert map_lifecycle("End of Life") == "obsolete"
        assert map_lifecycle("Not Recommended for New Designs") == "nrnd"
        assert map_lifecycle("NRND") == "nrnd"
        assert map_lifecycle("New Product") == "active"
        assert map_lifecycle("In Production") == "active"

    def test_unknown_or_absent_never_stamps(self):
        assert map_lifecycle(None) is None
        assert map_lifecycle("") is None
        assert map_lifecycle("Contact Factory") is None


class TestStamping:
    def test_stamps_package_and_verified_lifecycle(self, db):
        part = Part(sku="LM317T", manufacturer_name="TI")
        db.add(part)
        db.commit()
        changed = _stamp_feed_facts(part, _fp(lifecycle="Obsolete", package="TO-220-3"))
        assert changed
        assert part.package == "TO-220-3"
        assert part.lifecycle_status == "obsolete"
        assert part.lifecycle_verified_at is not None

    def test_unmappable_lifecycle_leaves_the_truth_bit_null(self, db):
        part = Part(sku="X1", manufacturer_name="TI")
        db.add(part)
        db.commit()
        changed = _stamp_feed_facts(part, _fp(mpn="X1", lifecycle="Contact Factory"))
        assert not changed
        assert part.lifecycle_verified_at is None
        assert part.lifecycle_status == "active"  # the column DEFAULT, untouched

    def test_package_is_clamped_to_column_width(self, db):
        part = Part(sku="X2", manufacturer_name="TI")
        db.add(part)
        db.commit()
        _stamp_feed_facts(part, _fp(mpn="X2", package="P" * 200))
        assert len(part.package) == 60
