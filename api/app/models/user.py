import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Enum, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    username = Column(String(100), unique=True, nullable=False)
    # Recovery address for forgot-password / forgot-username. Nullable: legacy
    # admin rows and the demo user may omit it. Indexed for the case-insensitive
    # lookup in the recovery routes. (alembic 015)
    email = Column(String(255), nullable=True, index=True)
    password_hash = Column(String(200), nullable=False)
    role = Column(
        Enum("admin", "company", name="user_role", create_constraint=True),
        nullable=False,
        default="company",
    )
    supplier_id = Column(
        UUID(as_uuid=True), ForeignKey("suppliers.id"), nullable=True
    )
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    supplier = relationship("Supplier")
