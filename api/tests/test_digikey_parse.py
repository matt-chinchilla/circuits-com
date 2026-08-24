"""Turning a DigiKey v4 keyword-search product into a FeedPart.

Every assertion here runs against `tests/fixtures/digikey_keyword_product.json`,
which is a REAL product captured from a live `POST /products/v4/search/keyword`
call, not a shape invented from documentation. That matters: three of the
fields below are shaped differently from Mouser's and would each have been
guessed wrong.

  * `Description` is an OBJECT ({ProductDescription, DetailedDescription}),
    where Mouser sends a bare string.
  * `ManufacturerLeadWeeks` is a STRING and counts WEEKS, where the column and
    every other feed count days.
  * A product carries several `ProductVariations` — here Tape & Reel (MOQ
    3000), Cut Tape (MOQ 1) and Digi-Reel (MOQ 1, plus a reeling fee) — each
    with its own price ladder. We store ONE listing per (part, supplier), so
    which variation is read IS the price the site publishes.
"""

import json
import pathlib

from app.services.part_feed.digikey import choose_variation, part_from_digikey

RAW = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "digikey_keyword_product.json").read_text()
)


class TestVariationChoice:
    """Which offer a buyer is shown. The most consequential decision here."""

    def test_the_lowest_minimum_order_quantity_wins(self):
        """Tape & Reel is MOQ 3000. Publishing its price as 'the' price would
        quote a reel to someone buying one part."""
        chosen = choose_variation(RAW["ProductVariations"])
        assert chosen["MinimumOrderQuantity"] == 1

    def test_a_reeling_fee_loses_to_an_equivalent_offer(self):
        """Cut Tape and Digi-Reel are both MOQ 1; Digi-Reel adds a DigiReelFee.
        The honest cheapest is the one without it."""
        chosen = choose_variation(RAW["ProductVariations"])
        assert chosen["DigiKeyProductNumber"] == "296-11602-1-ND"
        assert not chosen.get("DigiReelFee")

    def test_a_marketplace_variation_is_never_chosen(self):
        """Third-party sellers are a different business with different prices.
        The request filters them out; this is the belt to that braces."""
        only_marketplace = [
            {**RAW["ProductVariations"][1], "MarketPlace": True, "DigiKeyProductNumber": "MP-1"}
        ]
        assert choose_variation(only_marketplace) is None

    def test_no_priceable_variation_yields_nothing(self):
        assert choose_variation([]) is None
        assert choose_variation([{"DigiKeyProductNumber": "X", "StandardPricing": []}]) is None


class TestFieldMapping:
    def test_identity_fields(self):
        fp = part_from_digikey(RAW)
        assert fp is not None
        assert fp.mpn == "SN74LVC1G08DCKR"
        assert fp.manufacturer == "Texas Instruments"

    def test_description_is_flattened_from_the_object(self):
        """Mouser sends a string here; DigiKey sends {ProductDescription, ...}."""
        assert part_from_digikey(RAW).description == "IC AND 1-CIR 2-IN SC-70-5"

    def test_supplier_sku_is_the_chosen_variations_digikey_number(self):
        assert part_from_digikey(RAW).supplier_sku == "296-11602-1-ND"

    def test_price_breaks_come_from_the_chosen_variation(self):
        fp = part_from_digikey(RAW)
        assert len(fp.price_breaks) == 7
        assert fp.price_breaks[0].min_quantity == 1
        assert fp.price_breaks[0].unit_price > 0
        # Ascending by quantity, so `min(...)` in _upsert_listing is the qty-1 price.
        quantities = [b.min_quantity for b in fp.price_breaks]
        assert quantities == sorted(quantities)

    def test_lead_weeks_become_days(self):
        """'16' weeks -> 112 days. A string, and the wrong unit, both ways to
        get this silently wrong."""
        assert part_from_digikey(RAW).lead_time_days == 112

    def test_stock_and_currency(self):
        fp = part_from_digikey(RAW)
        assert fp.stock_quantity > 0
        assert fp.currency == "USD"

    def test_media_urls(self):
        fp = part_from_digikey(RAW)
        assert fp.image_url.startswith("https://")
        assert fp.datasheet_url.startswith("https://")

    def test_spec_facts_the_catalog_has_never_had(self):
        """package/mount/lifecycle are 0-of-175,087 populated today, because
        Mouser's payload never carried them. This is the whole bonus."""
        fp = part_from_digikey(RAW)
        assert fp.package == "5-TSSOP, SC-70-5, SOT-353"
        assert fp.mount == "SMT"
        assert fp.lifecycle == "Active"
        assert fp.rohs is True


class TestRefusals:
    def test_a_product_with_no_mpn_is_dropped(self):
        assert part_from_digikey({**RAW, "ManufacturerProductNumber": ""}) is None

    def test_a_product_with_no_manufacturer_is_dropped(self):
        """part_identity raises on an unkeyable maker; drop it at the parser
        instead of letting it reach the importer."""
        assert part_from_digikey({**RAW, "Manufacturer": {}}) is None

    def test_a_product_with_no_priceable_variation_still_parses(self):
        """No price is not no part: the row is still worth creating, and the
        importer records it without a listing (the same rule Mouser gets)."""
        fp = part_from_digikey({**RAW, "ProductVariations": []})
        assert fp is not None
        assert fp.mpn == "SN74LVC1G08DCKR"
        assert fp.price_breaks == []

    def test_a_missing_lead_time_is_none_not_zero(self):
        """None means 'the feed said nothing'. Zero would mean 'in stock now'."""
        assert part_from_digikey({**RAW, "ManufacturerLeadWeeks": None}).lead_time_days is None
        assert part_from_digikey({**RAW, "ManufacturerLeadWeeks": ""}).lead_time_days is None
        assert part_from_digikey({**RAW, "ManufacturerLeadWeeks": "n/a"}).lead_time_days is None
