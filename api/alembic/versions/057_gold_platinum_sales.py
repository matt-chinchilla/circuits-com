"""Gold & Platinum sales — codes, intents, sponsor billing, payments, audit (2026-09-23).

Revision ID: 057
Revises: 056

Spec `docs/superpowers/specs/2026-09-23-gold-platinum-sales-design.md` §6:

* `sales_codes` — rep discount codes (1–15 points, max uses ≥ 1).
* `checkout_intents` — every Checkout Session minted; an `open` Gold/Platinum row
  is the slot hold, one per category by the partial unique index
  `uq_live_exclusive_intent`.
* `sponsor_billing` — 1:1 beside the sponsor, `ON DELETE CASCADE` (the only new
  foreign key toward `sponsors`). Backfilled for every sponsor that already owns
  a Stripe subscription (today: self-serve Silver).
* `sponsor_payments` — the invoice mirror, keyed by Stripe invoice id.
* `billing_audit` — staff-only, append-only.

Every other new table is FK-free toward sponsors/suppliers/users/categories, so
none of them joins `--reseed`'s TRUNCATE cascade except `sponsor_billing`.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "057"
down_revision = "056"
branch_labels = None
depends_on = None

# Literal on purpose: a migration never imports app code. `app.models.sales`
# declares the same three strings and test_sales_models.py pins them to this
# file's source text.
CODE_POINTS_CHECK = "code_points >= 1 AND code_points <= 15"
MAX_USES_CHECK = "max_uses >= 1"
LIVE_EXCLUSIVE_WHERE = "status = 'open' AND tier IN ('gold','platinum')"

LIVE_EXCLUSIVE_INDEX = (
    "CREATE UNIQUE INDEX uq_live_exclusive_intent ON checkout_intents (category_id) "
    "WHERE status = 'open' AND tier IN ('gold','platinum')"
)

# Every sponsor already owned by a Stripe subscription gets its billing row
# (LU-F9b). Today that is only self-serve Silver, sold at the $250 list.
BACKFILL_BILLING = """
INSERT INTO sponsor_billing (sponsor_id, stripe_subscription_id, collection_method, channel,
                             list_usd, price_usd, card_link_version, void_pending, updated_at)
SELECT s.id, s.stripe_subscription_id, 'charge_automatically', 'self_serve',
       250, COALESCE(s.amount, 250)::int, 0, false, now()
