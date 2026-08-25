"""Retire the demo account: delete the row, not just the door.

Revision ID: 044
Revises: 043

Registration replaced one-click demo access, so `POST /api/auth/demo` and the
`is_demo_user` read-only gate were removed from the application.

Removing the endpoint is NOT sufficient on its own, and that is the whole point
of this migration. The demo row was seeded with the literal password "demo",
`role = 'admin'` and `must_change_password = false`, and the ONLY thing that
kept those public credentials from working at `POST /api/auth/login` was a
deliberate refusal in `_find_login_user` (`_is_demo_identifier`). Deleting that
refusal without deleting the row would turn a documented, deliberately-public
password into a live administrator login on every environment that already has
the row — a strictly worse position than before the demo was retired.

Every foreign key that references `users` is SET NULL or CASCADE
(`calendar_events.created_by_id`, `bom_shares.user_id`, `messages.user_id`), so
the delete cannot fail on a dependent row: calendar events the demo authored
simply become unattributed.

Idempotent, and safe on an environment that never had the row.
"""
from alembic import op

revision = "044"
down_revision = "043"
branch_labels = None
depends_on = None

# The address is hard-coded rather than read from settings.DEMO_LOGIN_EMAIL
# because that setting is being deleted in the same change, and because no
# migration in this repo imports application code. It is a historical fact, not
# a configuration value.
DEMO_EMAIL = "demo@circuitcenter.ai"


def upgrade() -> None:
    op.execute(f"DELETE FROM users WHERE lower(email) = '{DEMO_EMAIL}'")


def downgrade() -> None:
    # Deliberately empty. The row held a bcrypt hash of a public password; it
    # is not something to restore, and re-creating it would re-open the hole
    # this migration exists to close. Reverting the feature means reverting the
    # code, which is what brings the door back.
    pass
