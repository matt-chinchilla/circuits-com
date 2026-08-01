"""users: last + previous sign-in stamps

The admin Settings page has always shown a "Last sign-in" line, but it was a
hardcoded string in the TSX (``2026-04-25 08:42 EDT``, ``from 73.142.18.4``)
next to an equally invented account email. Nothing in the schema could back it:
``last_seen_at`` (021) is the console presence heartbeat — "active right now",
which is a different question — and ``password_changed_at`` (022) only moves on
a password change.

FOUR columns, not two, because the useful reading of "last sign-in" is the one
BEFORE your current session. Showing a person that they signed in four seconds
ago tells them nothing; showing them the previous sign-in — with its address —
is what lets someone notice a session that was not theirs. So each successful
login SHIFTS ``last_*`` into ``prev_*`` and stamps itself into ``last_*``, and
the console renders the ``prev_*`` pair. Deriving that from a single pair is not
possible once the current login has overwritten it, and a reloaded tab has to
survive on what the database holds, not on what the login response happened to
carry.

VARCHAR(45) on the address columns: 45 is the longest possible IPv6 text form
(an IPv4-mapped address such as ``0000:...:ffff:255.255.255.255``). Nullable
throughout — NULL means "never recorded", which is the honest state for every
existing row and for a first-ever sign-in, and the console says so rather than
printing a zero date.

The address is written from ``rate_limit.client_ip``, which reads ``X-Real-IP``
(nginx overwrites it with ``$remote_addr``) rather than the caller-supplied
``X-Forwarded-For``. Recording a spoofable value would make this line worse than
useless: it would be evidence pointing wherever an attacker chose.

No backfill. There is no record of anyone's previous sign-in to recover, and
inventing one would re-create the exact problem this replaces.

Idempotent (``ADD COLUMN IF NOT EXISTS``) for the same reason as 022/023:
``alembic/env.py`` sets no ``transaction_per_migration``, so a failure partway
through ``upgrade head`` leaves the api entrypoint replaying this file on the
next container start, and a migration that dies on "column already exists"
crash-loops the api with ``/api/*`` at 502.

SQLite test note: the suite builds tables with ``Base.metadata.create_all`` and
never runs migrations, so these are declared on the ``User`` model too — that is
what the tests exercise. See ``tests/test_login_history.py``.

Revision ID: 024
Revises: 023
Create Date: 2026-08-01
"""

from alembic import op

revision = "024"
down_revision = "023"
branch_labels = None
depends_on = None


_COLUMNS = (
    ("last_login_at", "TIMESTAMPTZ"),
    ("last_login_ip", "VARCHAR(45)"),
    ("prev_login_at", "TIMESTAMPTZ"),
    ("prev_login_ip", "VARCHAR(45)"),
)


def upgrade() -> None:
    # Raw SQL, not op.add_column: only ADD COLUMN has an IF NOT EXISTS form.
    for name, ddl_type in _COLUMNS:
        op.execute(f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {name} {ddl_type}")


def downgrade() -> None:
    for name, _ in _COLUMNS:
        op.execute(f"ALTER TABLE users DROP COLUMN IF EXISTS {name}")
