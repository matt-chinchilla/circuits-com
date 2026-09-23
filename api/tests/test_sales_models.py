"""Migration 057 — sales codes, checkout intents (the slot hold), sponsor billing,
the payments mirror and the staff-only billing audit (spec §6)."""

import pathlib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import (
    BillingAudit,
    CheckoutIntent,
    SalesCode,
    SponsorBilling,
    SponsorPayment,
    sales,
)

MIGRATION = (
    pathlib.Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "057_gold_platinum_sales.py"
)


def _intent(**kw):
    base = dict(
        tier="gold",
        category_id=uuid.uuid4(),
        list_usd=2500,
        founder_usd=2100,
        price_usd=2100,
        channel="self_serve",
        sold_by="Daniel",
        company_name="Acme",
        email="a@acme.test",
        status="open",
        expires_at=datetime.now(UTC) + timedelta(minutes=45),
    )
    base.update(kw)
    return CheckoutIntent(**base)


def _code(**kw):
    base = dict(code="AB1CD2EF", code_points=10, rep="Daniel", created_by="Daniel")
    base.update(kw)
    return SalesCode(**base)


# ── the hold: one live intent per exclusive slot ─────────────────────────────


def test_one_live_hold_per_exclusive_slot(db):
    cat = uuid.uuid4()
    db.add(_intent(category_id=cat))
    db.commit()
    db.add(_intent(category_id=cat))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_one_live_hold_spans_both_exclusive_tiers(db):
    cat = uuid.uuid4()
    db.add(_intent(category_id=cat, tier="platinum"))
    db.commit()
    db.add(_intent(category_id=cat, tier="gold"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


@pytest.mark.parametrize("status", ["expired", "released", "completed", "conflict"])
def test_a_non_open_hold_does_not_block(db, status):
    cat = uuid.uuid4()
    db.add(_intent(category_id=cat, status=status))
    db.commit()
    db.add(_intent(category_id=cat))
    db.commit()  # no error


def test_silver_intents_never_block(db):
    cat = uuid.uuid4()
    db.add(_intent(tier="silver", category_id=cat))
    db.add(_intent(tier="silver", category_id=cat))
    db.commit()


def test_intent_defaults(db):
    row = _intent()
    db.add(row)
    db.commit()
    assert row.id is not None and row.created_at is not None
    assert row.stripe_session_id is None and row.resolved_at is None


def test_stripe_session_id_is_unique(db):
    db.add(_intent(stripe_session_id="cs_test_1", status="expired"))
    db.commit()
    db.add(_intent(stripe_session_id="cs_test_1", status="expired"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


# ── sales codes ──────────────────────────────────────────────────────────────


def test_code_defaults(db):
    row = _code()
    db.add(row)
    db.commit()
    assert row.active is True and row.uses == 0 and row.max_uses == 1
    expires = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=UTC)
    assert timedelta(days=13) < expires - datetime.now(UTC) <= timedelta(days=14)


def test_code_is_unique(db):
    db.add(_code())
    db.commit()
    db.add(_code())
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


@pytest.mark.parametrize("pts", [0, 16])
def test_code_points_check(db, pts):
    db.add(_code(code_points=pts))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_max_uses_check(db):
    db.add(_code(max_uses=0))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_column_lengths():
    c = SalesCode.__table__.c
    assert c.code.type.length >= 16
    assert c.email_lock.type.length >= 200
    assert c.rep.type.length >= 120
    assert c.note.type.length >= 500
    assert BillingAudit.__table__.c.action.type.length >= 40
    assert BillingAudit.__table__.c.detail.type.length >= 500


# ── sponsor billing (1:1, cascades with the sponsor) ─────────────────────────


def test_billing_row_cascades_with_its_sponsor():
    fk = next(iter(SponsorBilling.__table__.c.sponsor_id.foreign_keys))
    assert fk.column.table.name == "sponsors" and fk.ondelete == "CASCADE"
    assert SponsorBilling.__table__.c.sponsor_id.primary_key


def test_billing_defaults(db, seeded_db):
    row = SponsorBilling(
        sponsor_id=seeded_db["sponsor"].id, channel="self_serve", list_usd=2500, price_usd=2100
    )
    db.add(row)
    db.commit()
    assert row.card_link_version == 0 and row.void_pending is False
    assert row.collection_method == "charge_automatically"
    assert row.updated_at is not None


def test_payments_and_audit_are_fk_free_toward_sponsors():
    """Spec §6: only sponsor_billing references sponsors — the mirror and the
    audit survive a sponsor delete (and stay out of the reseed cascade)."""
    for model in (SponsorPayment, BillingAudit, SalesCode, CheckoutIntent):
        targets = {fk.column.table.name for fk in model.__table__.foreign_keys}
        assert not targets & {"sponsors", "suppliers", "users", "categories"}, model


def test_invoice_id_is_unique(db):
    db.add(SponsorPayment(stripe_invoice_id="in_1", stripe_subscription_id="sub_1", status="paid"))
    db.commit()
    db.add(SponsorPayment(stripe_invoice_id="in_1", stripe_subscription_id="sub_1", status="paid"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


# ── the model and 057 agree ──────────────────────────────────────────────────


def test_check_literals_match_migration_057():
    src = MIGRATION.read_text()
    for literal in (sales.CODE_POINTS_CHECK, sales.MAX_USES_CHECK, sales.LIVE_EXCLUSIVE_WHERE):
        assert literal in src


def test_057_follows_056_and_never_imports_app_code():
    src = MIGRATION.read_text()
    assert 'revision = "057"' in src and 'down_revision = "056"' in src
    assert "from app" not in src and "import app" not in src


def test_057_creates_every_model_table():
    src = MIGRATION.read_text()
    for model in (SalesCode, CheckoutIntent, SponsorBilling, SponsorPayment, BillingAudit):
        assert f'"{model.__tablename__}"' in src
        for column in model.__table__.c:
            assert f'"{column.name}"' in src, f"{model.__tablename__}.{column.name} missing in 057"


# ── R16: what occupies an exclusive slot ─────────────────────────────────────


@pytest.mark.parametrize(
    "status,occupies",
    [("Paused", True), (None, True), ("Active", True), ("Expired", False)],
)
def test_paused_and_null_occupy_expired_does_not(db, seeded_db, status, occupies):
    """A paused sponsor is still paying — its slot is taken (LU-F7)."""
    from app.models import Category, Supplier
    from app.models.sponsor import Sponsor, exclusive_occupant_clause

    # The seeded child already holds a NULL-status Gold; use a fresh child.
    child = Category(
        id=uuid.uuid4(),
        name="Oscillators",
        slug="oscillators-r16",
        parent_id=seeded_db["parent"].id,
        sort_order=9,
    )
    supplier = Supplier(id=uuid.uuid4(), name="R16 Co")
    db.add_all([child, supplier])
    db.flush()
    row = Sponsor(supplier_id=supplier.id, category_id=child.id, tier="Gold", status=status)
    db.add(row)
    db.flush()
    hit = db.query(Sponsor).filter(Sponsor.id == row.id, exclusive_occupant_clause()).first()
    assert (hit is not None) is occupies
