import uuid
from sqlalchemy import Column, String, Text, Boolean, Integer, ForeignKey
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
    description = Column(Text, nullable=True)
    logo_url = Column(String(500), nullable=True)

    category_associations = relationship("CategorySupplier", back_populates="supplier", lazy="selectin")


class CategorySupplier(Base):
    __tablename__ = "category_suppliers"

    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id"), primary_key=True)
    supplier_id = Column(UUID(as_uuid=True), ForeignKey("suppliers.id"), primary_key=True)
    is_featured = Column(Boolean, default=False)
    rank = Column(Integer, default=0)

    category = relationship("Category", back_populates="supplier_associations")
    supplier = relationship("Supplier", back_populates="category_associations")
