"""The supplier-sync activity stream — one row per thing that happened.

The sync route appends an event as it works (a part imported, a listing
refreshed, a run started) and the admin dashboard's Recent Activity reads the
newest rows back. That is the whole contract: **append-only, newest-first**,
which is why ``created_at`` carries the index and why nothing here is mutable.

Two decisions worth keeping:

``supplier_id`` is a NULLABLE foreign key, and the supplier cascade in
``routes/suppliers.py`` NULLs it rather than deleting the row — the same call
``User.supplier_id`` makes. An event is a record of something that actually
happened; it stays true after the company row is gone, and a feed that
retroactively rewrites itself when a supplier is removed is worse than one with
an unattributed line in it.

``created_at`` is stamped by the DATABASE (``server_default=func.now()``) rather
than by the writer. The feed's only ordering is this column, and a caller that
forgets to set it must still land in the right place — including the sync job,
which may write from more than one place.
"""

import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID

from app.db.session import Base


class ActivityEvent(Base):
    __tablename__ = "activity_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # A plain VARCHAR, not a native enum: the event vocabulary grows with every
    # new sync step, and adding a Postgres enum value needs an ALTER TYPE (and
    # values can never be removed). Same call `expenses.category` made.
    kind = Column(String(40), nullable=False)
    # Nullable on purpose — see the module docstring. System events have no
    # supplier at all, and a deleted supplier's events keep their history.
    supplier_id = Column(UUID(as_uuid=True), ForeignKey("suppliers.id"), nullable=True, index=True)
    title = Column(String(255), nullable=False)
    detail = Column(String(500), nullable=True)
    image_url = Column(String(500), nullable=True)
    # index=True declares ix_activity_events_created_at — the feed reads
    # newest-first and nothing else.
    created_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True,
    )
