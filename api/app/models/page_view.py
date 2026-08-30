import uuid
from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, Float, String
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
    # City-level detail from the same track-time lookup (migration 048), and
    # forward-only for the same reason: the rows above this migration keep a
    # country and nothing finer, forever. `region` is the subdivision NAME
    # ("New York"), not a code — DB-IP Lite ships no subdivision iso_code.
    # The point is a CITY CENTROID rounded to 2dp (~1.1km), not a visitor's
    # position; the pair is written together or not at all.
    region = Column(String(80), nullable=True)
    city = Column(String(80), nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    # The AS organization behind the address (migration 049), from a SEPARATE
    # DB-IP file that may be absent — so NULL here means either "pre-049" or
    # "no ASN database in this image", and both read the same from a query.
    network = Column(String(120), nullable=True)
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
        index=True,
    )
