"""P3 push-sync: users.mail_sync_pending drift flag

Phase P3 of ``docs/superpowers/specs/2026-07-31-mail-server-and-auth-design.md``
— one password opens the site and the mailbox. The site derives the
SHA512-crypt hash and pushes it to the mail box at every password-set moment;
the site's own write must succeed even when the mail box is unreachable, so the
failure has to be RECORDED somewhere instead of thrown away.

``users.mail_sync_pending`` (BOOLEAN NOT NULL DEFAULT false) is that record:
true means "this account's site password changed but its mailbox did not get
it". ``app/services/mail_sync.py`` sets it on a failed push, the user's next
successful login retries and clears it (login is the one other moment the
plaintext is legitimately in memory), and ``/api/auth/me`` surfaces it. Silent
drift — site and mail disagreeing with nobody knowing — is the specific failure
this column exists to prevent.

No backfill. Every existing row is false, which is the truth on the day this
lands: the mail box does not exist yet, so nothing is behind. Marking rows true
pre-emptively would flag five accounts as broken before there is anything for
them to be out of sync with.

Idempotent (``ADD COLUMN IF NOT EXISTS`` / ``DROP COLUMN IF EXISTS``) for the
same reason 022 is: ``alembic/env.py`` sets no ``transaction_per_migration``, so
a failure anywhere in an ``upgrade head`` run leaves the api entrypoint
replaying this file from the top on the next container start. A migration that
dies on "column already exists" crash-loops the api with ``/api/*`` at 502 until
someone hand-edits ``alembic_version`` on the box.

SQLite test note: the suite builds tables with ``Base.metadata.create_all``
(tests/conftest.py) and never runs migrations, so the column is declared on the
``User`` model too — that is what tests actually exercise. See
``tests/test_mail_sync.py``.

Revision ID: 023
Revises: 022
Create Date: 2026-07-31
"""

from alembic import op

revision = "023"
down_revision = "022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Raw SQL, not op.add_column: only ADD COLUMN has an IF NOT EXISTS form.
    op.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS mail_sync_pending "
        "BOOLEAN NOT NULL DEFAULT false"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS mail_sync_pending")
