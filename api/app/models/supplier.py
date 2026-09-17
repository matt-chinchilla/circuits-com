import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, String, Text, false, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class Supplier(Base):
    __tablename__ = "suppliers"
    __table_args__ = (
        Index(
            "uq_suppliers_manufacturer",
            "manufacturer_id",
            unique=True,
            postgresql_where=text("manufacturer_id IS NOT NULL"),
            sqlite_where=text("manufacturer_id IS NOT NULL"),
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(200), nullable=False)
    # Bridge to the manufacturers universe (2026-08-20 Leads CRM). The FK
    # points INTO manufacturers so --reseed's TRUNCATE suppliers CASCADE can
    # never touch a manufacturer row. Partial-unique: one company cannot fork
    # into two supplier links. MUST stay out of supplier_to_dict AND
    # SupplierResponse (test_admin_manufacturers guards it).
    manufacturer_id = Column(
        UUID(as_uuid=True),
        ForeignKey("manufacturers.id", ondelete="SET NULL"),
        nullable=True,
    )
    phone = Column(String(20))
    website = Column(String(200))
    email = Column(String(200))
    contact_name = Column(String(120), nullable=True)
    description = Column(Text, nullable=True)
    logo_url = Column(Text, nullable=True)
    # Sponsor-board fields (migration 014, 2026-06-11 tier boards). Rendered on
    # the Platinum/Gold/Silver boards; all nullable (CsFx falls back to the
    # locked platinum palette when brand colors are absent).
    contact_role = Column(String(120), nullable=True)
    coverage_hours = Column(String(60), nullable=True)
    brand_primary = Column(String(9), nullable=True)
    brand_secondary = Column(String(9), nullable=True)
    # Founding-distributor incentive flag (migration 054, owner 2026-09-17).
    # Owner's rule, verbatim: "It will be a boolean that will remain `True`
    # until the monthly-income we get from sponsors is over $5,000/month OR
    # until I decide. This will be `False` for every single supplier in the
    # DataBase right now because none of them are paying-customers yet."
    # NOTHING automates that sunset yet — it is set by hand in /admin, and the
    # $5,000/month trigger is a later decision. PER-ENVIRONMENT operational
    # state, not catalog data: both halves of the catalog transfer skip it
    # (test_catalog_transfer_scripts) so a `circuits push` from a local DB
    # cannot clobber prod's flags.
    founder = Column(Boolean, nullable=False, default=False, server_default=false())
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
