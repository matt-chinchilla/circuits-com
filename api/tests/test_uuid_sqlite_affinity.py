"""Regression guard: SQLite must store UUID columns with TEXT affinity.

`postgresql.UUID` renders as the bare type name ``UUID`` under SQLite, which
SQLite assigns NUMERIC affinity. A uuid4 hex string that happens to be a valid
float literal (e.g. ``…e22`` / a large exponent) is then silently coerced to a
float on INSERT, and the UUID result processor crashes with
``'float' object has no attribute 'replace'`` on read. With ~420k uuids minted
per seed-idempotency run this hit ~34% of full-suite runs — an intermittent
flake long misattributed to test ordering (the per-test engine.dispose() never
addressed it; it is value-driven, not connection state).

The conftest ``@compiles(UUID, "sqlite")`` override forces CHAR(32) (TEXT
affinity), so values are stored verbatim. Prod is PostgreSQL (native uuid) and
is unaffected. This test pins the fix with a DETERMINISTIC float-coercing id.
"""

import uuid

from app.models.category import Category

# 32 hex chars that ALSO form a valid float literal ("111…1e22"): under the
# buggy NUMERIC affinity this is coerced to a real on INSERT and crashes on read;
# under the CHAR(32)/TEXT-affinity fix it is stored and read back verbatim.
COERCING_ID = uuid.UUID(hex="1" * 29 + "e22")


def test_float_coercing_uuid_round_trips_under_sqlite(db):
    db.add(
        Category(
            id=COERCING_ID,
            name="Affinity Guard",
            slug="affinity-guard",
            icon="circle",
            sort_order=0,
        )
    )
    db.commit()
    db.expire_all()
    got = db.query(Category).filter(Category.slug == "affinity-guard").one()
    assert got.id == COERCING_ID
