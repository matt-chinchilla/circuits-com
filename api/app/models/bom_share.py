"""Opt-in BOM share links (spec §7.5).

The ONLY path any BOM content reaches the server — created by an explicit
button, so unlike /api/bom/match the payload MAY carry quantities and
designators. user_id is the future-accounts seam (D3): nullable, unwritten
today; accounts will claim shares by UPDATE, no migration needed.
"""

from datetime import UTC, datetime

from sqlalchemy import JSON, Column, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.db.session import Base


class BomShare(Base):
    __tablename__ = "bom_shares"

    slug = Column(String(32), primary_key=True)
    payload = Column(JSON().with_variant(JSONB(), "postgresql"), nullable=False)
    user_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at = Column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )
    expires_at = Column(DateTime(timezone=True), nullable=False)
