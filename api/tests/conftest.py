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
from sqlalchemy.orm import sessionmaker

SQLALCHEMY_DATABASE_URL = "sqlite:///./test.db"
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
)


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
    Base.metadata.create_all(bind=engine)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


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
    supplier1 = Supplier(
        id=uuid.uuid4(),
        name="Avnet",
        phone="480-643-2000",
        website="avnet.com",
        email="info@avnet.com",
    )
    supplier2 = Supplier(
        id=uuid.uuid4(),
        name="Kennedy Electronics",
        phone="631-555-5555",
        website="kennedy.com",
        email="info@kennedy.com",
    )
    db.add_all([supplier1, supplier2])
    db.flush()

    # Link suppliers to child category
    cs1 = CategorySupplier(
        category_id=child.id,
        supplier_id=supplier1.id,
        is_featured=False,
        rank=1,
    )
    cs2 = CategorySupplier(
        category_id=child.id,
        supplier_id=supplier2.id,
        is_featured=True,
        rank=0,
    )
    db.add_all([cs1, cs2])
    db.flush()

    # Create sponsor
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
    hashed = bcrypt.hashpw("testpass123".encode(), bcrypt.gensalt()).decode()
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
        db.add(PriceBreak(
            id=uuid.uuid4(),
            listing_id=listing1.id,
            min_quantity=qty,
            unit_price=Decimal(price),
        ))
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
