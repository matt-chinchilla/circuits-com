# Supplier Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `suppliers.founder` flag with a badge catalogue plus per-supplier badge rows carrying the fire look (scheme/intensity/opacity/sparks), and give admins and customers an editor for it.

**Architecture:** Two tables (`badges` catalogue, `supplier_badges` holdings) behind one service module (`app/services/badges.py`) that every payload calls for the derived `founder` + `badge` look. Staff CRUD under `/api/suppliers/{id}/badges`, customer look-only PATCH under `/api/account/badges`. The `<fire-badge>` widget moves to `@shared` so the public boards and the admin/customer editor share it; a `BadgesPanel` above Listed Parts opens a full-viewport `BadgeEditorOverlay`.

**Tech Stack:** FastAPI + SQLAlchemy 2 + Alembic + Pydantic v2 (SQLite tests, Postgres prod); React 19 + TypeScript strict + SCSS modules + vitest (happy-dom).

**Spec:** `docs/superpowers/specs/2026-09-18-supplier-badges-design.md`

## Global Constraints

- Owner rule: NO `Co-Authored-By` or any attribution trailer in commits. Commit on `updates`, small units, do not push, do not deploy.
- `fire-badge.vendor.js` stays BYTE-IDENTICAL to the design export (sha256 `59aa499f4390aa9de516180df1d4556499e18d3d2829370245357bb67f8b6e67`); moving it is allowed, editing it is not.
- Badge keys are exactly `founder_badge_1` and `founder_badge_2`; family is `founder`; one row per (supplier, family).
- Schemes: `red orange yellow green blue indigo violet white black`; `intensity` 0.3–2 (default 1); `opacity` 0.2–1 (default 0.75); `sparks` default true; `scheme` default `orange`.
- Customers may change `key` (available badges only), `scheme`, `intensity`, `opacity`, `sparks` — never `enabled`; customer bodies are `extra="forbid"`.
- Every badge write calls `invalidate_catalog_caches()` (it already clears `category_cache`).
- `founder` stays a DERIVED boolean on every payload that carried it (`/api/suppliers/`, `/{id}`, the customer console supplier reads, the category detail `silver`, `/partners` sponsor dicts); those payloads gain `badge: {key, scheme, intensity, opacity, sparks} | null`.
- Neither new table travels in `scripts/catalog_export.py` / `catalog_load.py`.
- Admin scope may not import public; the widget lives in `@shared/components/FounderBadge/`.
- Gates: `cd api && pytest tests/ -q`; `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test && npm run build`.
- Local proof: `DOCKER_BUILDKIT=1 docker compose up -d --build api frontend`; api has no volume mount.

---

## File structure

| File | Responsibility |
|---|---|
| `api/app/models/badge.py` (new) | `Badge` catalogue + `SupplierBadge` holding, constants `FOUNDER_FAMILY`, `BADGE_SCHEMES`, `FOUNDER_BADGE_1/2` |
| `api/app/services/badges.py` (new) | `founder_row`, `badge_look`, `supplier_badge_fields`, `serialize_supplier_badge`, `serialize_badge_def` — the ONE place a payload asks "what badge does this supplier show" |
| `api/alembic/versions/055_supplier_badges.py` (new) | tables, catalogue rows, backfill from `founder`, drop the column |
| `api/app/db/seed.py` | `_seed_badges(db)` idempotent catalogue seed |
| `api/app/routes/supplier_badges.py` (new) | staff CRUD + catalogue |
| `api/app/routes/account_badges.py` (new) | customer look-only |
| `api/app/routes/suppliers.py`, `services/category_service.py`, `schemas/supplier.py`, `schemas/sponsor.py` | derived `founder` + `badge` |
| `frontend/src/shared/types/badge.ts` (new) | `BadgeLook`, `BADGE_SCHEMES`, `BADGE_RANGES` |
| `frontend/src/shared/components/FounderBadge/` (moved) | widget + vendor file + provenance + test |
| `frontend/src/admin/components/BadgesPanel/` (new) | the panel above Listed Parts, both consoles |
| `frontend/src/admin/components/BadgeEditorOverlay/` (new) | full-viewport editor |

---

### Task 1: Models, service, migration 055, catalogue seed

**Files:**
- Create: `api/app/models/badge.py`, `api/app/services/badges.py`, `api/alembic/versions/055_supplier_badges.py`
- Modify: `api/app/models/__init__.py`, `api/app/models/supplier.py` (add `badges` relationship; the `founder` column is REMOVED in this task), `api/app/db/seed.py`, `api/tests/conftest.py` (seeded_db must seed the catalogue if it does not run `seed()`)
- Test: `api/tests/test_supplier_badges_model.py`

**Interfaces:**
- Produces: `Badge(id, key, family, label, available, sort_order, created_at)`, `SupplierBadge(id, supplier_id, badge_id, family, enabled, scheme, intensity, opacity, sparks, granted_by, granted_at, updated_at)` with `SupplierBadge.badge` (joined, `lazy="joined"`) and `Supplier.badges` (`lazy="selectin"`, `cascade="all, delete-orphan"`); `services.badges.founder_row(supplier) -> SupplierBadge | None`, `badge_look(row) -> dict`, `supplier_badge_fields(supplier) -> {"founder": bool, "badge": dict | None}`, `serialize_supplier_badge(row) -> dict`, `serialize_badge_def(b) -> dict`; seed `get_or_create_badge(db, key, family, label, available, sort_order)`.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_supplier_badges_model.py
"""Migration 055 — the badge catalogue + per-supplier holdings replace suppliers.founder."""
import uuid
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import Badge, Supplier, SupplierBadge
from app.models.badge import BADGE_SCHEMES, FOUNDER_BADGE_1, FOUNDER_BADGE_2, FOUNDER_FAMILY
from app.services.badges import badge_look, founder_row, supplier_badge_fields


