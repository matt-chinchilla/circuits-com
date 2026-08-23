"""Lifecycle/package flow from a feed response onto Part rows.

The Mouser field name for lifecycle was UNVERIFIED in research (spec §4), so
part_from_mouser reads it DEFENSIVELY: absent key → None → nothing stamped →
the UI stays honest-unverified. A wrong guess here can never fabricate an
Active claim.
"""

from app.models import Part
from app.services.part_feed.base import FeedPart
from app.services.part_feed.importer import _stamp_feed_facts
from app.services.part_feed.mouser import part_from_mouser
from app.services.part_feed.specmap import map_lifecycle


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


class TestUnchangedRowsAreNotRewritten:
    """A feed that confirms what we already knew must not dirty the row.

    `lifecycle_verified_at` used to be stamped on EVERY pass that produced a
    mappable lifecycle, outside the `!=` guard that protects every other field,
    and `changed` was set unconditionally alongside it. Because Mouser returns
    a lifecycle for essentially every part, that made a re-sync rewrite every
    row it touched even when nothing about the part had changed: measured at
    139,056 UPDATEs per import, only 2.8% of them HOT, so ~97% also rewrote all
    eight of the table's indexes — roughly 3 GB of WAL for a no-op pass.

    Safe to fix because no consumer reads the timestamp's VALUE: bom_match
    reports `lifecycle_verified_at is not None` and uses it only as a
    nulls-last tie-break. The column now means "when a feed established the
    lifecycle this row currently claims", which is the more useful reading.
    """

    def test_a_second_identical_pass_reports_no_change(self, db):
        part = Part(sku="RESYNC-1", manufacturer_name="TI")
        db.add(part)
        db.commit()
        feed = _fp(mpn="RESYNC-1", lifecycle="Active", package="SOT-23")

        assert _stamp_feed_facts(part, feed) is True, "first pass must stamp"
        assert _stamp_feed_facts(part, feed) is False, (
            "an identical second pass rewrote the row — this is the ~3 GB/import "
            "WAL bug; lifecycle_verified_at must sit inside a guard"
        )

    def test_a_second_identical_pass_leaves_the_timestamp_alone(self, db):
        part = Part(sku="RESYNC-2", manufacturer_name="TI")
        db.add(part)
        db.commit()
        feed = _fp(mpn="RESYNC-2", lifecycle="Active")

        _stamp_feed_facts(part, feed)
        first = part.lifecycle_verified_at
        _stamp_feed_facts(part, feed)
        assert part.lifecycle_verified_at == first

    def test_a_genuine_lifecycle_change_refreshes_the_timestamp(self, db):
        """The column must track the value it vouches for, not first contact."""
        part = Part(sku="RESYNC-3", manufacturer_name="TI")
        db.add(part)
        db.commit()

        _stamp_feed_facts(part, _fp(mpn="RESYNC-3", lifecycle="Active"))
        first = part.lifecycle_verified_at

        changed = _stamp_feed_facts(part, _fp(mpn="RESYNC-3", lifecycle="Obsolete"))
        assert changed is True
        assert part.lifecycle_status == "obsolete"
        assert part.lifecycle_verified_at > first

    def test_an_already_verified_row_still_reports_other_field_changes(self, db):
        """Guarding the timestamp must not swallow a real package change."""
        part = Part(sku="RESYNC-4", manufacturer_name="TI")
        db.add(part)
        db.commit()

        _stamp_feed_facts(part, _fp(mpn="RESYNC-4", lifecycle="Active", package="SOT-23"))
        changed = _stamp_feed_facts(
            part, _fp(mpn="RESYNC-4", lifecycle="Active", package="SOT-223")
        )
        assert changed is True
        assert part.package == "SOT-223"
