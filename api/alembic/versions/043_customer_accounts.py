"""Customer accounts: the 'user' role, verification, activation, capability links.

Revision ID: 043
Revises: 042
"""
import sqlalchemy as sa
from alembic import op

revision = "043"
down_revision = "042"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The value has never been read by any code and no row holds it, so this
    # is free today and a coordinated migration later. RENAME VALUE is
    # transactional on PG 12+, so it rides alembic's own transaction.
    op.execute("ALTER TYPE user_role RENAME VALUE 'company' TO 'user'")
    op.alter_column(
        "users", "role", server_default="user", existing_type=sa.String()
    )
    # username = lower(email) for customers, and email is VARCHAR(255).
    op.alter_column(
        "users",
        "username",
        type_=sa.String(255),
        existing_type=sa.String(100),
        existing_nullable=False,
    )
    op.add_column("users", sa.Column("first_name", sa.String(80), nullable=True))
    op.add_column("users", sa.Column("last_name", sa.String(80), nullable=True))
    op.add_column(
        "users", sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "users", sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("users", sa.Column("signup_ip", sa.String(45), nullable=True))
    op.add_column("users", sa.Column("signup_country", sa.String(2), nullable=True))
    op.add_column(
        "users", sa.Column("manufacturer_id", postgresql_uuid(), nullable=True)
    )
    op.create_foreign_key(
        "fk_users_manufacturer_id", "users", "manufacturers", ["manufacturer_id"], ["id"]
    )
    op.add_column("messages", sa.Column("user_id", postgresql_uuid(), nullable=True))
    op.create_foreign_key(
        "fk_messages_user_id", "messages", "users", ["user_id"], ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_messages_user_id", "messages", ["user_id"])

    # The five staff rows predate verification and activation and must keep
    # working. They are staff, so activated_at is never consulted for them —
    # but stamping verification keeps the column honest rather than leaving
    # rows that look unverified forever.
    op.execute("UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL")


def downgrade() -> None:
    op.drop_index("ix_messages_user_id", table_name="messages")
    op.drop_constraint("fk_messages_user_id", "messages", type_="foreignkey")
    op.drop_column("messages", "user_id")
    op.drop_constraint("fk_users_manufacturer_id", "users", type_="foreignkey")
    for col in (
        "manufacturer_id",
        "signup_country",
        "signup_ip",
        "activated_at",
        "email_verified_at",
        "last_name",
        "first_name",
    ):
        op.drop_column("users", col)
    op.alter_column(
        "users", "username", type_=sa.String(100), existing_type=sa.String(255),
        existing_nullable=False,
    )
    op.execute("ALTER TYPE user_role RENAME VALUE 'user' TO 'company'")
    op.alter_column("users", "role", server_default="company", existing_type=sa.String())


def postgresql_uuid():
    from sqlalchemy.dialects import postgresql

    return postgresql.UUID(as_uuid=True)