def test_supplier_no_longer_has_a_founder_column():
    assert "founder" not in Supplier.__table__.c


def test_holding_columns_and_defaults():
    c = SupplierBadge.__table__.c
    assert not c.enabled.nullable and c.enabled.default.arg is True
    assert c.scheme.default.arg == "orange"
    assert c.intensity.default.arg == Decimal("1.00") or float(c.intensity.default.arg) == 1.0
    assert float(c.opacity.default.arg) == 0.75
    assert c.sparks.default.arg is True
    assert c.scheme.type.length >= 12 and SupplierBadge.__table__.c.family.type.length >= 40


def test_one_holding_per_family(db, seeded_db):
    sup = seeded_db["supplier1"]
    b1 = db.query(Badge).filter_by(key=FOUNDER_BADGE_1).one()
    b2 = db.query(Badge).filter_by(key=FOUNDER_BADGE_2).one()
    db.add(SupplierBadge(id=uuid.uuid4(), supplier_id=sup.id, badge_id=b1.id, family=FOUNDER_FAMILY))
    db.flush()
    db.add(SupplierBadge(id=uuid.uuid4(), supplier_id=sup.id, badge_id=b2.id, family=FOUNDER_FAMILY))
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()


def test_the_catalogue_is_seeded_with_both_founder_badges(db, seeded_db):
    rows = {b.key: b for b in db.query(Badge).all()}
    assert rows[FOUNDER_BADGE_1].available is True
    assert rows[FOUNDER_BADGE_2].available is False
    assert rows[FOUNDER_BADGE_1].family == rows[FOUNDER_BADGE_2].family == FOUNDER_FAMILY


def test_service_derives_founder_and_look(db, seeded_db):
    sup = seeded_db["supplier1"]
    assert supplier_badge_fields(sup) == {"founder": False, "badge": None}
    b1 = db.query(Badge).filter_by(key=FOUNDER_BADGE_1).one()
    row = SupplierBadge(id=uuid.uuid4(), supplier_id=sup.id, badge_id=b1.id, family=FOUNDER_FAMILY, scheme="white")
    db.add(row); db.commit(); db.refresh(sup)
    assert founder_row(sup) is row
    assert badge_look(row) == {"key": FOUNDER_BADGE_1, "scheme": "white", "intensity": 1.0, "opacity": 0.75, "sparks": True}
    row.enabled = False; db.commit(); db.refresh(sup)
    assert supplier_badge_fields(sup) == {"founder": False, "badge": None}


def test_schemes_are_the_nine_from_the_design():
    assert BADGE_SCHEMES == ("red", "orange", "yellow", "green", "blue", "indigo", "violet", "white", "black")


def test_migration_055_is_chained_to_054():
    import importlib
    m = importlib.import_module("alembic.versions.055_supplier_badges") if False else None  # noqa: F841
    src = open("alembic/versions/055_supplier_badges.py").read()
    assert 'revision = "055"' in src and 'down_revision = "054"' in src
    assert "op.drop_column(\"suppliers\", \"founder\")" in src
```

(Keep the exact-decimal assertion loose: SQLAlchemy stores `default=Decimal("1.00")`; test both forms as above.)

- [ ] **Step 2: Run to verify failure** — `cd api && pytest tests/test_supplier_badges_model.py -q` → ImportError on `app.models.Badge`.

- [ ] **Step 3: The models**

```python
# api/app/models/badge.py
"""Badges (2026-09-18, owner: "the idea of a 'badge' is going to be a continual thing
that gets applied to customers regularly"). `badges` is the catalogue — what a badge CAN
be; `supplier_badges` is who holds which one and how its fire looks. One holding per
(supplier, family): choosing the founder badge's alternate appearance UPDATES badge_id.
Per-environment state like sponsorships — never in the catalog transfer."""
import uuid
from datetime import UTC, datetime

from sqlalchemy import (Boolean, CheckConstraint, Column, DateTime, ForeignKey, Integer,
                        Numeric, String, UniqueConstraint)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base

FOUNDER_FAMILY = "founder"
FOUNDER_BADGE_1 = "founder_badge_1"
FOUNDER_BADGE_2 = "founder_badge_2"
BADGE_SCHEMES = ("red", "orange", "yellow", "green", "blue", "indigo", "violet", "white", "black")
INTENSITY_RANGE = (0.3, 2.0)
OPACITY_RANGE = (0.2, 1.0)


class Badge(Base):
    __tablename__ = "badges"
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    key = Column(String(40), nullable=False, unique=True)
    family = Column(String(40), nullable=False)
    label = Column(String(80), nullable=False)
    available = Column(Boolean, nullable=False, default=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC))


