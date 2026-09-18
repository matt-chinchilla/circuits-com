"""Migration 055 — the badge catalogue + per-supplier holdings replace suppliers.founder."""

import uuid
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import Badge, Supplier, SupplierBadge
from app.models.badge import BADGE_SCHEMES, FOUNDER_BADGE_1, FOUNDER_BADGE_2, FOUNDER_FAMILY
from app.services.badges import badge_look, founder_row, supplier_badge_fields

VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"


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
    db.add(
        SupplierBadge(id=uuid.uuid4(), supplier_id=sup.id, badge_id=b1.id, family=FOUNDER_FAMILY)
    )
    db.flush()
    db.add(
        SupplierBadge(id=uuid.uuid4(), supplier_id=sup.id, badge_id=b2.id, family=FOUNDER_FAMILY)
    )
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
    row = SupplierBadge(
        id=uuid.uuid4(),
        supplier_id=sup.id,
        badge_id=b1.id,
        family=FOUNDER_FAMILY,
        scheme="white",
    )
    db.add(row)
    db.commit()
    db.refresh(sup)
    assert founder_row(sup) is row
    assert badge_look(row) == {
        "key": FOUNDER_BADGE_1,
        "scheme": "white",
        "intensity": 1.0,
        "opacity": 0.75,
        "sparks": True,
    }
    row.enabled = False
    db.commit()
    db.refresh(sup)
    assert supplier_badge_fields(sup) == {"founder": False, "badge": None}


def test_schemes_are_the_nine_from_the_design():
    assert BADGE_SCHEMES == (
        "red",
        "orange",
        "yellow",
        "green",
        "blue",
        "indigo",
        "violet",
        "white",
        "black",
    )


def test_migration_055_is_chained_to_054():
    src = (VERSIONS / "055_supplier_badges.py").read_text()
    assert 'revision = "055"' in src and 'down_revision = "054"' in src
    assert 'op.drop_column("suppliers", "founder")' in src


# ── the 054 chain test, rehoused ────────────────────────────────────────────
# `test_supplier_founder.py` is deleted by 055 (its payload tests move to
# test_supplier_badges_payloads.py), but the chain assertion on 054's own
# source is still the only thing pinning that link — so it lives here now.


def test_migration_054_is_chained_to_053():
    src = (VERSIONS / "054_supplier_founder.py").read_text()
    assert 'revision = "054"' in src
    assert 'down_revision = "053"' in src
    assert "op.add_column(" in src and '"founder"' in src
    assert "server_default=sa.false()" in src, (
        "the constant server_default is what backfills every existing prod "
        "supplier to false without a table rewrite"
    )
    assert "nullable=False" in src
    assert 'op.drop_column("suppliers", "founder")' in src, "downgrade must drop the column"


# ── the catalogue is code ───────────────────────────────────────────────────


def test_reseeding_re_asserts_the_catalogue(db, seeded_db, monkeypatch):
    """Flipping a row in BADGE_CATALOGUE and redeploying must take effect. It
    would not if get_or_create_badge returned early on an existing row — and
    every environment past its first boot HAS the rows already, because 055's
    own migration inserts them."""
    from app.db import seed as seed_module

    before = db.query(Badge).filter_by(key=FOUNDER_BADGE_2).one()
    assert before.available is False

    monkeypatch.setattr(
        seed_module,
        "BADGE_CATALOGUE",
        (
            (FOUNDER_BADGE_1, FOUNDER_FAMILY, "Founding distributor", True, 0),
            (FOUNDER_BADGE_2, FOUNDER_FAMILY, "Founding distributor (alt)", True, 7),
        ),
    )
    seed_module._seed_badges(db)

    after = db.query(Badge).filter_by(key=FOUNDER_BADGE_2).one()
    assert after.id == before.id, "re-asserting must UPDATE, never insert a twin"
    assert after.available is True
    assert after.label == "Founding distributor (alt)"
    assert after.sort_order == 7
    assert db.query(Badge).filter_by(key=FOUNDER_BADGE_2).count() == 1
