"""Per-supplier feed configuration — one row per supplier that has a feed.

Today this table answers one question: **may the nightly import run for this
supplier?** The admin's "Nightly auto-import" switch writes
``auto_import_enabled`` and the job's selection query reads it, alongside the
provider match and the key the run would actually use.

``feed_url`` and ``api_key`` are SCHEMA-ONLY for now, deliberately. The
partner-feed phase gives a distributor its own inventory URL and its own
credential; building the shape once, in the migration that creates the table,
is cheaper than a second migration against a table that will by then have
production rows. **Nothing returns ``api_key`` to a client, ever** (the
endpoints answer with provider/key_configured/auto_import_enabled and no value
from this row). ``last_synced_at`` IS live: the nightly job stamps it after
each supplier's run — it means "calls were spent on this supplier that night",
not "the run succeeded" (a quota wall mid-run still stamps).

``import_cursor`` is the import sweep's own bookkeeping: a JSON map of
``{category_slug: next_start_at}`` recording how deep into each category's
search results this supplier's imports have already read. ``-1`` means that
category is EXHAUSTED (a sweep returned fewer raw rows than it asked for) and
is skipped until every category is exhausted, at which point ``grow_catalog``
clears the whole map and sweeps again from the top. Written ONLY by
``grow_catalog`` (one write per category, its own commit); resetting it by
hand is ``UPDATE supplier_feeds SET import_cursor = NULL``.

``key_configured`` on the endpoints is NOT this column: it is
``registry.get_feed_key`` — the Admin → Settings row, else the environment —
because that is the credential a run would present today.

``supplier_id`` IS the primary key. A supplier has exactly one feed
configuration, so a surrogate id would only create room for two rows to
disagree about whether the nightly job runs. The foreign key carries NO
``ON DELETE CASCADE``: the supplier delete route removes this row explicitly,
like every other dependent it owns, and a database cascade would hide a
forgotten step there instead of failing on it.

``updated_at`` is stamped by the DATABASE on insert and on update — "when was
this last changed" must stay true for a writer that forgets to set it.
"""

from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID

from app.db.session import Base


class SupplierFeed(Base):
    __tablename__ = "supplier_feeds"

    supplier_id = Column(UUID(as_uuid=True), ForeignKey("suppliers.id"), primary_key=True)
    # Phase-A partner-feed columns (these two): written by nothing yet,
    # returned by nothing ever. See the module docstring.
    feed_url = Column(String(500), nullable=True)
    api_key = Column(Text, nullable=True)
    # Default OFF in Python AND in the DDL: a row written with nothing but a
    # supplier id must not enable a nightly job by accident.
    auto_import_enabled = Column(Boolean, nullable=False, default=False)
    last_synced_at = Column(DateTime(timezone=True), nullable=True)
    # {category_slug: next start_at}, -1 = exhausted. `sa.JSON`, not JSONB:
    # the suite builds on SQLite via create_all, and nothing queries INTO the
    # value — it is read whole, per supplier.
    import_cursor = Column(JSON, nullable=True)
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