class SupplierBadge(Base):
    __tablename__ = "supplier_badges"
    __table_args__ = (
        UniqueConstraint("supplier_id", "family", name="uq_supplier_badges_family"),
        CheckConstraint("scheme IN ('red','orange','yellow','green','blue','indigo','violet','white','black')", name="ck_supplier_badges_scheme"),
        CheckConstraint("intensity >= 0.3 AND intensity <= 2", name="ck_supplier_badges_intensity"),
        CheckConstraint("opacity >= 0.2 AND opacity <= 1", name="ck_supplier_badges_opacity"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    supplier_id = Column(UUID(as_uuid=True), ForeignKey("suppliers.id", ondelete="CASCADE"), nullable=False, index=True)
    badge_id = Column(UUID(as_uuid=True), ForeignKey("badges.id", ondelete="RESTRICT"), nullable=False)
    family = Column(String(40), nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    scheme = Column(String(12), nullable=False, default="orange")
    intensity = Column(Numeric(3, 2), nullable=False, default=Decimal("1.00"))
    opacity = Column(Numeric(3, 2), nullable=False, default=Decimal("0.75"))
    sparks = Column(Boolean, nullable=False, default=True)
    granted_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    granted_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC))
    updated_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC), onupdate=lambda: datetime.now(UTC))

    badge = relationship("Badge", lazy="joined")
    supplier = relationship("Supplier", back_populates="badges")
```
(add `from decimal import Decimal` at the top.) In `supplier.py`: delete the `founder` column and its comment; add `badges = relationship("SupplierBadge", back_populates="supplier", lazy="selectin", cascade="all, delete-orphan")`. Register both in `models/__init__.py` (`from .badge import Badge, SupplierBadge` + `__all__`). Check every `import` of `Supplier.founder` is gone: `grep -rn "\.founder\b" api/app` — Tasks 2–4 fix the payload sites; in THIS task make the api importable by replacing `bool(supplier.founder)` reads with `supplier_badge_fields(...)` calls (Task 2 owns the tests for them).

- [ ] **Step 4: The service**

```python
# api/app/services/badges.py
"""The one place a payload asks "what badge does this supplier show". Every reader of
`founder` (a DERIVED flag since 055) or `badge` (the look the boards render) goes through
here, so the rule "enabled founder-family row, else nothing" is written once."""
from app.models.badge import FOUNDER_FAMILY, Badge, SupplierBadge
from app.models.supplier import Supplier


def founder_row(supplier: Supplier | None) -> SupplierBadge | None:
    if supplier is None:
        return None
    for row in supplier.badges:
        if row.family == FOUNDER_FAMILY and row.enabled:
            return row
    return None


def badge_look(row: SupplierBadge) -> dict:
    return {
        "key": row.badge.key,
        "scheme": row.scheme,
        "intensity": float(row.intensity),
        "opacity": float(row.opacity),
        "sparks": bool(row.sparks),
    }


def supplier_badge_fields(supplier: Supplier | None) -> dict:
    row = founder_row(supplier)
    return {"founder": row is not None, "badge": badge_look(row) if row else None}


def serialize_badge_def(b: Badge) -> dict:
    return {"id": str(b.id), "key": b.key, "family": b.family, "label": b.label,
            "available": bool(b.available), "sort_order": int(b.sort_order)}


def serialize_supplier_badge(row: SupplierBadge) -> dict:
    return {"id": str(row.id), "supplier_id": str(row.supplier_id), **badge_look(row),
            "family": row.family, "label": row.badge.label, "available": bool(row.badge.available),
            "enabled": bool(row.enabled), "granted_at": row.granted_at.isoformat() if row.granted_at else None,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None}
```

- [ ] **Step 5: Seed + conftest**

In `seed.py`, above `seed()`:
```python
BADGE_CATALOGUE = (
    # key, family, label, available, sort_order
    (FOUNDER_BADGE_1, FOUNDER_FAMILY, "Founding distributor", True, 0),
    (FOUNDER_BADGE_2, FOUNDER_FAMILY, "Founding distributor (alternate)", False, 1),
)

def get_or_create_badge(db, key, family, label, available, sort_order) -> Badge:
    obj = db.query(Badge).filter(Badge.key == key).first()
    if obj is None:
        obj = Badge(key=key, family=family, label=label, available=available, sort_order=sort_order)
        db.add(obj); db.flush()
    return obj

def _seed_badges(db) -> None:
    for row in BADGE_CATALOGUE:
        get_or_create_badge(db, *row)
    db.commit()
```
Call `_seed_badges(db)` as the FIRST line of `seed()`. Open `api/tests/conftest.py::seeded_db`: if it builds rows by hand instead of calling `seed()`, add `_seed_badges(db)` there so `seeded_db` always carries the catalogue.

- [ ] **Step 6: Migration 055**

```python
"""suppliers.founder → badges catalogue + supplier_badges holdings (owner, 2026-09-18).

Revision ID: 055  Revises: 054
Creates the catalogue with the two founder keys (fixed here so the backfill can join on
them), moves every founder=true supplier onto a founder_badge_1 holding with the design's
default look, then drops the flag. Downgrade re-adds the column from the enabled
founder-family holdings and drops both tables.
"""
import sqlalchemy as sa
from alembic import op

revision = "055"; down_revision = "054"; branch_labels = None; depends_on = None

SCHEMES = "'red','orange','yellow','green','blue','indigo','violet','white','black'"

