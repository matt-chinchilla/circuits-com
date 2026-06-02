"""Add 9 sponsor rep-contact columns and widen messages.type for CSB v13.

Adds the sponsor "company-rep" contact block to the sponsors table — the
fields the public CategorySponsorBanner now surfaces (rep name/role/phone/
hours/email/division/partno) plus the brand bits (lettermark, blurb) the
v13 fixed-banner design needs at render time.

Also widens messages.type from String(20) -> String(30) so the new
'sponsor_rep_request' enum value (19 chars) plus headroom fits.

All 9 sponsor columns are nullable with no server_default — backfill is
deferred to the seed-update commit, and legacy sponsor rows are allowed
to render with rep fields collapsed.

Revision ID: 011
Revises: 010
Create Date: 2026-06-01
"""

from alembic import op
import sqlalchemy as sa

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sponsors", sa.Column("contact_name", sa.String(80), nullable=True))
    op.add_column("sponsors", sa.Column("role", sa.String(80), nullable=True))
    op.add_column("sponsors", sa.Column("phone", sa.String(40), nullable=True))
    op.add_column("sponsors", sa.Column("hours", sa.String(60), nullable=True))
    op.add_column("sponsors", sa.Column("email", sa.String(120), nullable=True))
    op.add_column("sponsors", sa.Column("division", sa.String(80), nullable=True))
    op.add_column("sponsors", sa.Column("partno", sa.String(60), nullable=True))
    op.add_column("sponsors", sa.Column("lettermark", sa.String(8), nullable=True))
    op.add_column("sponsors", sa.Column("blurb", sa.String(160), nullable=True))

    op.alter_column(
        "messages",
        "type",
        existing_type=sa.String(20),
        type_=sa.String(30),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "messages",
        "type",
        existing_type=sa.String(30),
        type_=sa.String(20),
        existing_nullable=False,
    )

    op.drop_column("sponsors", "blurb")
    op.drop_column("sponsors", "lettermark")
    op.drop_column("sponsors", "partno")
    op.drop_column("sponsors", "division")
    op.drop_column("sponsors", "email")
    op.drop_column("sponsors", "hours")
    op.drop_column("sponsors", "phone")
    op.drop_column("sponsors", "role")
    op.drop_column("sponsors", "contact_name")
