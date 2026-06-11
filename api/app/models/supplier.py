import uuid
from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class Supplier(Base):
    __tablename__ = "suppliers"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(200), nullable=False)
    phone = Column(String(20))
    website = Column(String(200))
    email = Column(String(200))
    contact_name = Column(String(120), nullable=True)
    description = Column(Text, nullable=True)
    logo_url = Column(String(500), nullable=True)
    # Sponsor-board fields (migration 014, 2026-06-11 tier boards). Rendered on
    # the Platinum/Gold/Silver boards; all nullable (CsFx falls back to the
    # locked platinum palette when brand colors are absent).
    contact_role = Column(String(120), nullable=True)
    coverage_hours = Column(String(60), nullable=True)
    brand_primary = Column(String(9), nullable=True)
    brand_secondary = Column(String(9), nullable=True)
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

    category_associations = relationship("CategorySupplier", back_populates="supplier", lazy="selectin")


class CategorySupplier(Base):
    __tablename__ = "category_suppliers"

    # Pure association: "this distributor carries parts in this category" (powers
    # the Top Distributors list). Featured/sponsored status lives ONLY in the
    # `sponsors` table now (2026-06-03 single-source-of-truth). is_featured/rank
    # were dropped — see migration 011.
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id"), primary_key=True)
    supplier_id = Column(UUID(as_uuid=True), ForeignKey("suppliers.id"), primary_key=True)

    category = relationship("Category", back_populates="supplier_associations")
    supplier = relationship("Supplier", back_populates="category_associations")
