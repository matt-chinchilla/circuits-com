"""Migration 014 — Supplier board fields (sponsor tier boards, 2026-06-11).

The Platinum/Gold/Silver boards render four supplier attributes the model
lacked: `contact_role`, `coverage_hours`, and two brand-takeover hex colors.
SQLite ignores `String(N)` at runtime, so the length contract is asserted on
the column METADATA (matching the established `Category.icon` pattern), not a
live insert.
"""

from app.models.supplier import Supplier


def test_supplier_has_board_fields():
    cols = Supplier.__table__.c
    for name in ("contact_role", "coverage_hours", "brand_primary", "brand_secondary"):
        assert name in cols, f"Supplier.{name} column missing"


def test_supplier_contact_role_length():
    # Metadata length contract (SQLite drops VARCHAR(N) — assert on the type, not
    # a runtime insert). 120 chars accommodates a full job title.
    assert Supplier.__table__.c.contact_role.type.length >= 120
