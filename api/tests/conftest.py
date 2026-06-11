import os
import uuid
from datetime import date
from decimal import Decimal

# Set DATABASE_URL before any app imports so pydantic-settings doesn't fail
os.environ.setdefault("DATABASE_URL", "sqlite:///./test.db")

import bcrypt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# In-memory SQLite with a FRESH CONNECTION PER TEST (see the `db` fixture's
# engine.dispose()). StaticPool keeps one connection alive — and an anonymous
# in-memory DB lives only as long as its connection — so disposing the engine
# before/after each test gives every test a brand-new connection (= brand-new
# in-memory DB), i.e. clean per-test DATA ISOLATION. (The original file-based
# "sqlite:///./test.db" with a multi-connection pool was worse still.)
SQLALCHEMY_DATABASE_URL = "sqlite://"
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)


# `postgresql.UUID` renders as the bare type name "UUID" under SQLite, which
# SQLite assigns NUMERIC affinity. ~1e-6 of uuid4 hex strings are also valid
# float literals (e.g. "…e22" / a large exponent), so SQLite silently coerces
# them to a float/inf on INSERT and then crashes uuid.UUID(hex=<float>) on read
# with "'float' object has no attribute 'replace'". The seed mints ~420k uuids
# per idempotency run → this hit ~34% of full-suite runs (a value-driven flake
# long misread as order-dependent — the per-test dispose above is for data
# isolation and never fixed it). Forcing CHAR(32) gives TEXT affinity, so UUIDs
# are stored verbatim. SQLite-test-only; prod is PostgreSQL (native uuid).
# Guarded by tests/test_uuid_sqlite_affinity.py.
@compiles(UUID, "sqlite")
def _compile_uuid_as_char_on_sqlite(element, compiler, **kw):
    return "CHAR(32)"


# SQLite doesn't enforce CHECK constraints by default; enable for parity
@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Import app-level objects AFTER env var is set
from app.db.session import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (  # noqa: E402
    Category,
    CategorySupplier,
    Part,
    PartListing,
    PriceBreak,
    Revenue,
    Sponsor,
    Supplier,
    User,
)


@pytest.fixture(scope="function")
def db():
    # Dispose first so this test gets a brand-new connection (= brand-new
    # in-memory DB), never the previous test's — see the engine comment above.
    engine.dispose()
    Base.metadata.create_all(bind=engine)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture(scope="function")
