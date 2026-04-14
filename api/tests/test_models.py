"""Comprehensive tests for all database models.

Tests cover:
- Model creation with all fields
- Default values
- Nullable/required fields
- Relationships and foreign keys
- Constraints (unique, check)
- Timestamps (created_at, updated_at)
"""

import uuid
from datetime import date
from decimal import Decimal

import bcrypt
import pytest

from app.models import Part, PartListing, PriceBreak, Revenue, User


# =========================================================================
# User model
# =========================================================================

class TestUserModel:
    def test_create_admin_user(self, db):
        from app.models import User

        hashed = bcrypt.hashpw("pass123".encode(), bcrypt.gensalt()).decode()
        user = User(username="admin", password_hash=hashed, role="admin")
        db.add(user)
        db.commit()

        fetched = db.query(User).filter(User.username == "admin").first()
        assert fetched is not None
        assert fetched.role == "admin"
        assert fetched.supplier_id is None
        assert bcrypt.checkpw("pass123".encode(), fetched.password_hash.encode())

    def test_create_company_user_with_supplier(self, seeded_db, db):
        user = seeded_db["company_user"]
        assert user.role == "company"
        assert user.supplier_id == seeded_db["supplier2"].id
        assert user.supplier.name == "Kennedy Electronics"

    def test_username_unique(self, db):
        from app.models import User

        hashed = bcrypt.hashpw("pass".encode(), bcrypt.gensalt()).decode()
        db.add(User(username="dupe", password_hash=hashed, role="admin"))
        db.commit()

        db.add(User(username="dupe", password_hash=hashed, role="company"))
        with pytest.raises(Exception):
            db.commit()
        db.rollback()

    def test_user_has_timestamps(self, seeded_db):
        user = seeded_db["admin_user"]
        assert user.created_at is not None
        assert user.updated_at is not None

    def test_user_requires_username(self, db):
        from app.models import User

        hashed = bcrypt.hashpw("pass".encode(), bcrypt.gensalt()).decode()
        user = User(password_hash=hashed, role="admin")
        db.add(user)
        with pytest.raises(Exception):
            db.commit()
        db.rollback()

    def test_user_requires_password_hash(self, db):
        from app.models import User

        user = User(username="nopass", role="admin")
        db.add(user)
        with pytest.raises(Exception):
            db.commit()
        db.rollback()


# =========================================================================
# Part model
# =========================================================================

class TestPartModel:
    def test_create_part(self, seeded_db, db):
        part = seeded_db["part1"]
        assert part.sku == "LM7805CT"
        assert part.manufacturer_name == "Texas Instruments"
        assert part.description == "5V 1.5A Linear Voltage Regulator"
        assert part.lifecycle_status == "active"
        assert part.category_id == seeded_db["child"].id

    def test_part_default_lifecycle(self, db):
        from app.models import Part

        part = Part(sku="TEST123", manufacturer_name="Test Corp")
        db.add(part)
        db.commit()
        assert part.lifecycle_status == "active"

    def test_part_nullable_fields(self, db):
        from app.models import Part

        part = Part(sku="BARE", manufacturer_name="Min Corp")
        db.add(part)
        db.commit()

        assert part.description is None
        assert part.category_id is None
        assert part.datasheet_url is None

    def test_part_has_timestamps(self, seeded_db):
        part = seeded_db["part1"]
        assert part.created_at is not None
        assert part.updated_at is not None

    def test_part_requires_sku(self, db):
        from app.models import Part

        part = Part(manufacturer_name="Test Corp")
        db.add(part)
        with pytest.raises(Exception):
            db.commit()
        db.rollback()

    def test_part_requires_manufacturer(self, db):
        from app.models import Part

        part = Part(sku="TEST123")
        db.add(part)
        with pytest.raises(Exception):
            db.commit()
        db.rollback()

    def test_part_category_relationship(self, seeded_db):
        part = seeded_db["part1"]
        assert part.category is not None
        assert part.category.name == "Clock and Timing"

    def test_part_listings_relationship(self, seeded_db):
        part = seeded_db["part1"]
        assert len(part.listings) == 2
        skus = {l.sku for l in part.listings}
        assert "AVN-LM7805CT" in skus
        assert "KEN-LM7805CT" in skus


