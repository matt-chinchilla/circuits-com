"""Referral clicks — a visitor leaving us for a distributor's own site.

One row per click on a distributor deep-link from a public part page. This is
the ONLY per-supplier demand signal the site can honestly produce: we do not
see the distributor's basket, so a row here means "somebody we showed this part
to went to buy it from you", and nothing about money. The console panel that
renders it is labelled Referral Clicks for exactly that reason — a click count
captioned as revenue is a claim we cannot stand behind.

RESEED SAFETY — no foreign keys, deliberately. ``supplier_id`` and ``part_id``
are plain UUID columns. ``suppliers`` is a root of deploy.sh --reseed's
``TRUNCATE ... CASCADE``, which is TABLE-level and transitive: a real FK from
here into ``suppliers`` would silently enrol this table in that cascade and a
routine reseed would destroy every recorded click. Validity is enforced at the
ONE write site instead (routes/analytics.record_outbound_click only inserts a
pair an EXISTS on ``part_listings`` confirms), and the census in
tests/test_leads_schema.py is what notices if an FK ever appears.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, Index
from sqlalchemy.dialects.postgresql import UUID

from app.db.session import Base


class OutboundClick(Base):
    __tablename__ = "outbound_clicks"
    # The one query this table exists to answer is "this supplier's clicks over
    # this window", so the index leads with supplier_id and carries the time.
    __table_args__ = (Index("ix_outbound_clicks_supplier_clicked", "supplier_id", "clicked_at"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Nullable because a click is attributed to a SUPPLIER first: the part is
    # the context we happen to have from a part page, and a future surface
    # (a supplier profile link) can record the click without one.
    part_id = Column(UUID(as_uuid=True), nullable=True)
    supplier_id = Column(UUID(as_uuid=True), nullable=False)
    clicked_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
    )