def client(db):
    def override_get_db():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def seeded_db(db):
    """Seed minimal test data with all model types."""
    # Create parent category
    parent = Category(
        id=uuid.uuid4(),
        name="Integrated Circuits",
        slug="integrated-circuits",
        icon="⚡",
        sort_order=0,
    )
    db.add(parent)
    db.flush()

    # Create child category
    child = Category(
        id=uuid.uuid4(),
        name="Clock and Timing",
        slug="clock-and-timing",
        icon="⏰",
        parent_id=parent.id,
        sort_order=0,
    )
    db.add(child)
    db.flush()

    # Create suppliers
    # Board fields (migration 014) set on both suppliers so the tier-board
    # read-path tests can assert non-null contact_role/coverage_hours/brand_*.
    supplier1 = Supplier(
        id=uuid.uuid4(),
        name="Avnet",
        phone="480-643-2000",
        website="avnet.com",
        email="info@avnet.com",
        contact_name="Jordan Avery",
        contact_role="Sr. Field Sales Engineer",
        coverage_hours="Mon-Fri 8a-6p CT",
        brand_primary="#c00000",
        brand_secondary="#ff9e85",
    )
    supplier2 = Supplier(
        id=uuid.uuid4(),
        name="Kennedy Electronics",
        phone="631-555-5555",
        website="kennedy.com",
        email="info@kennedy.com",
        contact_name="Casey Kennedy",
        contact_role="Distribution Account Manager",
        coverage_hours="Mon-Fri 9a-5p ET",
        brand_primary="#0a4a2e",
        brand_secondary="#44bd13",
    )
    db.add_all([supplier1, supplier2])
    db.flush()

    # Link suppliers to child category — pure association now (featured/sponsored
    # status lives in the `sponsors` table). The Kennedy sponsor below (Gold on
    # this child = the single Subcategory Sponsor slot) is what surfaces on the
    # SponsorBlock (2026-06-11 tier-boards matrix).
    cs1 = CategorySupplier(category_id=child.id, supplier_id=supplier1.id)
    cs2 = CategorySupplier(category_id=child.id, supplier_id=supplier2.id)
    db.add_all([cs1, cs2])
    db.flush()

    # Create the child's Gold sponsor (single Subcategory Sponsor slot).
    sponsor = Sponsor(
        id=uuid.uuid4(),
        supplier_id=supplier2.id,
        category_id=child.id,
        image_url="/test.jpg",
        description="Test sponsor",
        tier="gold",
    )
    db.add(sponsor)
    db.flush()

    # Create admin user
    hashed = bcrypt.hashpw(b"testpass123", bcrypt.gensalt()).decode()
    admin_user = User(
        id=uuid.uuid4(),
        username="admin",
        password_hash=hashed,
        role="admin",
    )
    db.add(admin_user)
    db.flush()

    # Create a company user linked to supplier
    company_user = User(
        id=uuid.uuid4(),
        username="kennedy_user",
        password_hash=hashed,
        role="company",
        supplier_id=supplier2.id,
    )
    db.add(company_user)
    db.flush()

    # Create parts
    part1 = Part(
        id=uuid.uuid4(),
        sku="LM7805CT",
        description="5V 1.5A Linear Voltage Regulator",
        manufacturer_name="Texas Instruments",
        category_id=child.id,
        lifecycle_status="active",
    )
    part2 = Part(
        id=uuid.uuid4(),
        sku="STM32F407VGT6",
        description="ARM Cortex-M4 168MHz MCU",
        manufacturer_name="STMicroelectronics",
        category_id=child.id,
        lifecycle_status="active",
    )
    db.add_all([part1, part2])
    db.flush()

    # Create part listings
    listing1 = PartListing(
        id=uuid.uuid4(),
        part_id=part1.id,
        supplier_id=supplier1.id,
        sku="AVN-LM7805CT",
        stock_quantity=15000,
        lead_time_days=3,
        unit_price=Decimal("0.5200"),
    )
    listing2 = PartListing(
        id=uuid.uuid4(),
        part_id=part1.id,
        supplier_id=supplier2.id,
        sku="KEN-LM7805CT",
        stock_quantity=8000,
        lead_time_days=7,
        unit_price=Decimal("0.4800"),
    )
    db.add_all([listing1, listing2])
    db.flush()

    # Create price breaks
    for qty, price in [(10, "0.4940"), (100, "0.4420"), (1000, "0.3640")]:
        db.add(
            PriceBreak(
                id=uuid.uuid4(),
                listing_id=listing1.id,
                min_quantity=qty,
                unit_price=Decimal(price),
            )
        )
    db.flush()

    # Create revenue records
    rev1 = Revenue(
        id=uuid.uuid4(),
        supplier_id=supplier2.id,
        type="sponsorship",
        amount=Decimal("500.00"),
        description="Monthly sponsorship",
        period_start=date(2026, 3, 1),
        period_end=date(2026, 3, 31),
    )
    rev2 = Revenue(
        id=uuid.uuid4(),
        supplier_id=supplier1.id,
        type="listing_fee",
        amount=Decimal("100.00"),
        description="Listing fee",
        period_start=date(2026, 3, 1),
        period_end=date(2026, 3, 31),
    )
    db.add_all([rev1, rev2])
    db.commit()

    return {
        "parent": parent,
        "child": child,
        "supplier1": supplier1,
        "supplier2": supplier2,
        "sponsor": sponsor,
        "admin_user": admin_user,
        "company_user": company_user,
        "part1": part1,
        "part2": part2,
        "listing1": listing1,
        "listing2": listing2,
        "revenue1": rev1,
        "revenue2": rev2,
    }


@pytest.fixture
def tier_boards(db, seeded_db):
    """Opt-in tier-boards data (2026-06-11): a fresh top-level category with a
    single **Platinum** Category Sponsor, and a fresh subcategory with a
    multi-occupant **Silver** directory (two coexisting sponsors).

    Kept SEPARATE from ``seeded_db``'s parent/child so the many exact-count and
    exact-sponsor-set assertions over the base fixture stay green; Phase 2's
    read-path tests (Platinum board + Silver directory) request this explicitly.
    Reuses ``seeded_db``'s suppliers as the sponsor companies.
    """
    parent2 = Category(id=uuid.uuid4(), name="Sensors", slug="sensors", icon="gauge", sort_order=99)
    db.add(parent2)
    db.flush()
    child2 = Category(
        id=uuid.uuid4(),
        name="Temperature Sensors",
        slug="temperature-sensors",
        icon="thermometer",
        parent_id=parent2.id,
        sort_order=0,
    )
    db.add(child2)
    db.flush()

    platinum_sponsor = Sponsor(
        id=uuid.uuid4(),
        supplier_id=seeded_db["supplier1"].id,
        category_id=parent2.id,
        description="Platinum category sponsor",
        tier="Platinum",
        status="Active",
    )
    silver_sponsor1 = Sponsor(
        id=uuid.uuid4(),
        supplier_id=seeded_db["supplier1"].id,
        category_id=child2.id,
        description="Silver directory sponsor",
        tier="Silver",
        status="Active",
    )
    silver_sponsor2 = Sponsor(
        id=uuid.uuid4(),
        supplier_id=seeded_db["supplier2"].id,
        category_id=child2.id,
        description="Silver directory sponsor",
        tier="Silver",
        status="Active",
    )
    db.add_all([platinum_sponsor, silver_sponsor1, silver_sponsor2])
    db.commit()

    return {
        "parent2": parent2,
        "child2": child2,
        "platinum_sponsor": platinum_sponsor,
        "silver_sponsor1": silver_sponsor1,
        "silver_sponsor2": silver_sponsor2,
    }
