import uuid
from sqlalchemy import Column, String, Text, ForeignKey, CheckConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from app.db.session import Base


class Sponsor(Base):
    __tablename__ = "sponsors"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    supplier_id = Column(UUID(as_uuid=True), ForeignKey("suppliers.id"), nullable=False)
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id"), nullable=True)
    keyword = Column(String(100), nullable=True)
    image_url = Column(String(500), nullable=True)
    description = Column(Text, nullable=True)
    tier = Column(String(10), default="gold")

    __table_args__ = (
        CheckConstraint(
            "(category_id IS NOT NULL AND keyword IS NULL) OR (category_id IS NULL AND keyword IS NOT NULL)",
            name="sponsor_category_or_keyword",
        ),
    )

    supplier = relationship("Supplier")
    category = relationship("Category")