def upgrade() -> None:
    op.create_table("badges",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("key", sa.String(40), nullable=False, unique=True),
        sa.Column("family", sa.String(40), nullable=False),
        sa.Column("label", sa.String(80), nullable=False),
        sa.Column("available", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()))
    op.create_table("supplier_badges",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("supplier_id", sa.dialects.postgresql.UUID(as_uuid=True), sa.ForeignKey("suppliers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("badge_id", sa.dialects.postgresql.UUID(as_uuid=True), sa.ForeignKey("badges.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("family", sa.String(40), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("scheme", sa.String(12), nullable=False, server_default="orange"),
        sa.Column("intensity", sa.Numeric(3, 2), nullable=False, server_default="1.00"),
        sa.Column("opacity", sa.Numeric(3, 2), nullable=False, server_default="0.75"),
        sa.Column("sparks", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("granted_by", sa.dialects.postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("granted_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("supplier_id", "family", name="uq_supplier_badges_family"),
        sa.CheckConstraint(f"scheme IN ({SCHEMES})", name="ck_supplier_badges_scheme"),
        sa.CheckConstraint("intensity >= 0.3 AND intensity <= 2", name="ck_supplier_badges_intensity"),
        sa.CheckConstraint("opacity >= 0.2 AND opacity <= 1", name="ck_supplier_badges_opacity"))
    op.create_index("ix_supplier_badges_supplier_id", "supplier_badges", ["supplier_id"])
    op.execute("""
        INSERT INTO badges (id, key, family, label, available, sort_order) VALUES
          (gen_random_uuid(), 'founder_badge_1', 'founder', 'Founding distributor', true, 0),
          (gen_random_uuid(), 'founder_badge_2', 'founder', 'Founding distributor (alternate)', false, 1)
        ON CONFLICT (key) DO NOTHING""")
    op.execute("""
        INSERT INTO supplier_badges (id, supplier_id, badge_id, family)
        SELECT gen_random_uuid(), s.id, b.id, 'founder'
        FROM suppliers s JOIN badges b ON b.key = 'founder_badge_1'
        WHERE s.founder""")
    op.drop_column("suppliers", "founder")

def downgrade() -> None:
    op.add_column("suppliers", sa.Column("founder", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.execute("""UPDATE suppliers s SET founder = true
                  FROM supplier_badges sb WHERE sb.supplier_id = s.id AND sb.family = 'founder' AND sb.enabled""")
    op.drop_index("ix_supplier_badges_supplier_id", table_name="supplier_badges")
    op.drop_table("supplier_badges"); op.drop_table("badges")
```
`gen_random_uuid()` is built into Postgres 13+ (the prod image is newer). Run the roundtrip on the LOCAL Postgres: `docker compose up -d db`, then from `api/` with `DATABASE_URL=postgresql://circuits:circuits@localhost:5432/circuits alembic upgrade head`, check `SELECT s.name FROM supplier_badges sb JOIN suppliers s ON s.id=sb.supplier_id` returns exactly Chirichella Inc., then `alembic downgrade -1` (founder=true on that row) and `upgrade head` again. Quote the psql output in the report.

- [ ] **Step 7: Run the suite** — `cd api && pytest tests/ -q`. Expect the old `test_supplier_founder.py` to fail on the dropped column: DELETE that file in this task (Task 2 replaces its payload tests with `test_supplier_badges_payloads.py`; the 054 chain test moves into the new model test file as `test_migration_054_is_chained_to_053`). Also fix `test_leads_never_public.py`'s `FakeSupplier` (it sets `self.founder = False`; give it `self.badges = []` instead). Everything else green.

- [ ] **Step 8: Commit** — `git commit -m "feat(api): badges catalogue + supplier_badges holdings replace the founder flag (migration 055)"`.

---

### Task 2: Derived `founder` + `badge` on every payload; transfer skips

**Files:**
- Modify: `api/app/routes/suppliers.py` (`supplier_to_dict`, `SupplierCreate`/`SupplierUpdate` lose `founder`, the null-guard at ~`:264` goes), `api/app/services/category_service.py` (`_sponsor_board_dict` ~`:119`, the Silver comprehension ~`:592`), `api/app/schemas/supplier.py` (`founder: bool = False` stays; add `badge: dict | None = None`), `api/app/schemas/sponsor.py` (`SponsorResponse` gets `founder: bool = False`, `badge: dict | None = None` — BOTH `routes/sponsors.py` and `routes/admin_sponsors.py` serialize it), `scripts/catalog_export.py` + `scripts/catalog_load.py` (drop `"founder"` from the skip tuple / `SUPPLIER_SKIP` — the column is gone), `api/tests/test_catalog_transfer_scripts.py` (the founder-skip test becomes: `badges`/`supplier_badges` are never exported — assert neither table name appears in `catalog_export.py`).
- Test: `api/tests/test_supplier_badges_payloads.py`

**Interfaces:** Consumes Task 1's `supplier_badge_fields`. Produces the wire shape `badge: {key, scheme, intensity, opacity, sparks} | null` beside `founder: bool` on: `GET /api/suppliers/`, `/api/suppliers/{id}`, `/api/account/suppliers`, `/api/account/my-supply`, `GET /api/categories/{slug}` → `silver[]`, `GET /api/categories/{slug}/partners` sponsor dicts.

- [ ] **Step 1: Failing tests**

```python
# api/tests/test_supplier_badges_payloads.py
import uuid
from app.models import Badge, SupplierBadge
from app.models.badge import FOUNDER_BADGE_1, FOUNDER_FAMILY

def _grant(db, supplier, **look):
    b1 = db.query(Badge).filter_by(key=FOUNDER_BADGE_1).one()
    row = SupplierBadge(id=uuid.uuid4(), supplier_id=supplier.id, badge_id=b1.id, family=FOUNDER_FAMILY, **look)
    db.add(row); db.commit(); return row

def test_public_list_carries_derived_founder_and_look(client, db, seeded_db):
    sup = seeded_db["supplier1"]
    before = {s["id"]: s for s in client.get("/api/suppliers/").json()}
    assert before[str(sup.id)]["founder"] is False and before[str(sup.id)]["badge"] is None
    _grant(db, sup, scheme="black", intensity=1.5)
    after = {s["id"]: s for s in client.get("/api/suppliers/").json()}
    assert after[str(sup.id)]["founder"] is True
    assert after[str(sup.id)]["badge"] == {"key": FOUNDER_BADGE_1, "scheme": "black", "intensity": 1.5, "opacity": 0.75, "sparks": True}

def test_create_and_update_no_longer_accept_founder(client, seeded_db, admin_headers):
    r = client.post("/api/suppliers/", json={"name": "No Flag Co", "founder": True}, headers=admin_headers)
    assert r.status_code == 200 and r.json()["founder"] is False  # ignored, not honoured

def test_silver_directory_and_partners_carry_the_look(client, db, tier_boards, seeded_db):
    # tier_boards fixture: see test_supplier_founder.py's former test_the_silver_directory_carries_the_flag
    ...  # copy that fixture usage verbatim, assert `badge` present with the granted scheme on the Silver row AND on the Platinum sponsor dict in /partners
```
Copy the old file's `tier_boards` and `admin_headers`/`_auth_header` usage from git history (`git show HEAD~1:api/tests/test_supplier_founder.py`) so the three board payloads are exercised exactly as before, with `badge` asserted beside `founder`.

- [ ] **Step 2: Run** → fails (`badge` missing / `founder` still a column read).

- [ ] **Step 3: Implement** — in `supplier_to_dict`: `**supplier_badge_fields(supplier)` replaces the `"founder"` line. In `_sponsor_board_dict`: `**supplier_badge_fields(supplier)`. In the Silver comprehension: same. Remove `founder` from `SupplierCreate`/`SupplierUpdate` and the 422 null guard in `update_supplier`; `create_supplier` no longer passes it. Schemas: `SupplierResponse` keeps `founder: bool = False`, adds `badge: dict | None = None`; `SponsorResponse` adds both. The supplier list route loads 59 rows + `selectin` badges = one extra query; fine.

- [ ] **Step 4: Transfer** — remove `"founder"` from both skips; rewrite the transfer test as described; `python scripts/catalog_export.py > /dev/null` must still run against the local DB (smoke, quote one line).

- [ ] **Step 5: Gates** — `cd api && pytest tests/ -q` green. **Step 6: Commit** — `feat(api): founder is derived from supplier_badges; payloads carry the badge look`.

---

### Task 3: Staff badges API + data-versions scope

**Files:**
- Create: `api/app/routes/supplier_badges.py`; Modify: `api/app/main.py` (import + `include_router`), `api/app/services/data_versions.py` (`"badges": ("badges", "supplier_badges")`), `api/app/routes/suppliers.py::delete_supplier` (bulk-delete `SupplierBadge` rows before `db.delete(supplier)`, with `db.expire(supplier)` — the selectin/bulk-delete gotcha).
- Test: `api/tests/test_supplier_badges_staff.py`

**Interfaces (produces):**
- `GET /api/badges` → `[serialize_badge_def]` (staff)
- `GET /api/suppliers/{id}/badges` → `[serialize_supplier_badge]`
- `POST /api/suppliers/{id}/badges {key}` → 200 row | 404 supplier | 409 family held | 422 unknown/unavailable key
- `PATCH /api/suppliers/{id}/badges/{family} {key?, enabled?, scheme?, intensity?, opacity?, sparks?}` → row | 404 | 422 (ranges, unknown key, key of another family, unavailable key)
- `DELETE /api/suppliers/{id}/badges/{family}` → `{"ok": true}` | 404

- [ ] **Step 1: Tests** (use `_auth_header` from the old founder test for admin; build a `viewer` user as `test_supplier_founder.py::test_a_viewer_cannot_set_the_flag` did):

```python
def test_grant_patch_revoke_round_trip(client, db, seeded_db):
    h = _auth_header(client); sid = str(seeded_db["supplier1"].id)
    assert client.get("/api/badges", headers=h).json()[0]["key"] == "founder_badge_1"
    r = client.post(f"/api/suppliers/{sid}/badges", json={"key": "founder_badge_1"}, headers=h)
    assert r.status_code == 200 and r.json()["scheme"] == "orange" and r.json()["enabled"] is True
    assert client.post(f"/api/suppliers/{sid}/badges", json={"key": "founder_badge_1"}, headers=h).status_code == 409
    r = client.patch(f"/api/suppliers/{sid}/badges/founder", json={"scheme": "white", "intensity": 1.7, "enabled": False}, headers=h)
    assert r.json()["scheme"] == "white" and r.json()["intensity"] == 1.7 and r.json()["enabled"] is False
    assert client.get(f"/api/suppliers/{sid}").json()["founder"] is False   # disabled = not shown
    assert client.patch(f"/api/suppliers/{sid}/badges/founder", json={"intensity": 2.5}, headers=h).status_code == 422
    assert client.patch(f"/api/suppliers/{sid}/badges/founder", json={"key": "founder_badge_2"}, headers=h).status_code == 422  # unavailable
    assert client.delete(f"/api/suppliers/{sid}/badges/founder", headers=h).status_code == 200
    assert client.get(f"/api/suppliers/{sid}/badges", headers=h).json() == []

def test_viewer_reads_but_cannot_write(client, db, seeded_db): ...  # GET 200, POST 403 (require_staff wall)

def test_every_write_invalidates_the_caches(client, seeded_db, monkeypatch):
    calls = []; monkeypatch.setattr("app.routes.supplier_badges.invalidate_catalog_caches", lambda: calls.append(1))
    ...  # grant, patch, revoke → len(calls) == 3

def test_data_versions_has_a_badges_scope():
    from app.services.data_versions import SCOPES
    assert SCOPES["badges"] == ("badges", "supplier_badges")
```

- [ ] **Step 2: Implement the router**

```python
router = APIRouter(prefix="/api", tags=["badges"])

class BadgeLookPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str | None = None
    scheme: Literal["red","orange","yellow","green","blue","indigo","violet","white","black"] | None = None
    intensity: float | None = Field(None, ge=0.3, le=2)
    opacity: float | None = Field(None, ge=0.2, le=1)
    sparks: bool | None = None

class StaffBadgePatch(BadgeLookPatch):
    enabled: bool | None = None

class GrantBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str

def _badge_or_422(db, key, family=None) -> Badge:  # 422 unknown; 422 unavailable; 422 wrong family
def _holding_or_404(db, supplier_id, family) -> SupplierBadge
def apply_look(row, patch: BadgeLookPatch, db) -> None:  # shared with the customer router: key→badge_id via _badge_or_422(family=row.family), Decimal(str(x)) for the numerics
```
Routes take `current_user: User = Depends(require_staff)`; `granted_by=current_user.id` on grant; after every commit `invalidate_catalog_caches()`; `db.refresh(row)` before serializing. Nulls in the PATCH body (`"scheme": null`) → 422 (every field backs NOT NULL; mirror `admin_expenses`' "cannot be null" guard).

- [ ] **Step 3: Gates + commit** — `feat(api): staff badge endpoints (grant, look, enable, revoke) + the badges data scope`.

---

### Task 4: Customer badges API

**Files:** Create `api/app/routes/account_badges.py` (prefix `/api/account`, `dependencies=[Depends(account_scope)]`, import `apply_look`, `BadgeLookPatch` from `supplier_badges`); register in `main.py`. Test `api/tests/test_account_badges.py` (fixtures modelled on `test_account_expenses.py::books` — an activated `user` with `supplier_id`, one without).

**Interfaces:** `GET /api/account/badges` → rows (404 `no_supplier` when `not scope.is_supplier`); `PATCH /api/account/badges/{family}` body `BadgeLookPatch` (`extra="forbid"` → `enabled` is 422) → row | 404 (family not held by MY supplier).

- [ ] **Step 1: Tests**
```python
def test_customer_reads_and_restyles_only_their_own(client, db, seeded_db, badge_holders):
    mine, other, h = badge_holders   # (my supplier's row, another supplier's row, my auth header)
    assert [r["id"] for r in client.get("/api/account/badges", headers=h).json()] == [str(mine.id)]
    r = client.patch("/api/account/badges/founder", json={"scheme": "blue", "sparks": False}, headers=h)
    assert r.status_code == 200 and r.json()["scheme"] == "blue" and r.json()["sparks"] is False
    assert client.patch("/api/account/badges/founder", json={"enabled": False}, headers=h).status_code == 422
    assert client.patch("/api/account/badges/founder", json={"key": "founder_badge_2"}, headers=h).status_code == 422
def test_free_account_gets_404(...)   # activated customer with no supplier link
def test_staff_are_refused(...)       # account_scope refuses staff (existing wall) → 403
def test_customer_write_invalidates(...)  # monkeypatch as in Task 3
```
- [ ] **Step 2: Implement**, **Step 3: gates**, **Step 4: commit** — `feat(api): customers restyle their own badge (look only)`.

---

### Task 5: The shared widget + boards read the look

**Files:**
- `git mv frontend/src/public/components/widgets/FounderBadge.tsx frontend/src/shared/components/FounderBadge/FounderBadge.tsx`, same for `FounderBadge.module.scss`, `founderBadge.test.ts`, and the `fireBadge/` folder → `frontend/src/shared/components/FounderBadge/fireBadge/` (keep `fire-badge.vendor.js`, `.d.ts`, `PROVENANCE.md`; `cmp` against `.superpowers/sdd/2026-09-17-supplier-founder/design-import/fire-badge.js` must still be clean).
- Create `frontend/src/shared/types/badge.ts`:
```ts
export const BADGE_SCHEMES = ['red','orange','yellow','green','blue','indigo','violet','white','black'] as const;
export type BadgeScheme = (typeof BADGE_SCHEMES)[number];
export const BADGE_RANGES = { intensity: { min: 0.3, max: 2, step: 0.1, default: 1 }, opacity: { min: 0.2, max: 1, step: 0.05, default: 0.75 } } as const;
export interface BadgeLook { key: string; scheme: BadgeScheme; intensity: number; opacity: number; sparks: boolean; }
```
- `FounderBadge.tsx` gains `look?: BadgeLook | null` and sets `scheme`, `intensity`, `opacity`, `sparks={look.sparks ? 'true' : 'false'}` when `look` is given; with no `look` it sets NOTHING (the element defaults — keep that sentence in the doc comment). `founder_badge_2` and any unknown key render the same pin (there is one artwork today).
- Boards: `CategorySponsor.tsx:603` → `{s.badge && <FounderBadge look={s.badge} size={22} />}` (map `badge: sponsor.badge ?? null` where `founder` was mapped), `SponsorBlock.tsx:547` → `{sponsor.badge && <FounderBadge look={sponsor.badge} size={18} />}`, `SilverPartners.tsx:152` → `{s.badge && <FounderBadge look={s.badge} size={15} />}`; imports become `@shared/components/FounderBadge/FounderBadge`.
- `@public/types/sponsor.ts`: `badge?: BadgeLook | null` on `PlatinumSponsor`, `Sponsor`, `PartnerSupplier` (import the type from `@shared/types/badge`); keep `founder?: boolean | null`.
- Test: the moved `founderBadge.test.ts` — fix `COMPONENTS` (now `join(__dirname, '..', '..', '..', 'public', 'pages', 'category', 'components')`), add `it('sets the four fire attributes from a look, and none without one')`, and update the three render-site witnesses to look for `look={s.badge}` / `sponsor.badge`.

- [ ] Steps: failing test → move → implement → `npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test` → `npm run build` → rebuild local frontend + api (`docker compose up -d --build api frontend`) → confirm on `/category/power-management-ics-pmics` that Chirichella Inc.'s pin still burns (its backfilled row is orange/1/0.75/sparks) → commit `refactor(shared): FounderBadge moves to shared and renders the supplier's badge look`.

---

### Task 6: Admin + account API clients, types, the BadgesPanel

**Files:**
- `frontend/src/admin/types/admin.ts`: remove `founder?: boolean` from `AdminSupplier`; add
```ts
export interface BadgeDef { id: string; key: string; family: string; label: string; available: boolean; sort_order: number; }
export interface SupplierBadge extends BadgeLook { id: string; supplier_id: string; family: string; label: string; available: boolean; enabled: boolean; granted_at: string | null; updated_at: string | null; }
export type BadgeLookPatch = Partial<Pick<SupplierBadge, 'key' | 'scheme' | 'intensity' | 'opacity' | 'sparks'>>;
```
- `adminApi.ts`: `getBadgeCatalogue: () => cachedRead('badges:catalogue', () => adminClient.get<BadgeDef[]>('/badges').then(r => r.data), { scopes: ['badges'] })`, `getSupplierBadges(id)` (cachedRead key `badges:supplier:${id}`, scope `badges`), `grantSupplierBadge(id, key)`, `updateSupplierBadge(id, family, patch: BadgeLookPatch & { enabled?: boolean })`, `revokeSupplierBadge(id, family)`. `accountApi.ts`: `getMyBadges()`, `updateMyBadge(family, patch: BadgeLookPatch)`. `queryCache.ts`: `DataScope` += `'badges'` (`test_data_versions.py` pins the union to the server's `SCOPES` — Task 3 added the server side).
- Remove the founder checkbox/chip/row from `pages/suppliers/{form,list,detail}` (the panel replaces them; delete `.founderChip` and its witness tests).
- Create `frontend/src/admin/components/BadgesPanel/{BadgesPanel.tsx, BadgesPanel.module.scss, badgesPanel.test.ts}`:
```ts
interface BadgesPanelProps {
  mode: 'staff' | 'account';
  supplierId?: string;           // staff: required
  onEdit: (row: SupplierBadge) => void;
}
```
Renders a `.panel` (reuse the detail page's panel look: copy `.panel/.panelHead/.panelTitle` rules into the module), title "Badges", one row per holding: `<FounderBadge look={row} size={32} />`, the label, the appearance key, an "Edit" button → `onEdit(row)`; staff mode adds a "Grant…" `<select>` (from `getBadgeCatalogue`, only families not yet held, unavailable keys disabled with "coming soon"), an Enabled `<input type="checkbox">` (calls `updateSupplierBadge(..., {enabled})`), and "Revoke" (confirm via a second click "Really revoke?" — no `window.confirm`). Empty: staff → the Grant control alone; account → "Your badge will appear here once it is granted." Reads via `useCachedQuery(key, fetcher, { scopes: ['badges'] })`; every write then `refresh()`.
- Wire it: `pages/suppliers/detail/index.tsx` — `<BadgesPanel mode="staff" supplierId={id} onEdit={setEditing} />` immediately BEFORE the `partsPanel` div; `pages/suppliers/mine/index.tsx` — after `<MyCompanyCard …/>` inside the `status === 'ready'` branch, `<BadgesPanel mode="account" onEdit={setEditing} />`. `editing` state is consumed by Task 7's overlay; until then render nothing for it.
- Tests: source-level witnesses (`readFileSync`) that the detail page mounts the panel before `partsPanel`, that mine mounts it in the ready branch, that `queryCache.ts` lists `'badges'`, that the panel module exports the three modes' controls (grep `Grant`, `Revoke`, `Enabled` in staff branch and their absence in account mode via a happy-dom render with a stubbed `adminApi`).
- Gates → commit `feat(admin): Badges panel above Listed Parts in both consoles`.

---

### Task 7: BadgeEditorOverlay

**Files:** `frontend/src/admin/components/BadgeEditorOverlay/{BadgeEditorOverlay.tsx, BadgeEditorOverlay.module.scss, badgeEditorOverlay.test.ts}`; wire in both pages (`editing && <BadgeEditorOverlay mode=… row={editing} catalogue={…} onClose={() => setEditing(null)} onSaved={refresh} />`).

**Props:** `{ mode: 'staff' | 'account'; supplierId?: string; row: SupplierBadge; catalogue: BadgeDef[]; onClose(): void; onSaved(row: SupplierBadge): void }`.

**Layout (owner's words: no size ladder; Platinum/Gold/Silver side by side; not as tall as the design editor):**
- `position: fixed; inset: 0; z-index: 1000; background: #1c1f22` (the design page's ink), `role="dialog" aria-modal="true" aria-labelledby`, Esc closes, scrim click closes, focus moves to the first control on open and returns on close; body scroll locked while open (`document.body.style.overflow = 'hidden'` in an effect with cleanup).
- Top bar (one row, wraps ≤ 900px): title "Founding distributor badge", appearance `<select>` over `catalogue.filter(b => b.family === row.family)` (unavailable → `disabled` + " (coming soon)"), scheme `<select>` over `BADGE_SCHEMES`, intensity `<input type="range" min=0.3 max=2 step=0.1>` + value, opacity `<input type="range" min=0.2 max=1 step=0.05>` + value, sparks `<input type="checkbox" role="switch">`, then `Cancel` and `Save` (`Save` disabled while nothing changed or while saving; error text under the bar on a failed PATCH via `apiErrorDetail`).
- Body row 1 "Color schemes": the nine swatches, each `<button aria-pressed>` wrapping `<FounderBadge look={{...draft, scheme}} size={64} />` + caption; click sets `draft.scheme`.
- Body row 2 "On the boards": three swatches side by side — Platinum (`linear-gradient(135deg,#2c3138,#171a1e)`, `#e6e9ee`, 700 22.7px, pin 22), Gold (`radial-gradient(circle at 30% 20%,#2a2410,#0f0e08 70%)`, `#f4ecd6`, 700 18.9px, pin 18), Silver dark (`#14171a`, `#efe6cf`, 700 14.7px, pin 15) — each "<company name><FounderBadge look={draft} size=N />". Company name = the supplier's real name (pass `supplierName` in props; the panel has it).
- Staff mode adds, right of Save: an Enabled switch and a Revoke button (same two-click confirm as the panel). Height budget: top bar 64px + swatches 160px + boards 120px + paddings ≈ 420px; NEVER a scroll at 1366×768.
- Save: staff → `updateSupplierBadge(supplierId, row.family, diff)`; account → `updateMyBadge(row.family, diff)`; `diff` = only the changed fields among key/scheme/intensity/opacity/sparks (+ enabled for staff). `onSaved(result)` then `onClose()`.
- Tests (happy-dom, stub both api modules with `vi.mock`): renders nine swatches; changing the scheme select updates every preview's `scheme` attribute; Save sends ONLY the diff; Esc calls onClose; account mode renders no Enabled/Revoke; unavailable appearance is disabled.
- Proof: rebuild frontend; chrome-devtools screenshots at 1366×768 of the overlay from `/admin/suppliers/33e6785b-e34e-4391-9385-85ac11950bb3` (staff) and, after signing in as a customer linked to Chirichella Inc. (create one via psql if none: copy the seed customer pattern from `test_account_expenses.py`; DELETE it after), from `/account/my-supply`; then switch the scheme to `white`, Save, and screenshot the Platinum board showing white/blue flames. Save PNGs under `.superpowers/sdd/2026-09-18-supplier-badges/proof/`.
- Gates → commit `feat(admin): the badge editor overlay — look, appearance, and (staff) enable/revoke`.

---

### Task 8: Docs, CLAUDE.md, memory pointers

- `CLAUDE.md`: head line → **055** (`055 badges + supplier_badges`); replace the `suppliers.founder` gotcha bullet with: **`badges` + `supplier_badges` (055, 2026-09-18) are per-environment state — NOT catalog data** — the catalogue (`founder_badge_1` available, `founder_badge_2` coming soon; seeded idempotently) and one holding per (supplier, family) carrying the fire look; `founder` is DERIVED (`services/badges.supplier_badge_fields`, the single home) on every supplier/sponsor payload beside `badge`; staff write `/api/suppliers/{id}/badges`, customers restyle only via `/api/account/badges` (`extra="forbid"`, `enabled` is 422); every write goes through `invalidate_catalog_caches()` or the boards stay stale an hour; the `<fire-badge>` vendor file is byte-identical to the owner's design export and lives in `@shared/components/FounderBadge/` (two consumers); neither table travels in the catalog transfer and `--reseed` truncates holdings.
- `docs/claude-gotchas/sponsor-boards.md`: a short "Founder badge" section pointing at the spec and the overlay.
- Commit `docs: supplier badges — CLAUDE.md head 055 + the badges gotcha`.

---

## Self-review

- Spec §1 → Task 1 (+2 for derived fields, transfer). §2 → Tasks 3–4 (cache seam: `invalidate_catalog_caches` already clears `category_cache`; data scope in Task 3). §3 → Tasks 5–7 (widget move, types, panel, overlay, both consoles, founder checkbox removal in Task 6). §4 → tests inside each task; proof in Tasks 5 and 7. §5 out of scope untouched.
- Names used consistently: `supplier_badge_fields`, `serialize_supplier_badge`, `BadgeLookPatch`, `apply_look`, `getSupplierBadges`, `updateSupplierBadge`, `updateMyBadge`, `BadgesPanel`, `BadgeEditorOverlay`, `BadgeLook`, `BADGE_SCHEMES`, `BADGE_RANGES`.
