"""Add messages table — inbound communications hub

Revision ID: 004
Revises: 003
Create Date: 2026-05-14

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "messages",
        sa.Column("id", sa.String(36), primary_key=True, nullable=False),
        sa.Column("type", sa.String(20), nullable=False),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="new",
        ),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("assigned_to", sa.String(10), nullable=True),
        sa.Column("spam_score", sa.Float(), nullable=True),
        sa.Column("last_reply_body", sa.Text(), nullable=True),
        sa.UniqueConstraint("seq", name="uq_messages_seq"),
    )
    op.create_index("ix_messages_seq", "messages", ["seq"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_messages_seq", table_name="messages")
    op.drop_table("messages")