# =========================================================================
# PartListing model
# =========================================================================

class TestPartListingModel:
    def test_create_listing(self, seeded_db):
        listing = seeded_db["listing1"]
        assert listing.sku == "AVN-LM7805CT"
        assert listing.stock_quantity == 15000
        assert listing.lead_time_days == 3
        assert listing.unit_price == Decimal("0.5200")
        assert listing.currency == "USD"

    def test_listing_part_relationship(self, seeded_db):
        listing = seeded_db["listing1"]
        assert listing.part.sku == "LM7805CT"

    def test_listing_supplier_relationship(self, seeded_db):
        listing = seeded_db["listing1"]
        assert listing.supplier.name == "Avnet"

    def test_listing_price_breaks(self, seeded_db):
        listing = seeded_db["listing1"]
        assert len(listing.price_breaks) == 3
        quantities = sorted([pb.min_quantity for pb in listing.price_breaks])
        assert quantities == [10, 100, 1000]

    def test_listing_requires_part(self, db):
        from app.models import PartListing, Supplier

        sup = Supplier(name="Test", id=uuid.uuid4())
        db.add(sup)
        db.flush()

        listing = PartListing(
            supplier_id=sup.id,
            unit_price=Decimal("1.00"),
        )
        db.add(listing)
        with pytest.raises(Exception):
            db.commit()
        db.rollback()

    def test_listing_requires_unit_price(self, db, seeded_db):
        from app.models import PartListing

        listing = PartListing(
            part_id=seeded_db["part1"].id,
            supplier_id=seeded_db["supplier1"].id,
        )
        db.add(listing)
        with pytest.raises(Exception):
            db.commit()
        db.rollback()

    def test_listing_has_timestamps(self, seeded_db):
        listing = seeded_db["listing1"]
        assert listing.created_at is not None
        assert listing.updated_at is not None
        assert listing.last_updated is not None


# =========================================================================
# PriceBreak model
# =========================================================================

class TestPriceBreakModel:
    def test_create_price_break(self, seeded_db, db):
        from app.models import PriceBreak

        breaks = db.query(PriceBreak).filter(
            PriceBreak.listing_id == seeded_db["listing1"].id
        ).all()
        assert len(breaks) == 3

        # Prices decrease at higher quantities
        by_qty = sorted(breaks, key=lambda pb: pb.min_quantity)
        assert by_qty[0].unit_price > by_qty[1].unit_price > by_qty[2].unit_price

    def test_price_break_requires_listing(self, db):
        from app.models import PriceBreak

        pb = PriceBreak(min_quantity=10, unit_price=Decimal("1.00"))
        db.add(pb)
        with pytest.raises(Exception):
            db.commit()
        db.rollback()


# =========================================================================
# Revenue model
# =========================================================================

class TestRevenueModel:
    def test_create_revenue(self, seeded_db):
        rev = seeded_db["revenue1"]
        assert rev.type == "sponsorship"
        assert rev.amount == Decimal("500.00")
        assert rev.period_start == date(2026, 3, 1)
        assert rev.period_end == date(2026, 3, 31)

    def test_revenue_supplier_relationship(self, seeded_db):
        rev = seeded_db["revenue1"]
        assert rev.supplier.name == "Kennedy Electronics"

    def test_revenue_requires_supplier(self, db):
        from app.models import Revenue

        rev = Revenue(
            type="sponsorship",
            amount=Decimal("100.00"),
            period_start=date(2026, 1, 1),
            period_end=date(2026, 1, 31),
        )
        db.add(rev)
        with pytest.raises(Exception):
            db.commit()
        db.rollback()

    def test_revenue_requires_amount(self, db, seeded_db):
        from app.models import Revenue

        rev = Revenue(
            supplier_id=seeded_db["supplier1"].id,
            type="listing_fee",
            period_start=date(2026, 1, 1),
            period_end=date(2026, 1, 31),
        )
        db.add(rev)
        with pytest.raises(Exception):
            db.commit()
        db.rollback()

    def test_revenue_has_timestamp(self, seeded_db):
        rev = seeded_db["revenue1"]
        assert rev.created_at is not None


