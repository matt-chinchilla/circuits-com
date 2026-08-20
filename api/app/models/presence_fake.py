from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, DateTime, SmallInteger

from app.db.session import Base


class PresenceFake(Base):
    """Singleton row driving the `circuits --fakeuser` lever.

    `admin_presence.presence_ping` unions `count` synthetic entries from
    FAKE_PRESENCE_ROSTER into the topbar presence pill. DB-backed for the same
    reason presence itself is (prod runs multi-worker uvicorn — an in-process
    value would flicker per worker, the exact 2026-07-31 bug class). The app
    only ever READS this row; writes come from scripts/fakeuser.sh via psql.
    The CHECKs are enforced on BOTH engines (verified in tests) — the route's
    clamp is a second line, not the only one.
    """

    __tablename__ = "presence_fakes"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_presence_fakes_singleton"),
        CheckConstraint("count >= 0 AND count <= 10", name="ck_presence_fakes_range"),
    )

    id = Column(SmallInteger, primary_key=True, default=1)
    count = Column(SmallInteger, nullable=False, default=0)
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        nullable=True,
    )
