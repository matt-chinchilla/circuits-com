"""Tier↔placement matrix (2026-06-11 board redesign) — Python-side enforcement.

The new matrix (LOCKED):
  - Top-level category (``parent_id IS NULL``) ⇒ **platinum** only, single-slot.
  - Subcategory (child) ⇒ **gold** (single-slot) or **silver** (multi).
  - Keyword (``category_id IS NULL``) ⇒ **silver** or **gold** (multi).

These tests hit the Python validator ``_validate_tier_placement`` and the
tier-aware supersede directly (both run on SQLite). The Postgres trigger that
mirrors this matrix is verified separately on PG — SQLite ignores triggers.
"""

import uuid

import pytest
from fastapi import HTTPException

from app.models import Category
from app.routes.admin_sponsors import _validate_tier_placement

# --- fixtures (adapt conftest's db/client/seeded_db to this module's needs) ---


@pytest.fixture
def top_category(db):
    """A top-level category (``parent_id IS NULL``)."""
    cat = Category(id=uuid.uuid4(), name="Sensors", slug="sensors", icon="gauge", sort_order=0)
    db.add(cat)
    db.flush()
    return cat


@pytest.fixture
def child_category(db, top_category):
    """A subcategory (child of ``top_category``)."""
    cat = Category(
        id=uuid.uuid4(),
        name="Temperature Sensors",
        slug="temperature-sensors",
        icon="thermometer",
        parent_id=top_category.id,
        sort_order=0,
    )
    db.add(cat)
    db.flush()
    return cat


# --- Task 1.1: validator → new matrix ---------------------------------------


def test_top_level_requires_platinum(db, top_category):
    with pytest.raises(HTTPException) as ei:
        _validate_tier_placement(db, "featured", top_category.id)
    assert ei.value.status_code == 422
    _validate_tier_placement(db, "platinum", top_category.id)  # ok, no raise


def test_subcategory_requires_gold_or_silver(db, child_category):
    for ok in ("gold", "silver"):
        _validate_tier_placement(db, ok, child_category.id)  # ok
    with pytest.raises(HTTPException) as ei:
        _validate_tier_placement(db, "platinum", child_category.id)
    assert ei.value.status_code == 422


def test_keyword_rejects_platinum(db):
    for ok in ("silver", "gold"):
        _validate_tier_placement(db, ok, None)  # ok
    with pytest.raises(HTTPException) as ei:
        _validate_tier_placement(db, "platinum", None)
    assert ei.value.status_code == 422