# =========================================================================
# Existing model timestamp additions
# =========================================================================

class TestTimestamps:
    def test_supplier_has_timestamps(self, seeded_db):
        sup = seeded_db["supplier1"]
        assert sup.created_at is not None
        assert sup.updated_at is not None

    def test_supplier_contact_name_persists(self, db):
        from app.models import Supplier

        sup = Supplier(
            id=uuid.uuid4(),
            name="ContactTest Corp",
            contact_name="Jane Doe",
        )
        db.add(sup)
        db.commit()

        fetched = db.query(Supplier).filter(Supplier.id == sup.id).first()
        assert fetched.contact_name == "Jane Doe"

    def test_supplier_contact_name_is_optional(self, db):
        from app.models import Supplier

        sup = Supplier(id=uuid.uuid4(), name="No Contact Corp")
        db.add(sup)
        db.commit()

        fetched = db.query(Supplier).filter(Supplier.id == sup.id).first()
        assert fetched.contact_name is None

    def test_category_has_timestamps(self, seeded_db):
        cat = seeded_db["parent"]
        assert cat.created_at is not None
        assert cat.updated_at is not None

    def test_sponsor_has_timestamps(self, seeded_db):
        sponsor = seeded_db["sponsor"]
        assert sponsor.created_at is not None
        assert sponsor.updated_at is not None

    def test_sponsor_has_date_range(self, db):
        from app.models import Sponsor, Supplier, Category

        sup = Supplier(name="DateTest", id=uuid.uuid4())
        cat = Category(name="DateTest", slug="datetest", id=uuid.uuid4())
        db.add_all([sup, cat])
        db.flush()

        sponsor = Sponsor(
            supplier_id=sup.id,
            category_id=cat.id,
            start_date=date(2026, 1, 1),
            end_date=date(2026, 12, 31),
        )
        db.add(sponsor)
        db.commit()

        assert sponsor.start_date == date(2026, 1, 1)
        assert sponsor.end_date == date(2026, 12, 31)


# =========================================================================
# Seed idempotency
# =========================================================================

class TestSeedIdempotency:
    def test_seed_runs_twice_without_error(self, db):
        from app.db.seed import seed

        seed(db)
        count_after_first = db.query(Part).count()

        seed(db)
        count_after_second = db.query(Part).count()

        assert count_after_first == count_after_second
        assert count_after_first > 0

    def test_seed_creates_admin_users(self, db):
        from app.db.seed import seed

        seed(db)
        for username in ("matthew", "mike", "john"):
            user = db.query(User).filter(User.username == username).first()
            assert user is not None
            assert user.role == "admin"
            assert bcrypt.checkpw("admin".encode(), user.password_hash.encode())

    def test_seed_creates_parts(self, db):
        from app.db.seed import seed

        seed(db)
        parts = db.query(Part).all()
        assert len(parts) == 59  # 10 categories, variable parts per category

    def test_seed_creates_listings(self, db):
        from app.db.seed import seed

        seed(db)
        listings = db.query(PartListing).all()
        assert len(listings) > 0
        # Each part has 2-4 listings
        for part in db.query(Part).all():
            assert len(part.listings) >= 2

    def test_seed_creates_revenue(self, db):
        from app.db.seed import seed

        seed(db)
        revenue = db.query(Revenue).all()
        assert len(revenue) > 0

    def test_seed_creates_price_breaks(self, db):
        from app.db.seed import seed

        seed(db)
        breaks = db.query(PriceBreak).all()
        assert len(breaks) > 0
