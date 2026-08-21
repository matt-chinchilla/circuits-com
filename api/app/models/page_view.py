import uuid
from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, String
from sqlalchemy.dialects.postgresql import UUID

from app.db.session import Base


class PageView(Base):
    __tablename__ = "page_views"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    path = Column(String(500), nullable=False, index=True)
    referrer = Column(String(1000), nullable=True)
    user_agent = Column(String(500), nullable=True)
    session_id = Column(String(64), nullable=False, index=True)
    ip_hash = Column(String(64), nullable=True)
    device_type = Column(String(20), nullable=True)
    browser = Column(String(50), nullable=True)
    # ISO-3166 alpha-2, resolved at track-time from the client IP (migration
    # 040). NULL = unknown: rows written before the column existed (ip_hash
    # is one-way, so history can never be backfilled) or a failed lookup.
    country = Column(String(2), nullable=True)
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
        index=True,
    )
