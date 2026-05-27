import uuid
from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class Category(Base):
    __tablename__ = "categories"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False)
    slug = Column(String(100), unique=True, nullable=False)
    # Widened from String(10) to String(40) on 2026-05-22 to accommodate
    # Phosphor Light icon names (e.g. "arrows-counter-clockwise" = 24 chars,
    # "globe-hemisphere-west" = 21). Old emoji-only column would silently
    # truncate longer names in Postgres. Default flipped from "⚡" to the
    # Phosphor equivalent "lightning". See alembic/versions/005.
    icon = Column(String(40), default="lightning")
    description = Column(Text, nullable=True)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True)
    sort_order = Column(Integer, default=0)
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=True,
    )
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        nullable=True,
    )

    children = relationship("Category", back_populates="parent", lazy="selectin")
    parent = relationship("Category", back_populates="children", remote_side=[id])
    supplier_associations = relationship("CategorySupplier", back_populates="category", lazy="selectin")
