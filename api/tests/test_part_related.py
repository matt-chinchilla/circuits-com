"""GET /api/parts/{id}/related + Part.image_url.

The related endpoint powers the part page's "Alternates" and "Often paired
with" rows from taxonomy proximity alone (same subcategory / sibling
subcategories) — no hand-maintained pairing map. image_url is the slot the
future distributor-API sync fills; the write boundary must reject hostile
schemes exactly like supplier logos do.
"""

import uuid
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.models import Category, Part, PartListing
from app.routes.parts import PartCreate, PartUpdate, part_to_dict


def _add_part(db, sku, category_id, manufacturer="Acme Semi"):
    part = Part(
        id=uuid.uuid4(),
        sku=sku,
        slug=sku.lower(),
        manufacturer_name=manufacturer,
        category_id=category_id,
    )
    db.add(part)
    db.flush()
    return part


class TestRelatedParts:
    def test_404_on_unknown_part(self, client, seeded_db):
        resp = client.get(f"/api/parts/{uuid.uuid4()}/related")
        assert resp.status_code == 404

    def test_404_on_invalid_uuid(self, client, seeded_db):
        resp = client.get("/api/parts/not-a-uuid/related")
        assert resp.status_code == 404

    def test_alternates_same_category_exclude_self(self, client, db, seeded_db):
        child = seeded_db["child"]
        part = seeded_db["part1"]
        alt1 = _add_part(db, "ALT-0001", child.id, manufacturer="Other Corp")
        alt2 = _add_part(db, "ALT-0002", child.id, manufacturer=part.manufacturer_name)
        db.commit()

        resp = client.get(f"/api/parts/{part.id}/related")
        assert resp.status_code == 200
        data = resp.json()
        ids = [a["id"] for a in data["alternates"]]
        assert str(part.id) not in ids
        assert str(alt1.id) in ids and str(alt2.id) in ids
        # different manufacturer sorts ahead of the same manufacturer
        assert ids.index(str(alt1.id)) < ids.index(str(alt2.id))

    def test_companions_come_from_sibling_subcategories(self, client, db, seeded_db):
        parent = seeded_db["parent"]
        part = seeded_db["part1"]
        sibling = Category(
            id=uuid.uuid4(),
            name="Interface ICs",
            slug="interface-ics",
            icon="🔌",
            parent_id=parent.id,
            sort_order=1,
        )
        db.add(sibling)
        db.flush()
        companion = _add_part(db, "COMP-0001", sibling.id)
        db.commit()

        resp = client.get(f"/api/parts/{part.id}/related")
        assert resp.status_code == 200
        comp_ids = [c["id"] for c in resp.json()["companions"]]
        assert comp_ids == [str(companion.id)]

    def test_uncategorized_part_returns_empty_lists(self, client, db, seeded_db):
        loner = _add_part(db, "LONER-01", None)
        db.commit()
        resp = client.get(f"/api/parts/{loner.id}/related")
        assert resp.status_code == 200
        assert resp.json() == {"alternates": [], "companions": []}

    def test_unpriced_alternates_sort_after_priced_ones(self, client, db, seeded_db):
        """A part with no listings (best_price None) must not beat a
        close-priced alternate — the falsy-zero trap the review caught."""
        child = seeded_db["child"]
        part = seeded_db["part1"]  # priced at 0.52 via listing1
        unpriced = _add_part(db, "AAA-UNPRICED", child.id, manufacturer="Other Corp")
        priced = _add_part(db, "ZZZ-PRICED", child.id, manufacturer="Other Corp")
        db.add(PartListing(
            id=uuid.uuid4(), part_id=priced.id,
            supplier_id=seeded_db["supplier1"].id,
            stock_quantity=10, unit_price=Decimal("0.55"),
        ))
        db.commit()

        ids = [a["id"] for a in client.get(f"/api/parts/{part.id}/related").json()["alternates"]]
        # despite AAA sorting first alphabetically, the priced part wins
        assert ids.index(str(priced.id)) < ids.index(str(unpriced.id))

    def test_related_payload_carries_category_fields(self, client, db, seeded_db):
        """serialize() stamps category fields without per-part db lookups —
        the payload must still carry them for the cards' category context."""
        child = seeded_db["child"]
        part = seeded_db["part1"]
        _add_part(db, "ALT-CAT-1", child.id, manufacturer="Other Corp")
        db.commit()

        alt = client.get(f"/api/parts/{part.id}/related").json()["alternates"][0]
        assert alt["category_name"] == "Clock and Timing"
        assert alt["parent_category_name"] == "Integrated Circuits"


class TestPartImageUrl:
    def test_part_to_dict_exposes_image_url(self, db, seeded_db):
        part = seeded_db["part1"]
        part.image_url = "https://cdn.example.com/photo.jpg"
        db.flush()
        assert part_to_dict(part, db)["image_url"] == "https://cdn.example.com/photo.jpg"

    def test_create_schema_rejects_hostile_image_url(self):
        with pytest.raises(ValidationError):
            PartCreate(sku="X1", manufacturer_name="M", image_url="javascript:alert(1)")

    def test_update_schema_rejects_svg_data_url(self):
        with pytest.raises(ValidationError):
            PartUpdate(image_url="data:image/svg+xml;base64,PHN2Zz4=")

    def test_create_schema_accepts_https_image_url(self):
        body = PartCreate(sku="X2", manufacturer_name="M", image_url="https://x.example/p.png")
        assert body.image_url == "https://x.example/p.png"

    def test_column_length_contract(self):
        # SQLite ignores String(N) — assert on metadata per the house rule.
        assert Part.__table__.c.image_url.type.length >= 500

    def test_datasheet_url_rejects_executable_schemes(self):
        with pytest.raises(ValidationError):
            PartCreate(sku="X3", manufacturer_name="M", datasheet_url="javascript:alert(1)")
        with pytest.raises(ValidationError):
            PartUpdate(datasheet_url="data:text/html,<script>1</script>")

    def test_datasheet_url_accepts_http_and_schemeless(self):
        assert PartCreate(
            sku="X4", manufacturer_name="M", datasheet_url="https://x.example/d.pdf",
        ).datasheet_url == "https://x.example/d.pdf"
        # schemeless passes — the admin form prepends https client-side
        assert PartCreate(
            sku="X5", manufacturer_name="M", datasheet_url="acme.com/d.pdf",
        ).datasheet_url == "acme.com/d.pdf"
