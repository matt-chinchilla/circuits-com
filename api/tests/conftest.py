import os
import uuid

# Set DATABASE_URL before any app imports so pydantic-settings doesn't fail
os.environ.setdefault("DATABASE_URL", "sqlite:///./test.db")

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
from app.models import Category, Supplier, CategorySupplier, Sponsor  # noqa: E402


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
    """Seed minimal test data."""
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
    db.add(
        CategorySupplier(
            category_id=child.id,
            supplier_id=supplier1.id,
            is_featured=False,
            rank=1,
        )
    )
    db.add(
        CategorySupplier(
            category_id=child.id,
            supplier_id=supplier2.id,
            is_featured=True,
            rank=0,
        )
    )
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
    db.commit()

    return {
        "parent": parent,
        "child": child,
        "supplier1": supplier1,
        "supplier2": supplier2,
        "sponsor": sponsor,
    }