FROM sponsors s
WHERE s.stripe_subscription_id IS NOT NULL
ON CONFLICT (sponsor_id) DO NOTHING
"""


def _uuid():
    return postgresql.UUID(as_uuid=True)


def _ts(name: str, *, nullable: bool = False, now: bool = False) -> sa.Column:
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        nullable=nullable,
        server_default=sa.func.now() if now else None,
    )


def upgrade() -> None:
    op.create_table(
        "sales_codes",
        sa.Column("id", _uuid(), primary_key=True),
        sa.Column("code", sa.String(16), nullable=False, unique=True),
        sa.Column("code_points", sa.SmallInteger(), nullable=False),
        sa.Column("tier", sa.String(10), nullable=True),
        sa.Column("category_id", _uuid(), nullable=True),
        sa.Column("supplier_id", _uuid(), nullable=True),
        sa.Column("email_lock", sa.String(200), nullable=True),
        sa.Column("max_uses", sa.SmallInteger(), nullable=False, server_default="1"),
        sa.Column("uses", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column(
            "expires_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now() + interval '14 days'"),
        ),
        sa.Column("rep", sa.String(120), nullable=False),
        sa.Column("created_by", sa.String(120), nullable=False),
        sa.Column("note", sa.String(500), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        _ts("created_at", now=True),
        sa.CheckConstraint(CODE_POINTS_CHECK, name="ck_sales_codes_points"),
        sa.CheckConstraint(MAX_USES_CHECK, name="ck_sales_codes_max_uses"),
    )

    op.create_table(
        "checkout_intents",
        sa.Column("id", _uuid(), primary_key=True),
        sa.Column("stripe_session_id", sa.String(255), nullable=True, unique=True),
        sa.Column("release_token_hash", sa.String(64), nullable=True),
        sa.Column("tier", sa.String(10), nullable=False),
        sa.Column("category_id", _uuid(), nullable=True),
        sa.Column("keyword", sa.String(100), nullable=True),
        sa.Column("sales_code_id", _uuid(), sa.ForeignKey("sales_codes.id"), nullable=True),
        sa.Column("supplier_id", _uuid(), nullable=True),
        sa.Column("list_usd", sa.Integer(), nullable=False),
        sa.Column("founder_usd", sa.Integer(), nullable=False),
        sa.Column("price_usd", sa.Integer(), nullable=False),
        sa.Column("channel", sa.String(20), nullable=False),
        sa.Column("sold_by", sa.String(120), nullable=True),
        sa.Column("company_name", sa.String(200), nullable=False),
        sa.Column("email", sa.String(200), nullable=False),
        sa.Column("website", sa.String(200), nullable=True),
        sa.Column("client_ip_hash", sa.String(64), nullable=True),
        sa.Column("status", sa.String(12), nullable=False, server_default="open"),
        sa.Column("conflict_reason", sa.String(40), nullable=True),
        _ts("expires_at"),
        _ts("created_at", now=True),
        _ts("resolved_at", nullable=True),
    )
    op.execute(LIVE_EXCLUSIVE_INDEX)
    op.create_index(
        "ix_checkout_intents_status_expires", "checkout_intents", ["status", "expires_at"]
    )

    op.create_table(
        "sponsor_billing",
        sa.Column(
            "sponsor_id",
            _uuid(),
            sa.ForeignKey("sponsors.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("stripe_customer_id", sa.String(64), nullable=True),
        sa.Column("stripe_subscription_id", sa.String(64), nullable=True),
        sa.Column(
            "collection_method",
            sa.String(30),
            nullable=False,
            server_default="charge_automatically",
        ),
        sa.Column("channel", sa.String(20), nullable=False),
        sa.Column("list_usd", sa.Integer(), nullable=False),
        sa.Column("founder_usd", sa.Integer(), nullable=True),
        sa.Column("price_usd", sa.Integer(), nullable=False),
        sa.Column("sales_code_id", _uuid(), sa.ForeignKey("sales_codes.id"), nullable=True),
        _ts("failing_since", nullable=True),
        sa.Column("card_link_version", sa.Integer(), nullable=False, server_default="0"),
        _ts("post_activation_done_at", nullable=True),
        sa.Column("void_pending", sa.Boolean(), nullable=False, server_default=sa.false()),
        _ts("updated_at", now=True),
    )

    op.create_table(
        "sponsor_payments",
        sa.Column("id", _uuid(), primary_key=True),
        sa.Column("stripe_invoice_id", sa.String(64), nullable=False, unique=True),
        sa.Column("stripe_subscription_id", sa.String(64), nullable=False),
        sa.Column("sponsor_id", _uuid(), nullable=True),
        sa.Column("stripe_payment_intent_id", sa.String(64), nullable=True),
        sa.Column("amount_due_cents", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("amount_paid_cents", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("amount_refunded_cents", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(20), nullable=False),
        _ts("invoice_created_at", nullable=True),
        _ts("paid_at", nullable=True),
        sa.Column("hosted_invoice_url", sa.Text(), nullable=True),
        _ts("updated_at", now=True),
    )
    op.create_index(
        "ix_sponsor_payments_stripe_subscription_id",
        "sponsor_payments",
        ["stripe_subscription_id"],
    )
    op.create_index("ix_sponsor_payments_sponsor_id", "sponsor_payments", ["sponsor_id"])

    op.create_table(
        "billing_audit",
        sa.Column("id", _uuid(), primary_key=True),
        _ts("created_at", now=True),
        sa.Column("actor", sa.String(120), nullable=False),
        sa.Column("sponsor_id", _uuid(), nullable=True),
        sa.Column("sales_code_id", _uuid(), nullable=True),
        sa.Column("intent_id", _uuid(), nullable=True),
        sa.Column("action", sa.String(40), nullable=False),
        sa.Column("amount_cents", sa.Integer(), nullable=True),
        sa.Column("detail", sa.String(500), nullable=False, server_default=""),
    )
    op.create_index("ix_billing_audit_created_at", "billing_audit", ["created_at"])
    op.create_index("ix_billing_audit_sponsor_id", "billing_audit", ["sponsor_id"])

    op.execute(BACKFILL_BILLING)


def downgrade() -> None:
    op.drop_table("billing_audit")
    op.drop_table("sponsor_payments")
    op.drop_table("sponsor_billing")
    op.drop_table("checkout_intents")
    op.drop_table("sales_codes")
