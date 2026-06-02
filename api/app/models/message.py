import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, Column, DateTime, Float, Integer, String, Text

from app.db.session import Base


class Message(Base):
    """Inbound communications hub.

    Stores submissions from public forms (contact / join / keyword) plus
    outbound replies. The discriminated `type` column branches on a
    type-specific `payload` JSON blob — shape mirrors `frontend/src/admin/
    types/messages.ts` (Message union).
    """

    __tablename__ = "messages"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    type = Column(
        String(30), nullable=False
    )  # 'contact'|'join'|'keyword'|'reply'|'sponsor_rep_request'
    status = Column(String(20), nullable=False, default="new")  # new|read|archived|responded
    seq = Column(Integer, unique=True, nullable=False, index=True)  # MSG-#### designator
    payload = Column(JSON, nullable=False)  # type-specific dict
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
    )
    read_at = Column(DateTime(timezone=True), nullable=True)
    responded_at = Column(DateTime(timezone=True), nullable=True)
    assigned_to = Column(String(10), nullable=True)  # 'john' | 'mike' | None
    spam_score = Column(Float, nullable=True)
    last_reply_body = Column(Text, nullable=True)
