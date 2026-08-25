# Customer Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the people who pay Circuit Center an account they can sign up for, verify, and sign into — and put a real wall between them and staff-only tooling before that door opens.

**Architecture:** Public `POST /api/auth/signup` creates a `users` row with the renamed `user` role, unverified and unactivated. An emailed link verifies the mailbox (a POST the SPA performs, never a GET on the link). Staff then *activate* the account from `/admin/users`. The existing admin console is extracted into one `<ConsoleRoutes />` component mounted twice — at `/admin` for staff and `/account` for customers — so there is no second frontend tree. Authorization in this project is a single gate (`activated_at`), not per-query filtering; that is a deliberate, recorded owner decision (D16/D17).

**Tech Stack:** FastAPI · SQLAlchemy 2 · Alembic · PyJWT · bcrypt · aiosmtplib · pytest · React 19 · TypeScript · Vite · SCSS Modules · vitest

**Spec:** `docs/superpowers/specs/2026-08-25-customer-registration-design.md`
**Companion:** `docs/superpowers/specs/2026-08-25-account-console-surface-map.md` (Project 2 vision; read for why D18 exists)

## Global Constraints

- **Branch:** `updates`. Never commit to `master`. Commit after every task.
- **Migration:** head is `042`; this feature is `043`, `down_revision = "042"`.
- **Password policy has TWO mirrored homes** — `api/app/services/password_policy.py` and `frontend/src/admin/services/passwordPolicy.ts`. Do not edit either; only consume them.
- **Anti-enumeration stays intact everywhere except signup.** Signup returns an explicit `409 email_taken` (owner decision D5). Login, forgot-password, resend-verification all keep their generic responses.
- **Verification never mints a session.** Corporate mail scanners prefetch URLs.
- **Emails:** verification, welcome and activation are `multipart/alternative` (HTML + plain-text part). Every other email in the codebase stays plain text.
- **Email links use `settings.APP_BASE_URL`**, never `request.base_url` (host poisoning).
- **`users.supplier_id` and `users.manufacturer_id` are STAFF-SET ONLY.** No request body may ever set them.
- **TS strict:** remove unused vars, do not prefix with `_`. Type-gate is `npx tsc -b`, never `tsc --noEmit` (a no-op in this repo).
- **Python:** ruff line length 100, py312, `E/F/W/I/UP/B`.
- **Test DB is SQLite** via `Base.metadata.create_all`. `Enum(..., create_constraint=True)` renders a CHECK there, so renaming the enum value breaks fixtures at flush.
- **THREE unrelated things are called "demo". Only the first is being removed.**
  1. The demo **account** — `demo@circuitcenter.ai`, `POST /api/auth/demo`, `is_demo_user`, the read-only gate, `demo_messages.py`. **Retired in Task 1a.**
  2. **DEMO DATA mode** — `DemoContext`/`useDemo`, `DEMO_BADGES`, `localStorage.admin_demo_mode`. A display toggle **any admin can flip**, default ON. **KEEP IT.** It is only *locked* for the demo account; removing it would strip synthetic figures out of the dashboard for everyone.
  3. The **wizard's** markers — `DEMO_SUPPLIER_NAME` ('Demo Components Inc.'), `DEMO-` SKU prefix, `wizard/demoCleanup.ts`, `wizard/demoMarkers.ts`. The guard that makes real catalog data undeletable by construction. **KEEP IT.** Unrelated.
- **Run backend tests:** `cd api && pytest tests/ -q`. **Frontend:** `cd frontend && npx tsc -b && npm test`.

---

## File Structure

**Backend — created**

| File | Responsibility |
|---|---|
| `api/alembic/versions/043_customer_accounts.py` | The whole schema change, one revision |
| `api/app/routes/admin_users.py` | `/api/admin/users` — list, activate, link, delete |
| `api/app/routes/account.py` | `/api/account/me` and `DELETE /api/account/me` only |
| `api/app/services/account_tier.py` | D3 tier derivation, single home |
| `api/tests/test_signup.py`, `test_email_verification.py`, `test_account_activation.py`, `test_signup_rate_limit.py`, `test_forgot_password_skips_unverified.py`, `test_account_deletion.py`, `test_staff_wall.py`, `test_account_tier.py`, `test_every_route_is_gated.py` | One file per behaviour |

**Backend — modified:** `models/user.py`, `models/message.py`, `models/roles.py`, `routes/auth.py`, `services/auth_service.py`, `services/rate_limit.py`, `services/email.py`, `services/demo_messages.py`, `main.py`, and every admin router (one-line dependency).

**Frontend — created:** `admin/pages/login/screens/SignUp.tsx`, `admin/pages/verify/index.tsx`, `admin/routes/ConsoleRoutes.tsx`, `admin/pages/users/list/index.tsx`, `admin/pages/settings/DangerZone.tsx`.

**Frontend — modified:** `login/screens/types.ts`, `login/index.tsx`, `login/screens/SignIn.tsx`, `login/LoginPage.module.scss`, `contexts/AuthContext.tsx`, `components/ProtectedRoute.tsx`, `services/adminApi.ts`, `App.tsx`, `types/messages.ts`, `components/messages/*`.

---

## Task 1: Migration 043 and the model changes

**Files:**
- Create: `api/alembic/versions/043_customer_accounts.py`
- Modify: `api/app/models/user.py`, `api/app/models/message.py`
- Modify (fixtures broken by the enum rename): `api/tests/conftest.py:291-295`, `api/tests/test_auth.py:24,104`, `api/tests/test_models.py:49,71`
- Test: `api/tests/test_customer_account_schema.py`

**Interfaces:**
- Produces: `User.first_name`, `User.last_name`, `User.email_verified_at`, `User.activated_at`, `User.signup_ip`, `User.signup_country`, `User.manufacturer_id`; role enum value `"user"`; `Message.user_id`.

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_customer_account_schema.py`:

```python
"""The 043 schema, asserted on metadata.

SQLite ignores VARCHAR lengths, so length contracts are asserted on the
column type rather than by inserting an over-long value.
"""
from app.models import Message, User


def test_role_enum_has_user_not_company():
    values = set(User.__table__.c.role.type.enums)
    assert values == {"admin", "user", "owner"}
    assert User.__table__.c.role.default.arg == "user"


def test_username_is_wide_enough_for_an_email():
    # username = lower(email) for customers; email is String(255).
    assert User.__table__.c.username.type.length >= 255
    assert User.__table__.c.username.nullable is False


def test_new_user_columns_exist_and_are_nullable():
    cols = User.__table__.c
    for name in (
        "first_name",
        "last_name",
        "email_verified_at",
        "activated_at",
        "signup_ip",
        "signup_country",
        "manufacturer_id",
    ):
        assert name in cols, f"missing column {name}"
        assert cols[name].nullable is True, f"{name} must be nullable"


def test_verified_and_activated_are_distinct_columns():
    # D17: proving mailbox control is not the same as staff approval.
    assert "email_verified_at" in User.__table__.c
    assert "activated_at" in User.__table__.c


def test_messages_carry_an_optional_owner():
    col = Message.__table__.c.user_id
    assert col.nullable is True  # NULL = the shared staff inbox
    assert [fk.column.table.name for fk in col.foreign_keys] == ["users"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_customer_account_schema.py -q`
Expected: FAIL — `AssertionError` on the enum set (it is still `{"admin","company","owner"}`).

- [ ] **Step 3: Update the models**

In `api/app/models/user.py`, change the role column and add the new ones:

```python
    role = Column(
        Enum("admin", "user", "owner", name="user_role", create_constraint=True),
        nullable=False,
        default="user",
    )
    # Customers sign up with a name, not a username (D7): username is
    # lower(email) for them, so it must hold an address.
    username = Column(String(255), unique=True, nullable=False)
    first_name = Column(String(80), nullable=True)
    last_name = Column(String(80), nullable=True)
    # NULL = the mailbox has not been proved. Set by POST /api/auth/verify.
    email_verified_at = Column(DateTime(timezone=True), nullable=True)
    # NULL = awaiting staff approval (D17). NOT the same as verification:
    # verified means "they own that mailbox", activated means "we said yes".
    # Only consulted for CUSTOMER_ROLES — staff are never gated on it.
    activated_at = Column(DateTime(timezone=True), nullable=True)
    signup_ip = Column(String(45), nullable=True)  # longest IPv6 text form
    signup_country = Column(String(2), nullable=True)  # ISO alpha-2, DB-IP
    # D18: capability is the LINKS, not a type enum. Neither = free;
    # supplier_id = distributor; manufacturer_id = maker; BOTH = a company
    # that does both (Avnet). Staff-set only — no request body sets these.
    manufacturer_id = Column(
        UUID(as_uuid=True), ForeignKey("manufacturers.id"), nullable=True
    )
```

In `api/app/models/message.py`, add the owner column:

```python
    # NULL = the shared staff inbox, which is every pre-043 row and every
    # public form submission. Populated = that one customer's inbox.
    user_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
```

`message.py` needs `from sqlalchemy import ForeignKey` and
`from sqlalchemy.dialects.postgresql import UUID` added to its imports.

- [ ] **Step 4: Write the migration**

Create `api/alembic/versions/043_customer_accounts.py`:

```python
"""Customer accounts: the 'user' role, verification, activation, capability links.

Revision ID: 043
Revises: 042
"""
import sqlalchemy as sa
from alembic import op

revision = "043"
down_revision = "042"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The value has never been read by any code and no row holds it, so this
    # is free today and a coordinated migration later. RENAME VALUE is
    # transactional on PG 12+, so it rides alembic's own transaction.
    op.execute("ALTER TYPE user_role RENAME VALUE 'company' TO 'user'")
    op.alter_column(
        "users", "role", server_default="user", existing_type=sa.String()
    )
    # username = lower(email) for customers, and email is VARCHAR(255).
    op.alter_column(
        "users",
        "username",
        type_=sa.String(255),
        existing_type=sa.String(100),
        existing_nullable=False,
    )
    op.add_column("users", sa.Column("first_name", sa.String(80), nullable=True))
    op.add_column("users", sa.Column("last_name", sa.String(80), nullable=True))
    op.add_column(
        "users", sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "users", sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("users", sa.Column("signup_ip", sa.String(45), nullable=True))
    op.add_column("users", sa.Column("signup_country", sa.String(2), nullable=True))
    op.add_column(
        "users", sa.Column("manufacturer_id", postgresql_uuid(), nullable=True)
    )
    op.create_foreign_key(
        "fk_users_manufacturer_id", "users", "manufacturers", ["manufacturer_id"], ["id"]
    )
    op.add_column("messages", sa.Column("user_id", postgresql_uuid(), nullable=True))
    op.create_foreign_key(
        "fk_messages_user_id", "messages", "users", ["user_id"], ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_messages_user_id", "messages", ["user_id"])

    # The five staff rows predate verification and activation and must keep
    # working. They are staff, so activated_at is never consulted for them —
    # but stamping verification keeps the column honest rather than leaving
    # rows that look unverified forever.
    op.execute("UPDATE users SET email_verified_at = now() WHERE email_verified_at IS NULL")


def downgrade() -> None:
    op.drop_index("ix_messages_user_id", table_name="messages")
    op.drop_constraint("fk_messages_user_id", "messages", type_="foreignkey")
    op.drop_column("messages", "user_id")
    op.drop_constraint("fk_users_manufacturer_id", "users", type_="foreignkey")
    for col in (
        "manufacturer_id",
        "signup_country",
        "signup_ip",
        "activated_at",
        "email_verified_at",
        "last_name",
        "first_name",
    ):
        op.drop_column("users", col)
    op.alter_column(
        "users", "username", type_=sa.String(100), existing_type=sa.String(255),
        existing_nullable=False,
    )
    op.execute("ALTER TYPE user_role RENAME VALUE 'user' TO 'company'")
    op.alter_column("users", "role", server_default="company", existing_type=sa.String())


def postgresql_uuid():
    from sqlalchemy.dialects import postgresql

    return postgresql.UUID(as_uuid=True)
```

- [ ] **Step 5: Fix the three fixtures the rename breaks**

In `api/tests/conftest.py` around line 291-295, change `role="company"` to `role="user"`.
In `api/tests/test_auth.py`, rename `test_login_company_user` → `test_login_customer_user` and `test_me_company_user` → `test_me_customer_user`, changing both `"company"` literals to `"user"`.
In `api/tests/test_models.py:49`, change the default-role assertion to `"user"`; at line 71 change `role="company"` to `role="user"`.

**DO NOT TOUCH `api/tests/test_auth_hardening.py:54,61`.** It recreates the *pre-022* enum `('admin','company')` in raw SQL deliberately, to test the migration path. Renaming it there deletes the thing it tests.

- [ ] **Step 6: Run the tests**

Run: `cd api && pytest tests/test_customer_account_schema.py tests/test_auth.py tests/test_models.py tests/test_auth_hardening.py -q`
Expected: PASS, all four files.

- [ ] **Step 7: Run the whole suite to catch other 'company' fixtures**

Run: `cd api && pytest tests/ -q`
Expected: PASS. If anything fails on a role CHECK constraint, it is another fixture using the old value — change it to `"user"`.

- [ ] **Step 8: Verify the migration runs against real Postgres**

Run: `docker compose up -d --build api && docker compose logs api --tail 40`
Expected: log shows alembic reaching `043` with no error, then `Seeding database...`.

- [ ] **Step 9: Commit**

```bash
git add api/alembic/versions/043_customer_accounts.py api/app/models/ api/tests/
git commit -m "feat(auth): migration 043 — the 'user' role, verification, activation, capability links"
```

---

## Task 1a: Retire the demo account

**Do this BEFORE Tasks 3, 11, 12, 13 and 16** — each of them is written against
a codebase where the demo no longer exists. Doing it after means writing demo
guards and then deleting them.

**Files:**
- Delete: `api/app/services/demo_messages.py`, `api/tests/test_demo_read_only.py`, `frontend/src/admin/components/DemoReadOnlyNotice.tsx`, `frontend/src/admin/services/demoReadOnly.ts`, `frontend/src/admin/services/demoReadOnly.test.ts`
- Modify (backend): `config.py`, `services/auth_service.py`, `routes/auth.py`, `routes/admin_leads.py`, `routes/admin_messages.py`, `routes/admin_quotes.py`, `routes/calendar.py`, `routes/feed_credentials.py`, `routes/suppliers.py`, `db/seed.py`, `docker-compose.yml`, `docker-compose.prod.yml`
- Modify (frontend): `contexts/AuthContext.tsx`, `contexts/DemoContext.tsx`, `services/adminApi.ts`, `services/apiError.ts`, `services/permissions.ts`, `services/messageStore.ts`, `services/syncStream.ts`, `types/admin.ts`, `components/AdminLayout.tsx`, `components/AdminLayout.module.scss`, `pages/login/screens/SignIn.tsx`, `pages/manufacturers/CatalogSwitch.tsx`, `pages/messages/list/index.tsx`, `pages/dashboard/components/SalesRepsPanel.tsx`, `pages/suppliers/detail/NightlyImportToggle.tsx`
- Modify (tests): every file listed in Step 2's grep output
- Test: `api/tests/test_demo_is_retired.py`

**DO NOT TOUCH — these are different features that merely share the word:**
- `frontend/src/admin/contexts/DemoContext.tsx`'s **`demoMode` / `toggleDemo`** — an admin-flippable display toggle. Only its `demoLocked` field goes.
- `frontend/src/admin/wizard/demoCleanup.ts`, `demoMarkers.ts`, `flows.tsx` — the wizard's `Demo Components Inc.` / `DEMO-` markers.
- `SEED_DEMO_CATALOG` and `_DEMO_CATALOG` in `db/seed.py` — the fictional-supplier flag.

**Interfaces:**
- Removes: `POST /api/auth/demo`, `auth_service.is_demo_user`, `DEMO_READ_ONLY_DETAIL`, `DEMO_WRITE_EXEMPT_PATHS`, `demo_login_email`, `_is_demo_identifier`, `settings.DEMO_LOGIN_ENABLED`, `settings.DEMO_LOGIN_EMAIL`, `adminApi.demoLogin`, `AuthContext.loginAsDemo`, `UserInfo.is_demo`.

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_demo_is_retired.py`:

```python
"""The demo account is gone. Registration replaced it.

These assertions are the difference between "removed" and "hidden": a route
that still exists but is undocumented is still a door.
"""
import pathlib

from app.services import auth_service

REPO = pathlib.Path(__file__).resolve().parents[2]


def test_the_demo_endpoint_is_gone(client):
    assert client.post("/api/auth/demo").status_code == 404


def test_the_demo_helpers_are_gone():
    for name in ("is_demo_user", "demo_login_email", "DEMO_READ_ONLY_DETAIL",
                 "DEMO_WRITE_EXEMPT_PATHS"):
        assert not hasattr(auth_service, name), f"{name} still exists"


def test_no_demo_user_is_seeded(seeded_db):
    from app.models import User

    assert seeded_db.query(User).filter(
        User.email == "demo@circuitcenter.ai").count() == 0


def test_the_synthetic_inbox_module_is_deleted():
    assert not (REPO / "api/app/services/demo_messages.py").exists()


def test_the_unrelated_demos_survive():
    # DEMO DATA mode is an admin display toggle, and the wizard's markers are
    # what make real catalog data undeletable. Neither is the demo ACCOUNT.
    assert (REPO / "frontend/src/admin/contexts/DemoContext.tsx").exists()
    assert (REPO / "frontend/src/admin/wizard/demoMarkers.ts").exists()
    seed = (REPO / "api/app/db/seed.py").read_text()
    assert "SEED_DEMO_CATALOG" in seed
```

- [ ] **Step 2: Run test to verify it fails, and take the real inventory**

Run: `cd api && pytest tests/test_demo_is_retired.py -q`
Expected: FAIL — `/api/auth/demo` returns 200.

Then take the exact inventory you must work through:

```bash
cd /home/matthew/circuits-com
grep -rn "is_demo_user\|demo_messages\|DEMO_LOGIN\|auth/demo\|demo_account_\|DEMO_READ_ONLY\|DEMO_WRITE_EXEMPT" api/app api/tests
grep -rn "loginAsDemo\|demoSession\|demoReadOnly\|demoHidden\|is_demo" frontend/src | grep -v wizard/
```

Work that list top to bottom. It is the task.

- [ ] **Step 3: Remove the backend door and its gates**

In `api/app/routes/auth.py`: delete the `@router.post("/demo")` handler, the
`_is_demo_identifier` helper, and its call inside `_find_login_user`. The
docstring there explains why the demo was refused at login — delete that
paragraph with it, so no comment survives describing a feature that does not.

In `api/app/services/auth_service.py`: delete `demo_login_email`,
`is_demo_user`, `_is_demo_blocked_write`, `DEMO_READ_ONLY_DETAIL`,
`DEMO_WRITE_EXEMPT_PATHS`, and the demo branch in `get_current_user`. That
function then reads:

```python
def get_current_user(request: Request, user: User = Depends(get_authenticated_user)) -> User:
    """The authenticated user, gated on a forced password change.

    Fail-CLOSED by construction: every admin route depends on this, so the
    gate covers them all — including routes added later — without a
    per-router opt-in that a new endpoint could forget.

    Deliberately role-agnostic. The customer/staff wall is require_staff /
    require_account_user / require_console_user, which compose with this.
    """
    if bool(user.must_change_password):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=PASSWORD_CHANGE_REQUIRED_DETAIL,
        )
    return user
```

`request` is now unused in the signature — remove the parameter and every
`Depends` that passed it.

In `admin_leads.py`, `admin_messages.py`, `admin_quotes.py`, `calendar.py`,
`feed_credentials.py`, `suppliers.py`: delete every `is_demo_user(...)` branch
and its `demo_account_*` detail constant. **Read each one before deleting** —
some return a redacted or synthetic payload rather than raising, so the branch
plus its alternative return must both go, leaving the real path.

Delete `api/app/services/demo_messages.py` and the `demo_messages` /
`find_demo_message` branches in `admin_messages.py`.

In `api/app/config.py`: delete `DEMO_LOGIN_ENABLED` and `DEMO_LOGIN_EMAIL`.
Remove both from the `environment:` blocks of `docker-compose.yml` and
`docker-compose.prod.yml` — and check `api/tests/test_compose_env_passthrough.py`,
which asserts on those keys.

In `api/app/db/seed.py`: remove the `("demo", "demo", "demo@circuitcenter.ai")`
entry from `admin_users`. Leave `SEED_DEMO_CATALOG` and `_DEMO_CATALOG` alone.

- [ ] **Step 4: Remove the frontend door**

Delete `components/DemoReadOnlyNotice.tsx`, `services/demoReadOnly.ts`,
`services/demoReadOnly.test.ts`, and every import of them.

In `services/adminApi.ts`: delete `demoLogin`, and the `isDemoReadOnly` branch
in the response interceptor. In `services/apiError.ts`: delete
`isDemoReadOnly`. In `types/admin.ts`: delete `is_demo` from `UserInfo`.

In `contexts/AuthContext.tsx`: delete `loginAsDemo` and the
`demoSession.set(...)` line inside `adopt`.

In `contexts/DemoContext.tsx`: delete **only** `demoLocked` and the
`useAuth()` call that computes it, and make `toggleDemo` unconditional.
`demoMode`, `toggleDemo` and the `localStorage` preference **stay** — that is
the display toggle, not the account.

In `pages/manufacturers/CatalogSwitch.tsx`: the Leads half was hidden for demo
sessions. That condition goes, so both halves always render.

In `components/AdminLayout.tsx`, `pages/messages/list/index.tsx`,
`pages/dashboard/components/SalesRepsPanel.tsx`,
`pages/suppliers/detail/NightlyImportToggle.tsx`: delete the demo-session
branches. Keep any `demoMode` branches — different feature.

- [ ] **Step 5: Replace the button on the sign-in screen**

In `pages/login/screens/SignIn.tsx`, delete the whole `{!demoHidden && (...)}`
block and put the Sign Up call-to-action in its place, keeping the same
`.demo-cta` geometry so the panel does not reflow:

```tsx
        <div className="demo-cta">
          <button type="button" className="btn-demo" onClick={() => go('signup')}>
            Sign Up &rarr;
          </button>
          <p className="demo-note">Create an account to get started.</p>
        </div>
```

This REPLACES the demo block. Task 13 Step 7 assumes this is already done and
does not add a second entry point.

- [ ] **Step 6: Fix the tests that assert on demo behaviour**

Work through the grep output from Step 2 for `api/tests/`. Most are one-line
deletions of a demo case. Three need judgement:

- `test_demo_read_only.py` — **delete the file.** It tests only the removed gate.
- `conftest.py` — remove the demo user from the fixture, and any `auth_header` demo branch.
- `test_seed_admin_users.py` — it asserts the seeded set; drop `demo` from the expected list, keeping the other four.
- `test_compose_env_passthrough.py` — drop the `DEMO_LOGIN_*` assertions.

- [ ] **Step 7: Run everything**

Run: `cd api && pytest tests/ -q`
Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`
Expected: all green. TS strict will surface every stale `is_demo` reference for
you — treat `tsc -b` as the completeness check, not your own reading.

- [ ] **Step 8: Confirm the door is really shut**

```bash
docker compose up -d --build api
curl -s -o /dev/null -w '%{http_code}
' -X POST http://localhost/api/auth/demo
```
Expected: `404`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(auth): retire the demo account — registration replaces it"
```

---

## Task 2: The role gates

**Files:**
- Modify: `api/app/models/roles.py`, `api/app/services/auth_service.py`
- Test: `api/tests/test_staff_wall.py`

**Interfaces:**
- Consumes: `User.role`, `User.activated_at` (Task 1).
- Produces: `roles.CUSTOMER_ROLES`; `auth_service.require_staff(user) -> User`, `require_account_user(user) -> User`, `require_console_user(user) -> User`; details `"staff_only"`, `"account_not_activated"`.

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_staff_wall.py`:

```python
"""The wall between customers and staff-only tooling.

Today's suite proves the INVERSE — test_auth_forced_password_change.py
::test_the_gate_is_role_agnostic_for_company_users shows a customer-role user
reaching an admin route. These tests pin the wall that stops it.
"""
import pytest
from fastapi import HTTPException

from app.models import User
from app.models.roles import ADMIN_ROLES, CUSTOMER_ROLES
from app.services.auth_service import (
    require_account_user,
    require_console_user,
    require_staff,
)


def _user(role, activated_at=None):
    return User(username="x", email="x@test.example", password_hash="x",
                role=role, activated_at=activated_at)


def test_customer_role_is_not_an_admin_role():
    assert "user" in CUSTOMER_ROLES
    assert "user" not in ADMIN_ROLES


@pytest.mark.parametrize("role", ["admin", "owner"])
def test_require_staff_admits_staff(role):
    u = _user(role)
    assert require_staff(u) is u


def test_require_staff_refuses_a_customer():
    with pytest.raises(HTTPException) as exc:
        require_staff(_user("user"))
    assert exc.value.status_code == 403
    assert exc.value.detail == "staff_only"


def test_require_account_user_refuses_an_unactivated_customer():
    with pytest.raises(HTTPException) as exc:
        require_account_user(_user("user", activated_at=None))
    assert exc.value.status_code == 403
    assert exc.value.detail == "account_not_activated"


def test_require_account_user_admits_an_activated_customer():
    from datetime import UTC, datetime

    u = _user("user", activated_at=datetime.now(UTC))
    assert require_account_user(u) is u


def test_require_account_user_refuses_staff():
    with pytest.raises(HTTPException):
        require_account_user(_user("admin"))


@pytest.mark.parametrize("role", ["admin", "owner"])
def test_staff_are_never_gated_on_activation(role):
    # activated_at is None for every staff row and must stay irrelevant.
    u = _user(role, activated_at=None)
    assert require_console_user(u) is u


def test_console_admits_an_activated_customer():
    from datetime import UTC, datetime

    u = _user("user", activated_at=datetime.now(UTC))
    assert require_console_user(u) is u


def test_console_refuses_an_unactivated_customer():
    with pytest.raises(HTTPException) as exc:
        require_console_user(_user("user"))
    assert exc.value.detail == "account_not_activated"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_staff_wall.py -q`
Expected: FAIL — `ImportError: cannot import name 'CUSTOMER_ROLES'`.

- [ ] **Step 3: Add CUSTOMER_ROLES**

Append to `api/app/models/roles.py`:

```python
# The customer principal (alembic 043). Deliberately disjoint from
# ADMIN_ROLES: a membership test against one must never accidentally admit
# the other, which is exactly how the pre-043 console let a customer-role
# user reach /api/admin/sponsors/.
CUSTOMER_ROLES = ("user",)
```

- [ ] **Step 4: Add the three dependencies**

Append to `api/app/services/auth_service.py`:

```python
# ── The customer/staff wall (alembic 043) ───────────────────────────────────
# get_current_user is deliberately role-agnostic, which was correct while every
# account was staff. Public registration ends that, so these three are the
# boundary. They COMPOSE with get_current_user — never replace it — so the
# forced-password gate and the demo write-lock still run first.
STAFF_ONLY_DETAIL = "staff_only"
NOT_ACTIVATED_DETAIL = "account_not_activated"


def _role_of(user: User) -> str:
    """Normalize the role the same way is_owner does.

    SQLAlchemy's Enum(...) can hand back an enum member or a bare string
    depending on how the row was loaded.
    """
    role = getattr(user.role, "value", user.role)
    return role.strip().lower() if isinstance(role, str) else ""


def is_staff(user: User | None) -> bool:
    return user is not None and _role_of(user) in ADMIN_ROLES


def is_customer(user: User | None) -> bool:
    return user is not None and _role_of(user) in CUSTOMER_ROLES


def require_staff(user: User = Depends(get_current_user)) -> User:
    """Staff-only routes: /api/admin/users, message deletion, anything that
    manages OTHER accounts."""
    if not is_staff(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail=STAFF_ONLY_DETAIL)
    return user


def require_account_user(user: User = Depends(get_current_user)) -> User:
    """An ACTIVATED customer. Activation (D17) is the whole authorization
    boundary in this project, so it lives here and nowhere else."""
    if not is_customer(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail=STAFF_ONLY_DETAIL)
    if user.activated_at is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail=NOT_ACTIVATED_DETAIL)
    return user


def require_console_user(user: User = Depends(get_current_user)) -> User:
    """Either principal — the console pages are shared (D16).

    Staff are NEVER gated on activated_at: it is NULL on every staff row and
    must stay irrelevant to them.
    """
    if is_staff(user):
        return user
    return require_account_user(user)
```

Add `from app.models.roles import ADMIN_ROLES, CUSTOMER_ROLES` to that file's imports.

- [ ] **Step 5: Run the test**

Run: `cd api && pytest tests/test_staff_wall.py -q`
Expected: PASS (10 tests).

- [ ] **Step 6: Add the activation test and MUTATION-CHECK it**

Create `api/tests/test_account_activation.py`:

```python
"""Activation is the whole authorization boundary in Project 1 (D17).

Because it is one condition rather than forty WHERE clauses, a test that
passes without it is measuring nothing — hence the mutation check in the
step below, which is part of this task, not a nicety.
"""
from datetime import UTC, datetime

import pytest
from fastapi import HTTPException

from app.models import User
from app.services.auth_service import require_account_user, require_console_user


def _customer(activated_at=None):
    return User(username="c@test.example", email="c@test.example",
                password_hash="x", role="user", activated_at=activated_at)


def test_unactivated_is_refused_by_both_customer_gates():
    for gate in (require_account_user, require_console_user):
        with pytest.raises(HTTPException) as exc:
            gate(_customer())
        assert exc.value.detail == "account_not_activated"


def test_activation_admits():
    u = _customer(activated_at=datetime.now(UTC))
    assert require_account_user(u) is u
    assert require_console_user(u) is u


def test_activation_is_a_stamp_not_a_boolean():
    # The column records WHEN, so /admin/users can show how long someone
    # waited. A bool would have thrown that away.
    u = _customer(activated_at=datetime.now(UTC))
    assert isinstance(u.activated_at, datetime)
```

Run: `cd api && pytest tests/test_account_activation.py -q`
Expected: PASS (3 tests).

- [ ] **Step 7: Prove the test actually measures the gate**

Temporarily comment out the `activated_at is None` check in
`require_account_user`, then run:

`cd api && pytest tests/test_account_activation.py tests/test_staff_wall.py -q`

Expected: **FAIL** — at least three tests. If they still pass, the tests are
measuring something other than the gate and must be fixed before you continue.
Restore the check and confirm green again.

This is the same trap `test_price_break_writes_pg.py` documents: a guard test
that never went red against the un-guarded code proves nothing.

- [ ] **Step 8: Commit**

```bash
git add api/app/models/roles.py api/app/services/auth_service.py api/tests/test_staff_wall.py api/tests/test_account_activation.py
git commit -m "feat(auth): require_staff / require_account_user / require_console_user"
```

---

## Task 3: Apply the wall, and the test that keeps it applied

**Files:**
- Modify: every admin router (`admin_messages.py`, `admin_sponsors.py`, `admin_expenses.py`, `admin_media.py`, `admin_presence.py`, `admin_manufacturers.py`, `admin_leads.py`, `admin_quotes.py`, `feed_credentials.py`, `parts.py`, `dashboard.py` (`admin_router`), `analytics.py`, `calendar.py`)
- Test: `api/tests/test_every_route_is_gated.py`

**Interfaces:**
- Consumes: `require_console_user`, `require_staff` (Task 2).

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_every_route_is_gated.py`:

```python
"""Every route carries a gate, or is on the allowlist. No third option.

This inverts the failure mode: a route added six months from now fails this
suite by DEFAULT rather than being silently reachable. Same construction as
test_leads_never_public.py.

It matches on FUNCTION IDENTITY, walking route.dependant.dependencies — not on
the path string and not on a decorator, either of which a route could satisfy
while being ungated.
"""
from fastapi.routing import APIRoute

from app.main import app
from app.services.auth_service import (
    get_authenticated_user,
    require_account_user,
    require_console_user,
    require_staff,
)

GATES = {require_console_user, require_staff, require_account_user,
         get_authenticated_user}

# Deliberately unauthenticated. Adding a line here is an edit a human must
# look at — that is the entire point of the allowlist.
PUBLIC_ROUTES = {
    "/api/auth/login", "/api/auth/logout",
    "/api/auth/forgot-password", "/api/auth/reset-password",
    "/api/auth/forgot-username",
    "/api/auth/signup", "/api/auth/verify", "/api/auth/resend-verification",
    "/api/categories/", "/api/suppliers/", "/api/search/",
    "/api/manufacturers/", "/api/sponsors/",
    "/api/contact", "/api/join", "/api/keyword-request",
    "/api/track", "/api/sitemap.xml",
    "/api/stripe/webhook",
    "/api/checkout/silver", "/api/checkout/silver/boards",
    "/api/bom/match", "/api/bom/resolve", "/api/bom/share",
    "/api/health", "/docs", "/openapi.json", "/redoc",
    "/docs/oauth2-redirect",
}


def _gate_calls(route):
    seen = set()
    stack = list(route.dependant.dependencies)
    while stack:
        dep = stack.pop()
        if dep.call is not None:
            seen.add(dep.call)
        stack.extend(dep.dependencies)
    return seen


def test_every_route_is_gated_or_allowlisted():
    ungated = []
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        path = route.path
        if path in PUBLIC_ROUTES or path.rstrip("/") in PUBLIC_ROUTES:
            continue
        if not (_gate_calls(route) & GATES):
            ungated.append(f"{sorted(route.methods)} {path}")
    assert not ungated, (
        "These routes carry no gate and are not allowlisted:\n  "
        + "\n  ".join(sorted(ungated))
    )


def test_the_allowlist_only_names_routes_that_exist():
    # A stale allowlist entry is a silent hole waiting for a path to be reused.
    live = {r.path for r in app.routes if isinstance(r, APIRoute)}
    live |= {r.path.rstrip("/") for r in app.routes if isinstance(r, APIRoute)}
    stale = {p for p in PUBLIC_ROUTES if p not in live}
    assert not stale, f"allowlist names routes that do not exist: {sorted(stale)}"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_every_route_is_gated.py -q`
Expected: FAIL — a long list of admin routes with no gate. Read that list; it is the work for Step 3. Also fix any stale allowlist entries the second test reports (path spellings differ from the guesses above — trust the test, edit the allowlist to match reality).

- [ ] **Step 3: Add the router-level dependency**

For each admin router file listed under **Files**, add the import and the router dependency. Example, `api/app/routes/admin_sponsors.py`:

```python
from app.services.auth_service import require_console_user

router = APIRouter(
    prefix="/api/admin/sponsors",
    tags=["admin-sponsors"],
    # D16: the console pages are shared with activated customers. The
    # per-route get_current_user dependencies stay — this ADDS the wall,
    # it does not replace the password/demo gates.
    dependencies=[Depends(require_console_user)],
)
```

Apply the same two lines to every router in the Files list. `dashboard.py` has TWO routers — the public `router` stays public; only `admin_router` gets the dependency.

- [ ] **Step 4: Run the gate test**

Run: `cd api && pytest tests/test_every_route_is_gated.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole suite**

Run: `cd api && pytest tests/ -q`
Expected: PASS. Existing admin tests authenticate as `admin`/`owner`, which `require_console_user` admits.

- [ ] **Step 6: Commit**

```bash
git add api/app/routes/ api/tests/test_every_route_is_gated.py
git commit -m "feat(auth): gate every admin router, and a test that keeps it that way"
```

---

## Task 4: Verification tokens

**Files:**
- Modify: `api/app/services/auth_service.py`
- Test: `api/tests/test_email_verification.py`

**Interfaces:**
- Produces: `create_verify_token(user_id: str, email: str) -> str`, `decode_verify_token(token: str) -> dict`, `verify_token_matches_email(payload: dict, email: str) -> bool`, `VERIFY_EXPIRY_HOURS = 24`.

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_email_verification.py`:

```python
import jwt
import pytest

from app.services.auth_service import (
    VERIFY_EXPIRY_HOURS,
    create_token,
    create_verify_token,
    decode_reset_token,
    decode_verify_token,
    verify_token_matches_email,
)


def test_ttl_is_24_hours():
    # D13. Reset is 30 minutes because it hands over a live credential;
    # this only proves mailbox control.
    assert VERIFY_EXPIRY_HOURS == 24


def test_round_trips():
    token = create_verify_token("abc-123", "Person@Example.com")
    payload = decode_verify_token(token)
    assert payload["sub"] == "abc-123"
    assert payload["purpose"] == "verify"


def test_a_session_token_is_not_a_verify_token():
    with pytest.raises(jwt.InvalidTokenError):
        decode_verify_token(create_token("abc-123", "user"))


def test_a_verify_token_is_not_a_reset_token():
    with pytest.raises(jwt.InvalidTokenError):
        decode_reset_token(create_verify_token("abc-123", "a@test.example"))


def test_email_fingerprint_is_case_insensitive():
    # The address is stored lowercased; a token minted from the typed form
    # must still match.
    payload = decode_verify_token(create_verify_token("abc", "Person@Example.com"))
    assert verify_token_matches_email(payload, "person@example.com") is True


def test_email_fingerprint_rejects_a_different_address():
    payload = decode_verify_token(create_verify_token("abc", "a@test.example"))
    assert verify_token_matches_email(payload, "b@test.example") is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_email_verification.py -q`
Expected: FAIL — `ImportError: cannot import name 'create_verify_token'`.

- [ ] **Step 3: Implement the token helpers**

Append to `api/app/services/auth_service.py`, next to the reset-token helpers:

```python
# Email verification (alembic 043). 24 hours, not the reset link's 30 minutes:
# a reset link hands over a live credential, this only proves mailbox control,
# and people read email on their own schedule.
VERIFY_EXPIRY_HOURS = 24


def _email_fingerprint(email: str) -> str:
    """First 16 hex of sha256(lower(email)) — ties a token to one address.

    Lowercased because the address is STORED lowercased (uq_users_email_lower)
    but the token may be minted from whatever casing the person typed.
    """
    return hashlib.sha256((email or "").strip().lower().encode()).hexdigest()[:16]


def create_verify_token(user_id: str, email: str) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": user_id,
        "purpose": "verify",
        "emfp": _email_fingerprint(email),
        "exp": now + timedelta(hours=VERIFY_EXPIRY_HOURS),
        "iat": now,
    }
    return jwt.encode(payload, settings.ADMIN_SECRET_KEY, algorithm="HS256")


def decode_verify_token(token: str) -> dict:
    """Signature + expiry + purpose. Raises jwt.InvalidTokenError otherwise.

    The purpose claim is what stops a verification link being replayed as a
    session: get_authenticated_user rejects ANY token carrying a purpose.
    """
    payload = jwt.decode(token, settings.ADMIN_SECRET_KEY, algorithms=["HS256"])
    if payload.get("purpose") != "verify":
        raise jwt.InvalidTokenError("not a verification token")
    return payload


def verify_token_matches_email(payload: dict, email: str) -> bool:
    """True iff the token was minted for this address."""
    return payload.get("emfp") == _email_fingerprint(email)
```

- [ ] **Step 4: Run the test**

Run: `cd api && pytest tests/test_email_verification.py -q`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add api/app/services/auth_service.py api/tests/test_email_verification.py
git commit -m "feat(auth): verification tokens, purpose-claimed and address-bound"
```

---

## Task 5: Signup rate limiting

**Files:**
- Modify: `api/app/services/rate_limit.py`
- Test: `api/tests/test_signup_rate_limit.py`

**Interfaces:**
- Produces: `signup_ip_key(request) -> str`, `signup_email_key(email) -> str | None`, `record_probe(key: str, value: str) -> int`, `PROBE_DISTINCT_THRESHOLD = 8`, `PROBE_WINDOW_SECONDS = 900`.

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_signup_rate_limit.py`:

```python
"""The enumeration signal is DISTINCT addresses, not raw attempts.

D5 traded the anti-enumeration property at signup for UX. This is what pays
for it: someone who forgot they registered retries ONE address; an enumerator
walks many.
"""
from app.services.rate_limit import (
    PROBE_DISTINCT_THRESHOLD,
    limiter,
    record_probe,
    reset_probes,
    signup_email_key,
    signup_ip_key,
)


def setup_function():
    limiter.reset()
    reset_probes()


def test_threshold_is_eight():
    assert PROBE_DISTINCT_THRESHOLD == 8


def test_repeating_one_address_does_not_trip_it():
    for _ in range(20):
        n = record_probe("signup:probe:1.2.3.4", "same@test.example")
    assert n == 1


def test_distinct_addresses_accumulate():
    for i in range(5):
        n = record_probe("signup:probe:1.2.3.4", f"a{i}@test.example")
    assert n == 5


def test_case_and_space_do_not_inflate_the_count():
    record_probe("signup:probe:1.2.3.4", "Person@Example.com")
    n = record_probe("signup:probe:1.2.3.4", "  person@example.com ")
    assert n == 1


def test_separate_ips_do_not_share_a_counter():
    record_probe("signup:probe:1.1.1.1", "a@test.example")
    n = record_probe("signup:probe:2.2.2.2", "b@test.example")
    assert n == 1


def test_the_signup_namespace_is_not_the_login_namespace():
    # A signup flood must never lock a real customer out of signing in.
    class _Req:
        headers = {"X-Real-IP": "9.9.9.9"}
        client = None

    assert signup_ip_key(_Req()).startswith("signup:")
    assert signup_email_key("a@test.example").startswith("signup:")
    assert signup_email_key(None) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_signup_rate_limit.py -q`
Expected: FAIL — `ImportError: cannot import name 'PROBE_DISTINCT_THRESHOLD'`.

- [ ] **Step 3: Implement**

Append to `api/app/services/rate_limit.py`:

```python
# ── Signup (alembic 043) ────────────────────────────────────────────────────
# A THIRD namespace, deliberately not shared with login:* or recovery:* for the
# same reason those two are separate: a signup flood must never lock a real
# customer out of signing in.
SIGNUP_IP_PREFIX = "signup:ip:"
SIGNUP_EMAIL_PREFIX = "signup:email:"
SIGNUP_PROBE_PREFIX = "signup:probe:"

# D5 relaxed anti-enumeration at signup so the form can say "that address is
# taken". This is what pays for it. The limiter above counts FAILURES per key;
# enumeration is better measured as DISTINCT VALUES per key — a person who
# forgot they registered retries one address, an enumerator walks many.
PROBE_DISTINCT_THRESHOLD = 8
PROBE_WINDOW_SECONDS = 15 * 60
PROBE_LOCK_SECONDS = 60 * 60
# Bounded so a spray cannot grow this dict without limit; oldest key evicted.
MAX_PROBE_KEYS = 2048

_probes: dict[str, dict[str, float]] = {}


def signup_ip_key(request: Request) -> str:
    return f"{SIGNUP_IP_PREFIX}{client_ip(request)}"


def signup_email_key(email: str | None) -> str | None:
    normalized = (email or "").strip().lower()
    return f"{SIGNUP_EMAIL_PREFIX}{normalized}" if normalized else None


def signup_probe_key(request: Request) -> str:
    return f"{SIGNUP_PROBE_PREFIX}{client_ip(request)}"


def record_probe(key: str, value: str) -> int:
    """Record that `key` probed `value`; return the DISTINCT count in-window.

    Values are normalized so casing and padding cannot inflate the count —
    an enumerator would otherwise pay nothing to look like eight people.
    """
    now = _now()
    normalized = (value or "").strip().lower()
    seen = _probes.setdefault(key, {})
    for old, stamp in list(seen.items()):
        if now - stamp > PROBE_WINDOW_SECONDS:
            del seen[old]
    seen[normalized] = now
    if len(_probes) > MAX_PROBE_KEYS:
        oldest = min(_probes, key=lambda k: max(_probes[k].values(), default=0.0))
        if oldest != key:
            del _probes[oldest]
    return len(seen)


def reset_probes() -> None:
    """Test hook — the module keeps process-lifetime state."""
    _probes.clear()
```

- [ ] **Step 4: Run the test**

Run: `cd api && pytest tests/test_signup_rate_limit.py -q`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add api/app/services/rate_limit.py api/tests/test_signup_rate_limit.py
git commit -m "feat(auth): signup rate-limit namespace and distinct-address probe counter"
```

---

## Task 6: The three HTML emails

**Files:**
- Modify: `api/app/services/email.py`
- Test: `api/tests/test_account_emails.py`

**Interfaces:**
- Produces: `_build_verification_email(to, first_name, verify_url) -> EmailMessage`, `_build_welcome_email(to, first_name) -> EmailMessage`, `_build_activation_email(to, first_name, account_url) -> EmailMessage`, and `send_verification_email`, `send_welcome_email`, `send_activation_email` coroutines.

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_account_emails.py`:

```python
"""The project's first HTML mail. Everything else stays plain text."""
from app.services.email import (
    _build_activation_email,
    _build_verification_email,
    _build_welcome_email,
)

URL = "https://circuitcenter.ai/admin/verify?token=abc"


def _parts(msg):
    return {p.get_content_type() for p in msg.walk() if not p.is_multipart()}


def test_verification_is_multipart_alternative_with_a_text_part():
    msg = _build_verification_email("a@test.example", "Ada", URL)
    assert msg.get_content_type() == "multipart/alternative"
    assert _parts(msg) == {"text/plain", "text/html"}


def test_the_link_appears_in_both_parts():
    msg = _build_verification_email("a@test.example", "Ada", URL)
    for part in msg.walk():
        if part.is_multipart():
            continue
        assert URL in part.get_content(), "a text-only reader must still get the link"


def test_no_remote_images():
    # Remote images are blocked by default in most clients, and fetching one
    # confirms to the sender that the address is live.
    for msg in (
        _build_verification_email("a@test.example", "Ada", URL),
        _build_welcome_email("a@test.example", "Ada"),
        _build_activation_email("a@test.example", "Ada", "https://circuitcenter.ai/account"),
    ):
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                assert "<img" not in part.get_content().lower()


def test_addressed_to_the_person_not_the_notify_list():
    msg = _build_welcome_email("a@test.example", "Ada")
    assert msg["To"] == "a@test.example"


def test_first_name_is_used():
    msg = _build_welcome_email("a@test.example", "Ada")
    html = [p.get_content() for p in msg.walk()
            if p.get_content_type() == "text/html"][0]
    assert "Ada" in html
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_account_emails.py -q`
Expected: FAIL — `ImportError: cannot import name '_build_verification_email'`.

- [ ] **Step 3: Implement**

Append to `api/app/services/email.py`:

```python
# ── Account lifecycle mail (alembic 043) ────────────────────────────────────
# The only HTML mail in this codebase. Constraints, all learned the hard way by
# everyone who has ever sent HTML mail:
#   * inline styles only — no <style> block survives Gmail reliably
#   * table layout, max-width 600px
#   * NO remote images. They are blocked by default, and fetching one confirms
#     to the sender that the address is live.
# Every message carries a text/plain part saying the same thing, so a text-only
# reader still gets the link.

_MAIL_MAX_WIDTH = 600
_INK = "#1a1f23"
_GREEN = "#44bd13"


def _html_shell(heading: str, body_html: str, cta_label: str = "",
                cta_url: str = "") -> str:
    button = ""
    if cta_label and cta_url:
        button = (
            f'<tr><td style="padding:24px 0 8px 0;">'
            f'<a href="{cta_url}" style="background:{_GREEN};color:#ffffff;'
            f'text-decoration:none;padding:13px 26px;border-radius:6px;'
            f'font-weight:600;display:inline-block;">{cta_label}</a></td></tr>'
            f'<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">'
            f'If the button does not work, paste this into your browser:<br>'
            f'<span style="color:{_INK};word-break:break-all;">{cta_url}</span>'
            f'</td></tr>'
        )
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="background:#eef1f5;padding:32px 0;">'
        f'<tr><td align="center">'
        f'<table role="presentation" width="{_MAIL_MAX_WIDTH}" cellpadding="0" '
        f'cellspacing="0" style="max-width:{_MAIL_MAX_WIDTH}px;background:#ffffff;'
        f'border-radius:10px;padding:32px;font-family:-apple-system,Segoe UI,'
        f'Helvetica,Arial,sans-serif;color:{_INK};">'
        f'<tr><td style="font-size:22px;font-weight:700;padding-bottom:12px;">'
        f'{heading}</td></tr>'
        f'<tr><td style="font-size:15px;line-height:1.6;">{body_html}</td></tr>'
        f'{button}'
        f'<tr><td style="padding-top:28px;color:#6b7280;font-size:12px;'
        f'border-top:1px solid #eef1f5;">Circuit Center</td></tr>'
        f'</table></td></tr></table>'
    )


def _build_html_email(*, to_email: str, subject: str, text: str,
                      html: str) -> EmailMessage:
    """One multipart/alternative message. set_content then add_alternative
    puts text/plain first, which is the order the RFC wants."""
    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    return msg


def _greeting(first_name: str | None) -> str:
    return f"Hi {first_name}" if first_name else "Hi"


def _build_verification_email(to_email: str, first_name: str | None,
                              verify_url: str) -> EmailMessage:
    text = (
        f"{_greeting(first_name)},\n\n"
        "Confirm your email address to finish setting up your Circuit Center\n"
        "account:\n\n"
        f"{verify_url}\n\n"
        "This link expires in 24 hours. If you did not create an account, you\n"
        "can ignore this email.\n\n"
        "- Circuit Center\n"
    )
    html = _html_shell(
        "Confirm your email",
        f"{_greeting(first_name)} — confirm this address to finish setting up "
        "your Circuit Center account. The link expires in 24 hours.",
        "Confirm email", verify_url,
    )
    return _build_html_email(to_email=to_email,
                             subject="Confirm your email — Circuit Center",
                             text=text, html=html)


def _build_welcome_email(to_email: str, first_name: str | None) -> EmailMessage:
    text = (
        f"{_greeting(first_name)},\n\n"
        "Your email is confirmed. A member of our team reviews new accounts\n"
        "before switching them on — we will email you the moment yours is\n"
        "ready.\n\n"
        "- Circuit Center\n"
    )
    html = _html_shell(
        "Email confirmed",
        f"{_greeting(first_name)} — your email is confirmed. A member of our "
        "team reviews new accounts before switching them on, and we will email "
        "you the moment yours is ready.",
    )
    return _build_html_email(to_email=to_email,
                             subject="Email confirmed — Circuit Center",
                             text=text, html=html)


def _build_activation_email(to_email: str, first_name: str | None,
                            account_url: str) -> EmailMessage:
    text = (
        f"{_greeting(first_name)},\n\n"
        "Your Circuit Center account is live. Sign in to see it:\n\n"
        f"{account_url}\n\n"
        "- Circuit Center\n"
    )
    html = _html_shell(
        "Your account is live",
        f"{_greeting(first_name)} — your Circuit Center account is switched on. "
        "Sign in whenever you are ready.",
        "Open my account", account_url,
    )
    return _build_html_email(to_email=to_email,
                             subject="Your account is live — Circuit Center",
                             text=text, html=html)


async def send_verification_email(to_email: str, first_name: str | None,
                                  verify_url: str) -> bool:
    return await _smtp_send(_build_verification_email(to_email, first_name, verify_url))


async def send_welcome_email(to_email: str, first_name: str | None) -> bool:
    return await _smtp_send(_build_welcome_email(to_email, first_name))


async def send_activation_email(to_email: str, first_name: str | None,
                                account_url: str) -> bool:
    return await _smtp_send(_build_activation_email(to_email, first_name, account_url))
```

- [ ] **Step 4: Run the test**

Run: `cd api && pytest tests/test_account_emails.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add api/app/services/email.py api/tests/test_account_emails.py
git commit -m "feat(auth): the three account-lifecycle emails, HTML with a text part"
```

---

## Task 7: POST /api/auth/signup

**Files:**
- Modify: `api/app/routes/auth.py`
- Test: `api/tests/test_signup.py`

**Interfaces:**
- Consumes: `create_verify_token` (Task 4), `record_probe`/`signup_*_key` (Task 5), `send_verification_email` (Task 6), `geoip.country_for_ip`.
- Produces: `POST /api/auth/signup` → `202 {"status":"ok"}`; `409 {"detail":"email_taken"}`.

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_signup.py`:

```python
from app.models import User
from app.services.rate_limit import limiter, reset_probes

GOOD = {
    "first_name": "Ada",
    "last_name": "Lovelace",
    "email": "Ada@Test.Example",
    "password": "Analytical1!",
}


def setup_function():
    limiter.reset()
    reset_probes()


def test_returns_202_and_no_token(client):
    r = client.post("/api/auth/signup", json=GOOD)
    assert r.status_code == 202
    assert r.json() == {"status": "ok"}
    assert "token" not in r.json()  # no session until verified


def test_creates_an_unverified_unactivated_customer(client, db_session):
    client.post("/api/auth/signup", json=GOOD)
    u = db_session.query(User).filter(User.email == "ada@test.example").first()
    assert u is not None
    assert u.role == "user"
    assert u.email_verified_at is None
    assert u.activated_at is None
    assert u.must_change_password is False


def test_username_is_the_lowercased_email(client, db_session):
    client.post("/api/auth/signup", json=GOOD)
    u = db_session.query(User).filter(User.email == "ada@test.example").first()
    assert u.username == "ada@test.example"


def test_capability_links_are_never_set_by_signup(client, db_session):
    client.post("/api/auth/signup", json=GOOD)
    u = db_session.query(User).filter(User.email == "ada@test.example").first()
    assert u.supplier_id is None
    assert u.manufacturer_id is None


def test_a_body_that_tries_to_set_privilege_is_rejected(client):
    r = client.post("/api/auth/signup", json={**GOOD, "role": "owner"})
    assert r.status_code == 422  # extra="forbid"


def test_confirm_password_is_not_accepted_on_the_wire(client):
    # D11: it is a client-side check. Sending it would put a second copy of a
    # live credential on the wire for no added assurance.
    r = client.post("/api/auth/signup", json={**GOOD, "confirm_password": "Analytical1!"})
    assert r.status_code == 422


def test_a_weak_password_returns_the_shared_policy_shape(client):
    r = client.post("/api/auth/signup", json={**GOOD, "password": "short"})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "password_policy"
    assert "length" in detail["unmet"]


def test_duplicate_email_is_reported_plainly(client):
    client.post("/api/auth/signup", json=GOOD)
    r = client.post("/api/auth/signup", json={**GOOD, "email": "ada@test.example"})
    assert r.status_code == 409
    assert r.json()["detail"] == "email_taken"


def test_duplicate_detection_is_case_insensitive(client):
    client.post("/api/auth/signup", json=GOOD)
    r = client.post("/api/auth/signup", json={**GOOD, "email": "ADA@TEST.EXAMPLE"})
    assert r.status_code == 409


def test_an_existing_staff_address_is_also_taken(client):
    r = client.post("/api/auth/signup", json={**GOOD, "email": "matthew@circuitcenter.ai"})
    assert r.status_code == 409
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_signup.py -q`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Implement the route**

Add to `api/app/routes/auth.py`:

```python
class SignupRequest(BaseModel):
    # extra="forbid" is load-bearing, not tidiness: it is what stops a body
    # carrying role/supplier_id/manufacturer_id, and what rejects a
    # confirm_password someone helpfully added client-side (D11).
    model_config = ConfigDict(extra="forbid")

    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    email: EmailStr
    # No Field(min_length=...): validate_password is the ONE gate, so a short
    # password answers with the structured policy 422 like every other rule.
    password: str


EMAIL_TAKEN_DETAIL = "email_taken"


@router.post("/signup", status_code=status.HTTP_202_ACCEPTED)
async def signup(
    body: SignupRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Create an unverified, unactivated customer account.

    Returns 202 and NO token. There is no session until the address is
    verified, which is what makes "notify staff on verify, never on submit"
    (D6) enforceable rather than advisory.
    """
    ip_key = signup_ip_key(request)
    retry_after = limiter.retry_after(ip_key)
    if retry_after:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="too_many_requests",
            headers={"Retry-After": str(retry_after)},
        )

    unmet = validate_password(body.password)
    if unmet:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "password_policy", "message": PASSWORD_HELP, "unmet": unmet},
        )

    email = body.email.strip().lower()
    existing = db.query(User).filter(func.lower(User.email) == email).first()
    if existing is not None:
        # D5: an explicit owner carve-out from the anti-enumeration rule, paid
        # for by the probe counter below. Do NOT "restore" the generic reply
        # without reading §6 of the design spec first.
        probes = record_probe(signup_probe_key(request), email)
        if probes >= PROBE_DISTINCT_THRESHOLD:
            limiter.record_failure(ip_key)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail=EMAIL_TAKEN_DETAIL)

    ip = client_ip(request)
    user = User(
        username=email,          # D7 — customers never choose one
        email=email,
        password_hash=hash_password(body.password),
        role="user",
        first_name=body.first_name.strip(),
        last_name=body.last_name.strip(),
        signup_ip=ip,
        signup_country=country_for_ip(ip),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    verify_url = (
        f"{settings.APP_BASE_URL.rstrip('/')}/admin/verify"
        f"?token={create_verify_token(str(user.id), email)}"
    )
    background_tasks.add_task(
        email_service.send_verification_email, email, user.first_name, verify_url
    )
    return {"status": "ok"}
```

Add to that file's imports:

```python
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from app.services.geoip import country_for_ip
from app.services.rate_limit import (
    PROBE_DISTINCT_THRESHOLD,
    record_probe,
    signup_ip_key,
    signup_probe_key,
)
```

- [ ] **Step 4: Run the test**

Run: `cd api && pytest tests/test_signup.py -q`
Expected: PASS (10 tests).

- [ ] **Step 5: Confirm the allowlist test still passes**

Run: `cd api && pytest tests/test_every_route_is_gated.py -q`
Expected: PASS — `/api/auth/signup` is already in `PUBLIC_ROUTES`.

- [ ] **Step 6: Commit**

```bash
git add api/app/routes/auth.py api/tests/test_signup.py
git commit -m "feat(auth): POST /api/auth/signup"
```

---

## Task 8: Verification, and the two message rows

**Files:**
- Modify: `api/app/routes/auth.py`
- Test: `api/tests/test_verify_endpoint.py`

**Interfaces:**
- Produces: `POST /api/auth/verify`, `POST /api/auth/resend-verification`; `Message` rows of type `signup` (user_id NULL) and `welcome` (user_id set).

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_verify_endpoint.py`:

```python
from app.models import Message, User
from app.services.auth_service import create_token, create_verify_token
from app.services.rate_limit import limiter, reset_probes

GOOD = {"first_name": "Ada", "last_name": "Lovelace",
        "email": "ada@test.example", "password": "Analytical1!"}


def setup_function():
    limiter.reset()
    reset_probes()


def _signup(client, db_session):
    client.post("/api/auth/signup", json=GOOD)
    return db_session.query(User).filter(User.email == GOOD["email"]).first()


def test_signup_alone_creates_no_messages(client, db_session):
    # D6: side effects fire on VERIFY, never on submit. Otherwise anyone with
    # a script sprays the staff inbox and mails strangers a "welcome".
    before = db_session.query(Message).count()
    _signup(client, db_session)
    assert db_session.query(Message).count() == before


def test_verify_stamps_and_creates_both_messages(client, db_session):
    user = _signup(client, db_session)
    token = create_verify_token(str(user.id), user.email)
    r = client.post("/api/auth/verify", json={"token": token})
    assert r.status_code == 200

    db_session.expire_all()
    user = db_session.query(User).filter(User.email == GOOD["email"]).first()
    assert user.email_verified_at is not None
    assert user.activated_at is None  # verification is not activation

    staff = db_session.query(Message).filter(Message.type == "signup").one()
    assert staff.user_id is None  # the shared staff inbox
    assert staff.payload["first_name"] == "Ada"

    welcome = db_session.query(Message).filter(Message.type == "welcome").one()
    assert welcome.user_id == user.id


def test_verify_is_single_use(client, db_session):
    user = _signup(client, db_session)
    token = create_verify_token(str(user.id), user.email)
    assert client.post("/api/auth/verify", json={"token": token}).status_code == 200
    r = client.post("/api/auth/verify", json={"token": token})
    assert r.status_code == 400
    assert db_session.query(Message).filter(Message.type == "signup").count() == 1


def test_a_session_token_cannot_verify(client, db_session):
    user = _signup(client, db_session)
    r = client.post("/api/auth/verify", json={"token": create_token(str(user.id), "user")})
    assert r.status_code == 400


def test_garbage_token_is_rejected(client):
    assert client.post("/api/auth/verify", json={"token": "nope"}).status_code == 400


def test_resend_is_generic_for_an_unknown_address(client):
    # Resend has no UX reason to be an oracle, so it keeps the invariant.
    r = client.post("/api/auth/resend-verification", json={"email": "nobody@test.example"})
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_resend_is_generic_for_an_already_verified_address(client, db_session):
    user = _signup(client, db_session)
    client.post("/api/auth/verify",
                json={"token": create_verify_token(str(user.id), user.email)})
    r = client.post("/api/auth/resend-verification", json={"email": user.email})
    assert r.json() == {"status": "ok"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_verify_endpoint.py -q`
Expected: FAIL — 404 on `/api/auth/verify`.

- [ ] **Step 3: Implement**

Add to `api/app/routes/auth.py`:

```python
class VerifyRequest(BaseModel):
    token: str


class ResendVerificationRequest(BaseModel):
    email: str


def _next_message_seq(db: Session) -> int:
    """Same single sequence space the public forms use (routes/forms.py)."""
    return (db.query(func.max(Message.seq)).scalar() or 0) + 1


@router.post("/verify")
async def verify_email(
    body: VerifyRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Spend a verification token.

    A POST, not a GET on the emailed link, because corporate mail scanners
    prefetch every URL in a message: a GET would be consumed before the human
    ever clicked. The SPA renders /admin/verify and POSTs from there.
    """
    try:
        payload = decode_verify_token(body.token)
    except jwt.PyJWTError:
        raise HTTPException(status_code=400, detail="invalid_or_expired_token")

    try:
        user_uuid = uuid_mod.UUID(payload.get("sub", ""))
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="invalid_or_expired_token")

    user = db.query(User).filter(User.id == user_uuid).first()
    if user is None or not verify_token_matches_email(payload, user.email or ""):
        raise HTTPException(status_code=400, detail="invalid_or_expired_token")
    if user.email_verified_at is not None:
        # Single-use: the token is spent the moment the stamp lands, so a
        # replay cannot fire the side effects twice.
        raise HTTPException(status_code=400, detail="already_verified")

    user.email_verified_at = datetime.now(UTC)
    full_name = " ".join(p for p in (user.first_name, user.last_name) if p).strip()
    seq = _next_message_seq(db)
    db.add(Message(
        id=str(uuid_mod.uuid4()), type="signup", status="new", seq=seq,
        user_id=None,  # the shared staff inbox — all four staff see it
        payload={
            "first_name": user.first_name or "",
            "last_name": user.last_name or "",
            "full_name": full_name,
            "email": user.email,
            "country": user.signup_country,
        },
    ))
    db.add(Message(
        id=str(uuid_mod.uuid4()), type="welcome", status="new", seq=seq + 1,
        user_id=user.id,  # their inbox only
        payload={"first_name": user.first_name or "", "full_name": full_name},
    ))
    db.commit()

    background_tasks.add_task(email_service.send_welcome_email, user.email,
                              user.first_name)
    return {"status": "ok"}


@router.post("/resend-verification")
async def resend_verification(
    body: ResendVerificationRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Always the generic OK. Unlike signup, this endpoint has no UX reason to
    be an oracle, so it keeps the anti-enumeration invariant."""
    retry_after = limiter.retry_after(signup_ip_key(request))
    if retry_after:
        return GENERIC_OK

    email = (body.email or "").strip().lower()
    user = db.query(User).filter(func.lower(User.email) == email).first()
    if user is not None and user.email_verified_at is None:
        verify_url = (
            f"{settings.APP_BASE_URL.rstrip('/')}/admin/verify"
            f"?token={create_verify_token(str(user.id), email)}"
        )
        background_tasks.add_task(
            email_service.send_verification_email, email, user.first_name, verify_url
        )
    return GENERIC_OK
```

Add imports: `from app.models import Message`, plus `decode_verify_token` and `verify_token_matches_email` to the existing `auth_service` import block.

- [ ] **Step 4: Run the test**

Run: `cd api && pytest tests/test_verify_endpoint.py -q`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add api/app/routes/auth.py api/tests/test_verify_endpoint.py
git commit -m "feat(auth): verify + resend, and the two message rows they create"
```

---

## Task 9: The login gate, and reset skipping unverified

**Files:**
- Modify: `api/app/routes/auth.py`
- Test: `api/tests/test_forgot_password_skips_unverified.py`, add to `api/tests/test_signup.py`

**Interfaces:**
- Produces: `403 {"detail": "email_not_verified"}` on login for a verified-password/unverified-email customer.

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_forgot_password_skips_unverified.py`:

```python
"""D14: an unverified account never receives a reset link.

The right door for someone who never verified is resend-verification. Each
door does one job.
"""
from unittest.mock import patch

from app.models import User
from app.services.auth_service import create_verify_token
from app.services.rate_limit import limiter, reset_probes

GOOD = {"first_name": "Ada", "last_name": "Lovelace",
        "email": "ada@test.example", "password": "Analytical1!"}


def setup_function():
    limiter.reset()
    reset_probes()


def test_no_reset_mail_for_an_unverified_account(client, db_session):
    client.post("/api/auth/signup", json=GOOD)
    with patch("app.routes.auth.email_service.send_password_reset") as sender:
        r = client.post("/api/auth/forgot-password", json={"identifier": GOOD["email"]})
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
    sender.assert_not_called()


def test_the_response_is_identical_to_the_verified_case(client, db_session):
    client.post("/api/auth/signup", json=GOOD)
    unverified = client.post("/api/auth/forgot-password",
                             json={"identifier": GOOD["email"]})
    user = db_session.query(User).filter(User.email == GOOD["email"]).first()
    client.post("/api/auth/verify",
                json={"token": create_verify_token(str(user.id), user.email)})
    verified = client.post("/api/auth/forgot-password",
                           json={"identifier": GOOD["email"]})
    assert unverified.status_code == verified.status_code
    assert unverified.json() == verified.json()


def test_login_refuses_an_unverified_customer_with_the_right_password(client, db_session):
    client.post("/api/auth/signup", json=GOOD)
    r = client.post("/api/auth/login",
                    json={"email": GOOD["email"], "password": GOOD["password"]})
    assert r.status_code == 403
    assert r.json()["detail"] == "email_not_verified"


def test_a_wrong_password_still_gets_the_generic_401(client, db_session):
    # Learning "unverified" must require ALREADY knowing the password, or
    # login becomes an account-existence oracle.
    client.post("/api/auth/signup", json=GOOD)
    r = client.post("/api/auth/login",
                    json={"email": GOOD["email"], "password": "Wrong1!aa"})
    assert r.status_code == 401
    assert r.json()["detail"] == "Invalid credentials"


def test_a_verified_customer_can_sign_in(client, db_session):
    client.post("/api/auth/signup", json=GOOD)
    user = db_session.query(User).filter(User.email == GOOD["email"]).first()
    client.post("/api/auth/verify",
                json={"token": create_verify_token(str(user.id), user.email)})
    r = client.post("/api/auth/login",
                    json={"email": GOOD["email"], "password": GOOD["password"]})
    assert r.status_code == 200
    assert r.json()["user"]["role"] == "user"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_forgot_password_skips_unverified.py -q`
Expected: FAIL — login returns 200, and the reset mail is sent.

- [ ] **Step 3: Add the login gate**

In `api/app/routes/auth.py`, in the `login` handler, immediately AFTER the password verifies and BEFORE the session is minted:

```python
    # Activation is deliberately NOT checked here (D17) — a verified but
    # unactivated customer signs in fine and meets "awaiting approval" at the
    # console. Refusing at the door would be indistinguishable from a bad
    # password, which is the wrong message for someone who did everything right.
    if user.role == "user" and user.email_verified_at is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="email_not_verified"
        )
```

- [ ] **Step 4: Make forgot-password skip unverified accounts**

In the `forgot_password` handler, where the matched user is checked before sending, add the condition:

```python
    # D14: no reset link for an unverified address. The door for someone who
    # never verified is resend-verification. Falls through to the SAME generic
    # OK, so this leaks nothing.
    if user is not None and user.role == "user" and user.email_verified_at is None:
        user = None
```

- [ ] **Step 5: Run the tests**

Run: `cd api && pytest tests/test_forgot_password_skips_unverified.py tests/test_auth_recovery.py -q`
Expected: PASS both files.

- [ ] **Step 6: Commit**

```bash
git add api/app/routes/auth.py api/tests/test_forgot_password_skips_unverified.py
git commit -m "feat(auth): unverified customers cannot sign in or reset"
```

---

## Task 10: Tier derivation

**Files:**
- Create: `api/app/services/account_tier.py`
- Test: `api/tests/test_account_tier.py`

**Interfaces:**
- Produces: `account_tier(db, user) -> str` returning `"free" | "silver" | "gold" | "platinum"`.

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_account_tier.py`:

```python
from app.models import Sponsor, User
from app.services.account_tier import account_tier


def _customer(db, supplier_id=None):
    u = User(username="c@test.example", email="c@test.example",
             password_hash="x", role="user", supplier_id=supplier_id)
    db.add(u)
    db.flush()
    return u


def test_no_link_is_free(db_session):
    assert account_tier(db_session, _customer(db_session)) == "free"


def test_linked_with_no_sponsorship_is_free(db_session, seeded_db):
    supplier = db_session.query(Sponsor).first().supplier_id
    db_session.query(Sponsor).filter(Sponsor.supplier_id == supplier).delete()
    db_session.flush()
    assert account_tier(db_session, _customer(db_session, supplier)) == "free"


def test_highest_active_tier_wins(db_session, seeded_db):
    supplier = db_session.query(Sponsor).first().supplier_id
    db_session.add(Sponsor(supplier_id=supplier, keyword="kw-a", tier="Silver",
                           status="Active"))
    db_session.add(Sponsor(supplier_id=supplier, keyword="kw-b", tier="Gold",
                           status="Active"))
    db_session.flush()
    assert account_tier(db_session, _customer(db_session, supplier)) == "gold"


def test_null_status_counts_as_active(db_session, seeded_db):
    # Legacy seed rows omit status; `status != 'Expired'` is UNKNOWN for NULL
    # and would silently skip them.
    supplier = db_session.query(Sponsor).first().supplier_id
    db_session.query(Sponsor).filter(Sponsor.supplier_id == supplier).delete()
    db_session.add(Sponsor(supplier_id=supplier, keyword="kw-c", tier="platinum",
                           status=None))
    db_session.flush()
    assert account_tier(db_session, _customer(db_session, supplier)) == "platinum"


def test_expired_does_not_count(db_session, seeded_db):
    supplier = db_session.query(Sponsor).first().supplier_id
    db_session.query(Sponsor).filter(Sponsor.supplier_id == supplier).delete()
    db_session.add(Sponsor(supplier_id=supplier, keyword="kw-d", tier="Gold",
                           status="Expired"))
    db_session.flush()
    assert account_tier(db_session, _customer(db_session, supplier)) == "free"


def test_casing_does_not_matter(db_session, seeded_db):
    # The admin writes TitleCase, legacy seed rows are lowercase, and `tier`
    # is a free string with no enum behind it.
    supplier = db_session.query(Sponsor).first().supplier_id
    db_session.query(Sponsor).filter(Sponsor.supplier_id == supplier).delete()
    db_session.add(Sponsor(supplier_id=supplier, keyword="kw-e", tier="  SILVER ",
                           status="Active"))
    db_session.flush()
    assert account_tier(db_session, _customer(db_session, supplier)) == "silver"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_account_tier.py -q`
Expected: FAIL — `ModuleNotFoundError: app.services.account_tier`.

- [ ] **Step 3: Implement**

Create `api/app/services/account_tier.py`:

```python
"""Account tier, DERIVED (D3) — there is no tier column to drift.

A customer's tier is the highest ACTIVE sponsorship held by the supplier they
are linked to. Everyone starts free, because signup never sets supplier_id.
"""
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import Sponsor, User

FREE = "free"
# Index = rank. The names are the /join tile names, not invented ones.
TIER_RANK = ("silver", "gold", "platinum")


def normalize_tier(raw: str | None) -> str:
    """Lowercase + strip. The admin writes TitleCase, legacy seed rows are
    lowercase, and `tier` is a free string with no enum behind it — a
    TitleCase-only comparison silently drops real rows."""
    return (raw or "").strip().lower()


def account_tier(db: Session, user: User) -> str:
    if user is None or user.supplier_id is None:
        return FREE
    rows = (
        db.query(Sponsor.tier)
        .filter(Sponsor.supplier_id == user.supplier_id)
        # NULL status means Active: legacy seed rows omit it, and
        # `status != 'Expired'` is UNKNOWN for NULL, which skips them.
        .filter(or_(Sponsor.status == "Active", Sponsor.status.is_(None)))
        .all()
    )
    best = FREE
    best_rank = -1
    for (raw,) in rows:
        tier = normalize_tier(raw)
        if tier in TIER_RANK and TIER_RANK.index(tier) > best_rank:
            best_rank = TIER_RANK.index(tier)
            best = tier
    return best
```

- [ ] **Step 4: Run the test**

Run: `cd api && pytest tests/test_account_tier.py -q`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add api/app/services/account_tier.py api/tests/test_account_tier.py
git commit -m "feat(account): derive tier from the linked supplier's active sponsorships"
```

---

## Task 11: /api/admin/users

**Files:**
- Create: `api/app/routes/admin_users.py`
- Modify: `api/app/main.py`, `api/tests/test_every_route_is_gated.py` (no change expected — verify)
- Test: `api/tests/test_admin_users.py`

**Interfaces:**
- Produces: `GET /api/admin/users/`, `PATCH /api/admin/users/{id}` (activate / link), `DELETE /api/admin/users/{id}` (owner-only).

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_admin_users.py`:

```python
from app.models import User


def _customer(db, email="c@test.example", activated_at=None):
    u = User(username=email, email=email, password_hash="x", role="user",
             first_name="Ada", last_name="Lovelace", signup_country="US",
             activated_at=activated_at)
    db.add(u)
    db.flush()
    return u


def test_a_customer_cannot_read_the_roster(client, db_session, auth_header):
    _customer(db_session)
    db_session.commit()
    r = client.get("/api/admin/users/",
                   headers=auth_header(email="kennedy_user@test.example"))
    assert r.status_code == 403
    assert r.json()["detail"] == "staff_only"


def test_staff_can_read_the_roster(client, db_session, auth_header):
    _customer(db_session)
    db_session.commit()
    r = client.get("/api/admin/users/", headers=auth_header())
    assert r.status_code == 200
    emails = [row["email"] for row in r.json()]
    assert "c@test.example" in emails


def test_the_roster_carries_the_columns_the_page_renders(client, db_session, auth_header):
    _customer(db_session)
    db_session.commit()
    row = [u for u in client.get("/api/admin/users/",
                                 headers=auth_header()).json()
           if u["email"] == "c@test.example"][0]
    for key in ("id", "full_name", "email", "created_at", "signup_country",
                "website", "tier", "email_verified_at", "activated_at",
                "supplier_id", "manufacturer_id"):
        assert key in row, f"missing {key}"


def test_activation_stamps_and_is_idempotent(client, db_session, auth_header):
    u = _customer(db_session)
    db_session.commit()
    r = client.patch(f"/api/admin/users/{u.id}", json={"activated": True},
                     headers=auth_header())
    assert r.status_code == 200
    first = r.json()["activated_at"]
    assert first is not None
    again = client.patch(f"/api/admin/users/{u.id}", json={"activated": True},
                         headers=auth_header())
    assert again.json()["activated_at"] == first, "re-activating must not re-stamp"


def test_deactivation_clears_the_stamp(client, db_session, auth_header):
    from datetime import UTC, datetime

    u = _customer(db_session, activated_at=datetime.now(UTC))
    db_session.commit()
    r = client.patch(f"/api/admin/users/{u.id}", json={"activated": False},
                     headers=auth_header())
    assert r.json()["activated_at"] is None


def test_a_customer_cannot_activate_themselves(client, db_session, auth_header):
    u = _customer(db_session)
    db_session.commit()
    r = client.patch(f"/api/admin/users/{u.id}", json={"activated": True},
                     headers=auth_header(email="kennedy_user@test.example"))
    assert r.status_code == 403


def test_delete_is_owner_only(client, db_session, auth_header):
    u = _customer(db_session)
    db_session.commit()
    # `admin` is not `owner`.
    r = client.delete(f"/api/admin/users/{u.id}", headers=auth_header())
    assert r.status_code == 403
    assert r.json()["detail"] == "owner_only"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_admin_users.py -q`
Expected: FAIL — 404 on `/api/admin/users/`.

- [ ] **Step 3: Implement the router**

Create `api/app/routes/admin_users.py`:

```python
"""The registered-account roster. Staff-only.

These rows are real people's addresses and IP-derived locations. The demo
account that once made every authed page one click from anonymous is retired
(Task 1a), so require_staff is the whole gate.
"""
import uuid as uuid_mod
from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import Supplier, User
from app.services import email as email_service
from app.services.account_tier import account_tier
from app.services.auth_service import require_owner, require_staff

router = APIRouter(prefix="/api/admin/users", tags=["admin-users"],
                   dependencies=[Depends(require_staff)])

class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    activated: bool | None = None
    supplier_id: str | None = None
    manufacturer_id: str | None = None


def _row(db: Session, u: User) -> dict:
    supplier = (
        db.query(Supplier).filter(Supplier.id == u.supplier_id).first()
        if u.supplier_id else None
    )
    full_name = " ".join(p for p in (u.first_name, u.last_name) if p).strip()
    return {
        "id": str(u.id),
        "full_name": full_name or u.username,
        "email": u.email,
        "created_at": u.created_at,
        "signup_country": u.signup_country,
        # From the linked supplier, so "-" for an unlinked account, which is
        # most rows at launch and is correct rather than broken.
        "website": supplier.website if supplier else None,
        "company": supplier.name if supplier else None,
        "tier": account_tier(db, u),
        "email_verified_at": u.email_verified_at,
        "activated_at": u.activated_at,
        "supplier_id": str(u.supplier_id) if u.supplier_id else None,
        "manufacturer_id": str(u.manufacturer_id) if u.manufacturer_id else None,
    }


@router.get("/")
def list_users(db: Session = Depends(get_db),
               current_user: User = Depends(require_staff)):
    # Unactivated first: the page's job is to show you who is waiting.
    rows = (
        db.query(User)
        .filter(User.role == "user")
        .order_by(User.activated_at.isnot(None), User.created_at.desc())
        .all()
    )
    return [_row(db, u) for u in rows]


def _as_uuid(raw: str | None):
    if raw in (None, ""):
        return None
    try:
        return uuid_mod.UUID(raw)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=422, detail="invalid_id")


@router.patch("/{user_id}")
def update_user(user_id: str, body: UserUpdate,
                background_tasks: BackgroundTasks,
                db: Session = Depends(get_db),
                current_user: User = Depends(require_staff)):
    user = db.query(User).filter(User.id == _as_uuid(user_id)).first()
    if user is None or user.role != "user":
        raise HTTPException(status_code=404, detail="not_found")

    fields = body.model_dump(exclude_unset=True)
    activating = False
    if "activated" in fields:
        if fields["activated"]:
            # Idempotent: re-activating an active account must not re-stamp,
            # or the activation email fires again on every save.
            if user.activated_at is None:
                user.activated_at = datetime.now(UTC)
                activating = True
        else:
            user.activated_at = None
    if "supplier_id" in fields:
        user.supplier_id = _as_uuid(fields["supplier_id"])
    if "manufacturer_id" in fields:
        user.manufacturer_id = _as_uuid(fields["manufacturer_id"])
    db.commit()
    db.refresh(user)

    if activating:
        background_tasks.add_task(
            email_service.send_activation_email, user.email, user.first_name,
            f"{settings.APP_BASE_URL.rstrip('/')}/account?activated=1",
        )
    return _row(db, user)


@router.delete("/{user_id}")
def delete_user(user_id: str, db: Session = Depends(get_db),
                current_user: User = Depends(require_owner)):
    """Owner-only, matching how message deletion is gated for being
    irreversible. Deletes the LOGIN — never the linked Supplier or Sponsor,
    and never anything in Stripe."""
    user = db.query(User).filter(User.id == _as_uuid(user_id)).first()
    if user is None or user.role != "user":
        raise HTTPException(status_code=404, detail="not_found")
    db.delete(user)  # messages cascade via the FK
    db.commit()
    return {"status": "ok"}
```

Register it in `api/app/main.py` next to the other admin routers:

```python
app.include_router(admin_users.router)
```

...and add `admin_users` to that file's `from app.routes import (...)` list.

- [ ] **Step 4: Run the tests**

Run: `cd api && pytest tests/test_admin_users.py tests/test_every_route_is_gated.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/app/routes/admin_users.py api/app/main.py api/tests/test_admin_users.py
git commit -m "feat(admin): /api/admin/users — roster, activation, capability links"
```

---

## Task 12: /api/account/me and self-deletion

**Files:**
- Create: `api/app/routes/account.py`
- Modify: `api/app/main.py`
- Test: `api/tests/test_account_deletion.py`

**Interfaces:**
- Produces: `GET /api/account/me`, `DELETE /api/account/me`.

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_account_deletion.py`:

```python
from datetime import UTC, datetime

from app.models import Message, Sponsor, Supplier, User
from app.services.auth_service import hash_password

PW = "Analytical1!"


def _activated(db, supplier_id=None):
    u = User(username="c@test.example", email="c@test.example",
             password_hash=hash_password(PW), role="user",
             first_name="Ada", supplier_id=supplier_id,
             email_verified_at=datetime.now(UTC), activated_at=datetime.now(UTC))
    db.add(u)
    db.flush()
    return u


def _login(client, email="c@test.example", password=PW):
    r = client.post("/api/auth/login", json={"email": email, "password": password})
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_self_delete_requires_the_current_password(client, db_session):
    _activated(db_session)
    db_session.commit()
    h = _login(client)
    r = client.request("DELETE", "/api/account/me",
                       json={"password": "Wrong1!aa"}, headers=h)
    assert r.status_code == 401
    assert db_session.query(User).filter(User.email == "c@test.example").count() == 1


def test_self_delete_removes_the_login_and_their_messages(client, db_session):
    u = _activated(db_session)
    db_session.add(Message(id="m1", type="welcome", status="new", seq=9001,
                           user_id=u.id, payload={}))
    db_session.add(Message(id="m2", type="signup", status="new", seq=9002,
                           user_id=None, payload={}))
    db_session.commit()
    h = _login(client)
    r = client.request("DELETE", "/api/account/me", json={"password": PW}, headers=h)
    assert r.status_code == 200
    db_session.expire_all()
    assert db_session.query(User).filter(User.email == "c@test.example").count() == 0
    assert db_session.query(Message).filter(Message.id == "m1").count() == 0
    # The staff-inbox row is NOT theirs and must survive.
    assert db_session.query(Message).filter(Message.id == "m2").count() == 1


def test_self_delete_never_touches_the_company(client, db_session, seeded_db):
    supplier = db_session.query(Supplier).first()
    sponsors_before = db_session.query(Sponsor).filter(
        Sponsor.supplier_id == supplier.id).count()
    _activated(db_session, supplier_id=supplier.id)
    db_session.commit()
    h = _login(client)
    client.request("DELETE", "/api/account/me", json={"password": PW}, headers=h)
    db_session.expire_all()
    # An account is a key to the building, not the building. Deleting a login
    # must never pull a paid ad off a board.
    assert db_session.query(Supplier).filter(Supplier.id == supplier.id).count() == 1
    assert db_session.query(Sponsor).filter(
        Sponsor.supplier_id == supplier.id).count() == sponsors_before


def test_me_reports_tier_and_activation(client, db_session):
    _activated(db_session)
    db_session.commit()
    r = client.get("/api/account/me", headers=_login(client))
    assert r.status_code == 200
    body = r.json()
    assert body["tier"] == "free"
    assert body["activated"] is True


def test_an_unactivated_customer_is_refused(client, db_session):
    u = User(username="u@test.example", email="u@test.example",
             password_hash=hash_password(PW), role="user",
             email_verified_at=datetime.now(UTC), activated_at=None)
    db_session.add(u)
    db_session.commit()
    r = client.get("/api/account/me", headers=_login(client, "u@test.example"))
    assert r.status_code == 403
    assert r.json()["detail"] == "account_not_activated"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_account_deletion.py -q`
Expected: FAIL — 404 on `/api/account/me`.

- [ ] **Step 3: Implement**

Create `api/app/routes/account.py`:

```python
"""The customer's own account. Deliberately tiny.

Project 1 gives customers the CONSOLE pages (D16), gated on activation (D17).
This router is only the things that are about the account itself and have no
admin equivalent: who am I, and delete me.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import User
from app.services.account_tier import account_tier
from app.services.auth_service import require_account_user, verify_password

router = APIRouter(prefix="/api/account", tags=["account"])


class DeleteAccountRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    password: str


@router.get("/me")
def me(db: Session = Depends(get_db),
       user: User = Depends(require_account_user)):
    full_name = " ".join(p for p in (user.first_name, user.last_name) if p).strip()
    return {
        "id": str(user.id),
        "full_name": full_name or user.username,
        "email": user.email,
        "created_at": user.created_at,
        "tier": account_tier(db, user),
        "activated": user.activated_at is not None,
        # D18 — capability is the links. Both may be set (Avnet).
        "is_supplier": user.supplier_id is not None,
        "is_manufacturer": user.manufacturer_id is not None,
    }


@router.delete("/me")
def delete_me(body: DeleteAccountRequest, db: Session = Depends(get_db),
              user: User = Depends(require_account_user)):
    """Danger Zone. Deletes the LOGIN and that user's messages.

    Never the linked Supplier, never a Sponsor, never anything in Stripe: a
    live placement is paid inventory on a public board, and cancelling it
    because someone closed their sign-in would be destroying revenue.
    """
    # Re-authenticate: a stolen session must not be able to destroy an account.
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Invalid credentials")
    db.delete(user)  # messages cascade via the FK; nothing else is touched
    db.commit()
    return {"status": "ok"}
```

Register in `api/app/main.py`: `app.include_router(account.router)` plus the import.

- [ ] **Step 4: Run the tests**

Run: `cd api && pytest tests/test_account_deletion.py tests/test_every_route_is_gated.py -q`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite**

Run: `cd api && pytest tests/ -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/app/routes/account.py api/app/main.py api/tests/test_account_deletion.py
git commit -m "feat(account): GET /api/account/me and the Danger Zone delete"
```

---

## Task 13: The Sign Up screen

**Files:**
- Create: `frontend/src/admin/pages/login/screens/SignUp.tsx`
- Modify: `frontend/src/admin/pages/login/screens/types.ts`, `frontend/src/admin/pages/login/index.tsx`, `frontend/src/admin/pages/login/screens/SignIn.tsx`, `frontend/src/admin/pages/login/LoginPage.module.scss`, `frontend/src/admin/services/adminApi.ts`
- Test: `frontend/src/admin/pages/login/screens/signupForm.test.ts`

**Interfaces:**
- Consumes: `POST /api/auth/signup` (Task 7).
- Produces: `adminApi.signup(first_name, last_name, email, password)`, `adminApi.resendVerification(email)`, `adminApi.verifyEmail(token)`; `Screen` gains `'signup'`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/admin/pages/login/screens/signupForm.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { signupFieldErrors } from './signupForm';

const ok = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  password: 'Analytical1!',
  confirm: 'Analytical1!',
};

describe('signupFieldErrors', () => {
  it('accepts a complete valid form', () => {
    expect(signupFieldErrors(ok)).toEqual({});
  });

  it('requires both names', () => {
    expect(signupFieldErrors({ ...ok, firstName: '  ' }).firstName).toBeTruthy();
    expect(signupFieldErrors({ ...ok, lastName: '' }).lastName).toBeTruthy();
  });

  it('rejects an address with no @', () => {
    expect(signupFieldErrors({ ...ok, email: 'nope' }).email).toBeTruthy();
  });

  it('reports an unmet password policy', () => {
    expect(signupFieldErrors({ ...ok, password: 'short', confirm: 'short' }).password)
      .toBeTruthy();
  });

  it('reports a mismatch on the confirm box, not the password box', () => {
    const errs = signupFieldErrors({ ...ok, confirm: 'Analytical1?' });
    expect(errs.confirm).toBeTruthy();
    expect(errs.password).toBeUndefined();
  });

  it('does not complain about an empty confirm box before it is typed in', () => {
    // A form that opens red is a form that has already annoyed you.
    expect(signupFieldErrors({ ...ok, confirm: '' }).confirm).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- signupForm`
Expected: FAIL — cannot resolve `./signupForm`.

- [ ] **Step 3: Implement the pure validator**

Create `frontend/src/admin/pages/login/screens/signupForm.ts`:

```ts
import { isPasswordValid } from '@admin/services/passwordPolicy';

export interface SignupFields {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirm: string;
}

export type SignupErrors = Partial<Record<keyof SignupFields, string>>;

// Same shape as the public forms: type="text" + JS validation, never
// type="email" (an HTML5-invalid value kills submit silently, with no
// console error and no :invalid styling).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function signupFieldErrors(fields: SignupFields): SignupErrors {
  const errors: SignupErrors = {};
  if (!fields.firstName.trim()) errors.firstName = 'Enter your first name';
  if (!fields.lastName.trim()) errors.lastName = 'Enter your last name';
  if (!EMAIL_RE.test(fields.email.trim())) errors.email = 'Enter a valid email address';
  if (!isPasswordValid(fields.password)) errors.password = 'Password does not meet the rules below';
  // Only complain once they have started typing — an empty confirm box is a
  // form that is not finished, not a form that is wrong.
  if (fields.confirm.length > 0 && fields.confirm !== fields.password) {
    errors.confirm = 'Passwords do not match';
  }
  return errors;
}
```

- [ ] **Step 4: Run the test**

Run: `cd frontend && npm test -- signupForm`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the API methods**

In `frontend/src/admin/services/adminApi.ts`, alongside `login`:

```ts
  signup: (firstName: string, lastName: string, email: string, password: string) =>
    adminClient
      .post<{ status: string }>('/auth/signup', {
        first_name: firstName,
        last_name: lastName,
        email,
        password,
      })
      .then((r) => r.data),

  verifyEmail: (token: string) =>
    adminClient.post<{ status: string }>('/auth/verify', { token }).then((r) => r.data),

  resendVerification: (email: string) =>
    adminClient
      .post<{ status: string }>('/auth/resend-verification', { email })
      .then((r) => r.data),
```

- [ ] **Step 6: Add the screen**

In `frontend/src/admin/pages/login/screens/types.ts`:

```ts
export type Screen = 'signin' | 'forgot-password' | 'signup';
```

Create `frontend/src/admin/pages/login/screens/SignUp.tsx`. It reuses the
folder's existing literal classes — no new CSS beyond `.banner-ok` in Step 7.

**Read `../components/Field.tsx` first.** The snippet below assumes props
`label`, `value`, `onChange`, `error`, `type`, `reveal`, `revealed`,
`onReveal`. If `autoComplete` or `inputMode` are not already passed through to
the inner `<input>`, add them to `Field`'s props rather than dropping them —
`autoComplete="new-password"` is what stops a password manager overwriting the
confirm box with the saved password for the site.

```tsx
import { useState } from 'react';
import Field from '../components/Field';
import SubmitButton from '../components/SubmitButton';
import { I, Svg } from '../components/icons';
import adminApi from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import { PASSWORD_RULES, validatePassword } from '@admin/services/passwordPolicy';
import { signupFieldErrors } from './signupForm';
import type { Screen } from './types';

export default function SignUp({ go }: { go: (s: Screen) => void }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState('');
  const [sent, setSent] = useState(false);

  const fields = { firstName, lastName, email, password, confirm };
  const errors = signupFieldErrors(fields);
  const unmet = validatePassword(password);
  const pristine = password.length === 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBanner('');
    if (Object.keys(errors).length > 0 || confirm !== password) {
      setBanner('Check the highlighted fields.');
      return;
    }
    setBusy(true);
    try {
      await adminApi.signup(firstName, lastName, email, password);
      setSent(true);
    } catch (err) {
      const detail = apiErrorDetail(err);
      setBanner(
        detail === 'email_taken'
          ? 'An account already uses this address. Sign in instead.'
          : detail || 'Could not create the account. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="screen">
        <div className="success">
          <div className="success-mark"><Svg d={I.check} /></div>
          <h2>Check your email</h2>
          <p className="lede">
            We sent a confirmation link to <strong>{email}</strong>. The link
            works for 24 hours.
          </p>
          <div className="success-actions">
            <button type="button" className="btn-ghost" onClick={() => go('signin')}>
              Back to sign in
            </button>
          </div>
          <p className="resend">
            Nothing arrived?{' '}
            <button type="button" onClick={() => adminApi.resendVerification(email)}>
              Send it again
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <p className="eyebrow"><span className="dot" /> Create an account</p>
      <h2>Get started</h2>
      <p className="lede">Set up your Circuit Center account. It takes a minute.</p>

      {banner && <div className="banner" role="alert">{banner}</div>}

      <form onSubmit={onSubmit} noValidate>
        <Field label="First name" value={firstName} onChange={setFirstName}
               error={errors.firstName} autoComplete="given-name" />
        <Field label="Last name" value={lastName} onChange={setLastName}
               error={errors.lastName} autoComplete="family-name" />
        <Field label="Work email" value={email} onChange={setEmail}
               error={errors.email} inputMode="email" autoComplete="email" />
        <Field label="Password" value={password} onChange={setPassword}
               error={errors.password} type={show ? 'text' : 'password'}
               reveal revealed={show} onReveal={() => setShow((v) => !v)}
               autoComplete="new-password" />
        <Field label="Confirm password" value={confirm} onChange={setConfirm}
               error={errors.confirm} type={show ? 'text' : 'password'}
               autoComplete="new-password" />

        <ul className="rules">
          {PASSWORD_RULES.map((rule) => {
            const met = !unmet.includes(rule.key);
            const cls = pristine ? 'rule-idle' : met ? 'rule-ok' : 'rule-no';
            return (
              <li key={rule.key} className={`rule ${cls}`}>
                <span className="rule-mark">{met && !pristine && <Svg d={I.check} />}</span>
                {rule.label}
                <span className="rule-state">{met ? ' (met)' : ' (not met yet)'}</span>
              </li>
            );
          })}
        </ul>

        <SubmitButton busy={busy} label="Create account"
                      busyLabel={<>Creating&hellip;</>} />
      </form>

      <div className="form-meta">
        <p className="recover-line">
          Already have an account?{' '}
          <button type="button" onClick={() => go('signin')}>Sign in</button>
        </p>
      </div>
    </div>
  );
}
```

In `frontend/src/admin/pages/login/index.tsx`, add the arm next to the others:

```tsx
      {screen === 'signup' && <SignUp go={setScreen} />}
```

- [ ] **Step 7: Add the Sign Up link and the success banner**

Task 1a already replaced the demo block with the primary **Sign Up** CTA. Add
the quieter text link too, inside `.form-meta` directly after the recover line,
so both a scanner and a reader find the door:

```tsx
        <p className="recover-line">
          New here?{' '}
          <button type="button" onClick={() => go('signup')}>Create an account</button>
        </p>
```

At the top of the same component, read the verification banner:

```tsx
  const [params] = useSearchParams();
  const welcome = params.get('welcome') === '1';
```

...and render it above the form:

```tsx
      {welcome && (
        <div className="banner-ok" role="status">
          Email confirmed. Sign in below.
        </div>
      )}
```

In `frontend/src/admin/pages/login/LoginPage.module.scss`, inside the
`:global { ... }` block next to `.banner`:

```scss
    /* Success sibling of .banner. Same geometry, no shake — nothing went
       wrong, so nothing should shudder. */
    .banner-ok {
      background: rgba(68, 189, 19, 0.10);
      border: 1px solid rgba(68, 189, 19, 0.45);
      color: #0a4a2e;
      border-radius: 8px;
      padding: 11px 14px;
      font-size: 14px;
      margin-bottom: 16px;
    }
```

- [ ] **Step 8: Type-gate and test**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`
Expected: all three exit 0.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/admin/
git commit -m "feat(admin): Sign Up screen, and the link to it on the sign-in panel"
```

---

## Task 14: The verify page and role-aware routing

**Files:**
- Create: `frontend/src/admin/pages/verify/index.tsx`, `frontend/src/admin/routes/ConsoleRoutes.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/admin/components/ProtectedRoute.tsx`, `frontend/src/admin/contexts/AuthContext.tsx`

**Interfaces:**
- Consumes: `adminApi.verifyEmail` (Task 13), `POST /api/auth/verify` (Task 8).
- Produces: routes `/admin/signup`, `/admin/verify`, `/account/*`.

- [ ] **Step 1: Create the verify page**

`frontend/src/admin/pages/verify/index.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import AuthShell from '@admin/pages/login/components/AuthShell';
import adminApi from '@admin/services/adminApi';

/**
 * Spends the emailed verification token.
 *
 * The token is spent by a POST this page performs, NOT by a GET on the link
 * itself: corporate mail scanners prefetch every URL in a message, so a GET
 * would be consumed before the human ever clicked.
 */
export default function VerifyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const fired = useRef(false);

  useEffect(() => {
    // StrictMode double-invokes effects in dev; the token is single-use, so a
    // second POST would report "already_verified" on a perfectly good link.
    if (fired.current) return;
    fired.current = true;
    const token = params.get('token');
    if (!token) {
      setError('That link is missing its code. Use the link from your email.');
      return;
    }
    let cancelled = false;
    adminApi
      .verifyEmail(token)
      .then(() => {
        if (!cancelled) navigate('/admin/login?welcome=1', { replace: true });
      })
      .catch(() => {
        if (!cancelled) {
          setError('That link has expired or has already been used.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [params, navigate]);

  return (
    <AuthShell>
      <div className="screen">
        <p className="eyebrow"><span className="dot" /> Confirming your email</p>
        <h2>{error ? 'That link did not work' : 'One moment'}</h2>
        {error ? (
          <>
            <p className="lede">{error}</p>
            <div className="success-actions">
              <button type="button" className="btn-ghost"
                      onClick={() => navigate('/admin/login', { replace: true })}>
                Back to sign in
              </button>
            </div>
          </>
        ) : (
          <p className="lede">Checking your confirmation link&hellip;</p>
        )}
      </div>
    </AuthShell>
  );
}
```

- [ ] **Step 2: Make ProtectedRoute role-aware**

Replace `frontend/src/admin/components/ProtectedRoute.tsx`:

```tsx
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@admin/contexts/AuthContext';
import type { ReactNode } from 'react';

const CUSTOMER_ROLES = ['user'];

/**
 * @param area which mount this guard is protecting. A principal who reaches
 * the wrong mount is REDIRECTED to their own, not 403'd — a wrong-door
 * redirect is better UX, and the server refuses regardless.
 */
export default function ProtectedRoute(
  { children, area = 'admin' }: { children: ReactNode; area?: 'admin' | 'account' },
) {
  const { isAuthenticated, loading, mustChangePassword, user } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', fontSize: '18px', color: '#6b7280' }}>
        Loading...
      </div>
    );
  }

  if (!isAuthenticated) return <Navigate to="/admin/login" replace />;
  if (mustChangePassword) return <Navigate to="/admin/change-password" replace />;

  const isCustomer = CUSTOMER_ROLES.includes(user?.role ?? '');
  if (isCustomer && area === 'admin') {
    return <Navigate to="/account" replace state={{ from: location.pathname }} />;
  }
  if (!isCustomer && area === 'account') {
    return <Navigate to="/admin" replace />;
  }

  return <>{children}</>;
}
```

- [ ] **Step 3: Extract ConsoleRoutes**

Create `frontend/src/admin/routes/ConsoleRoutes.tsx` holding the nested
`<Routes>` block currently inline in `App.tsx` (the one with index→Dashboard,
`suppliers`, `manufacturers`, `leads`, `parts`, `import`, `reports`,
`categories`, `sponsors`, `expenses`, `messages`, `settings`). Move it
verbatim; change nothing about the route table itself. Add the users route:

```tsx
(Route registration for /users moved to Task 15 — see ledger ruling R1.)
```

The component takes no props — the two mounts differ only in their guard and
their URL prefix, and React Router resolves relative paths from the mount.

- [ ] **Step 4: Wire the routes in App.tsx**

In the admin block of `frontend/src/App.tsx`, add the two unauthenticated
routes as siblings of `/admin/login` (OUTSIDE `ProtectedRoute`):

```tsx
            <Route path="/admin/signup" element={<LoginPage />} />
            <Route path="/admin/verify" element={<VerifyPage />} />
```

...and replace the inline nested `<Routes>` with `<ConsoleRoutes />`, wrapped
as before. Then add the `/account` mount alongside it:

```tsx
        <Route
          path="/account/*"
          element={
            <ProtectedRoute area="account">
              <AdminLayout>
                <ErrorBoundary key={location.pathname}>
                  <ConsoleRoutes />
                </ErrorBoundary>
              </AdminLayout>
            </ProtectedRoute>
          }
        />
```

Add the lazy imports next to the existing admin ones:

```tsx
const VerifyPage = lazy(() => import('@admin/pages/verify'));
const ConsoleRoutes = lazy(() => import('@admin/routes/ConsoleRoutes'));
```

Also extend the pathname test that gates the admin block so it matches the new
mount:

```tsx
  if (location.pathname.startsWith('/admin') || location.pathname.startsWith('/account')) {
```

- [ ] **Step 5: Expose `role` on the auth context**

`AuthContext`'s `user` is already `UserInfo`, which carries `role` — confirm
`ProtectedRoute` can read `user.role` and add nothing if so. If `UserInfo` is
narrowed anywhere, widen it to include `role: string`.

- [ ] **Step 6: Type-gate and lint**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`
Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/
git commit -m "feat(admin): verify page, role-aware routing, console mounted at /account"
```

---

## Task 15: The /admin/users page

**Files:**
- Create: `frontend/src/admin/pages/users/list/index.tsx`, `frontend/src/admin/pages/users/list/UsersListPage.module.scss`
- Modify: `frontend/src/admin/services/adminApi.ts`, `frontend/src/admin/components/AdminLayout.tsx` (sidebar link)

**Interfaces:**
- Consumes: `GET/PATCH/DELETE /api/admin/users` (Task 11).
- Produces: `adminApi.getUsers()`, `adminApi.updateUser(id, patch)`.

- [ ] **Step 1: Add the API methods**

In `frontend/src/admin/services/adminApi.ts`:

```ts
  getUsers: () =>
    adminClient.get<AdminUser[]>('/admin/users/').then((r) => r.data),

  updateUser: (
    id: string,
    patch: { activated?: boolean; supplier_id?: string | null; manufacturer_id?: string | null },
  ) => adminClient.patch<AdminUser>(`/admin/users/${id}`, patch).then((r) => r.data),
```

...with the type, in `frontend/src/admin/types/users.ts`:

```ts
export interface AdminUser {
  id: string;
  full_name: string;
  email: string;
  created_at: string;
  // `?: T | null` because Python None becomes JSON null, which `?: T` alone
  // does NOT catch — read these with `!= null`.
  signup_country?: string | null;
  website?: string | null;
  company?: string | null;
  tier: 'free' | 'silver' | 'gold' | 'platinum';
  email_verified_at?: string | null;
  activated_at?: string | null;
  supplier_id?: string | null;
  manufacturer_id?: string | null;
}
```

- [ ] **Step 2: Build the page**

Create `frontend/src/admin/pages/users/list/index.tsx` modelled on the
manufacturers list. Columns, in order:

`Name` · `Email` · `Member Since` · `Location` · `Website` · `Tier` ·
`Verified` · `Company` · `Activate`

Requirements:
- Fetch with the cancel-flag pattern: `let cancelled = false; ... return () => { cancelled = true; }`, gating every `.then`/`.catch` on `if (cancelled) return;`.
- Unactivated rows sort first (the server already does this; do not re-sort into created-desc and undo it).
- **Location** renders `signup_country` and the page carries the DB-IP attribution line the Reports map already uses: `IP geolocation by DB-IP (CC BY 4.0)`.
- **Website** renders `—` when null. Most rows at launch, and correct.
- The Activate control is a toggle calling `adminApi.updateUser(id, { activated })`, optimistic with rollback on failure.

- [ ] **Step 3: Register the route and add the sidebar link**

In `frontend/src/admin/routes/ConsoleRoutes.tsx` (created in Task 14), add the
route alongside the others. It lands here rather than in Task 14 because Task
14 would otherwise import a component that does not exist yet:

```tsx
        <Route path="users" element={<UsersListPage />} />
```

...with its lazy import beside the other page imports in that file:

```tsx
const UsersListPage = lazy(() => import('@admin/pages/users/list'));
```

Note this route is reachable at BOTH mounts, so `/account/users` resolves.
That is acceptable under D16 (the console is shared) and the server refuses:
`/api/admin/users` is `require_staff`, so a customer sees the page chrome and
an error, not a roster. Trimming customer-side routes is Project 2 work.

Then the sidebar link:

In `AdminLayout.tsx`'s nav array, next to Manufacturers:

```tsx
  { to: '/admin/users', label: 'Users', icon: 'users-three' },
```

- [ ] **Step 4: Verify no raw icon names render as text**

Run: `grep -rn ">{[a-zA-Z_]*\.icon}<" frontend/src --include="*.tsx"`
Expected: no output.

- [ ] **Step 5: Type-gate, lint, test**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/admin/
git commit -m "feat(admin): the registered-users roster with the activation toggle"
```

---

## Task 16: The two message types

**Files:**
- Modify: `frontend/src/admin/types/messages.ts`, `frontend/src/admin/components/messages/messageHelpers.ts`, `MessageChips.tsx`, `MessageDetailBodies.tsx`, `frontend/src/admin/pages/messages/detail/index.tsx`, `api/app/services/demo_messages.py`

**Interfaces:**
- Consumes: the `signup`/`welcome` rows from Task 8.

- [ ] **Step 1: Extend the union**

In `frontend/src/admin/types/messages.ts`:

```ts
export type MessageType = 'contact' | 'join' | 'keyword' | 'reply' | 'signup' | 'welcome';

export interface SignupPayload {
  first_name: string;
  last_name: string;
  full_name: string;
  email: string;
  country?: string | null;
}

export interface WelcomePayload {
  first_name: string;
  full_name: string;
}
```

Add to `MessageBase`:

```ts
  /** NULL = the shared staff inbox. Populated = one customer's inbox. */
  user_id?: string | null;
```

Add the two union arms:

```ts
  | (MessageBase & { type: 'signup'; payload: SignupPayload })
  | (MessageBase & { type: 'welcome'; payload: WelcomePayload })
```

- [ ] **Step 2: Extend the type metadata**

In `messageHelpers.ts`, add to `TYPE_META`:

```ts
  signup:  { label: 'SIGNUP',  color: '#153f80', tint: 'rgba(21,63,128,.10)' },
  welcome: { label: 'WELCOME', color: '#4d189e', tint: 'rgba(77,24,158,.10)' },
```

Extend the `subjectFor` and `senderName` switches:

```ts
    case 'signup':
      return `${m.payload.full_name} signed up`;
    case 'welcome':
      return 'Welcome to Circuit Center';
```

In `MessageChips.tsx`, add `signup: UserPlus` and `welcome: Sparkles` to
`TYPE_ICON` (both from lucide-react, which the file already imports from).

- [ ] **Step 3: Add the bodies**

In `MessageDetailBodies.tsx`, add `SignupBody` and `WelcomeBody` built from the
same primitives as `ContactBody` — the initials avatar, a KV grid (Name /
Email / Location), and the datasheet frame. **No new illustration** (D10 —
the owner is choosing that treatment separately).

Then add both branches in `pages/messages/detail/index.tsx`, at the subject
switch (~line 143) and the body switch (~line 172):

```tsx
  {m.type === 'signup' && `${m.payload.full_name} signed up`}
  {m.type === 'welcome' && 'Welcome to Circuit Center'}
```

```tsx
    {m.type === 'signup' && <SignupBody m={m} />}
    {m.type === 'welcome' && <WelcomeBody m={m} />}
```

- [ ] **Step 4: Nothing to add for the demo**

`demo_messages.py` was deleted in Task 1a. Skip this step — it exists only so
you do not go looking for the file.

- [ ] **Step 5: Type-gate, lint, test**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`
Run: `cd api && pytest tests/ -q`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/admin/ api/app/services/demo_messages.py
git commit -m "feat(messages): signup and welcome message types"
```

---

## Task 17: The Danger Zone, and an end-to-end pass

**Files:**
- Create: `frontend/src/admin/pages/settings/DangerZone.tsx`
- Modify: `frontend/src/admin/pages/settings/index.tsx`, `frontend/src/admin/services/adminApi.ts`

- [ ] **Step 1: Add the API method**

```ts
  deleteMyAccount: (password: string) =>
    adminClient
      .request<{ status: string }>({ method: 'delete', url: '/account/me', data: { password } })
      .then((r) => r.data),
```

(axios needs `request` with `data` — `delete` drops a body.)

- [ ] **Step 2: Build the panel**

Create `frontend/src/admin/pages/settings/DangerZone.tsx`. It renders **only
for a customer** (`user.role === 'user'`), requires the current password in a
`type="password"` field, and requires typing `DELETE` to enable the button.

The confirmation copy must say plainly what survives:

> Deleting your account removes your sign-in and your messages. **Your
> company's listings and any active sponsorship keep running and keep
> billing** — contact us if you want those changed.

On success: `logout()` then `navigate('/admin/login', { replace: true })`.

Mount it at the bottom of `pages/settings/index.tsx`, gated on the role.

- [ ] **Step 3: Type-gate, lint, test**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`
Expected: all exit 0.

- [ ] **Step 4: Full-stack rebuild**

Run: `docker compose up -d --build api frontend && docker compose logs api --tail 30`
Expected: alembic reaches `043`, seed completes, uvicorn starts.

- [ ] **Step 5: End-to-end walkthrough**

With the stack up, verify by hand:

1. `http://localhost/admin/login` shows the **Sign Up** button where See Demo used to be, plus the quieter "Create an account" text link. No demo button anywhere.
2. Sign up → "Check your email".
3. Grab the link from the api logs (`SMTP_HOST` unset → `[email demo-mode] would send…`), open it → redirected to `/admin/login?welcome=1` with the green banner.
4. Sign in → lands on "awaiting approval" (403 `account_not_activated` behind it).
5. Sign in as staff → `/admin/users` shows the account, unactivated, first in the list.
6. Toggle Activate → the activation email appears in the logs.
7. Sign in as the customer → the console renders at `/account`.
8. Visit `/admin/parts` as the customer → redirected to `/account`.
9. `/admin/messages` as staff → the **signup** card is there.
10. `/account/messages` as the customer → the **welcome** card, and NOT the signup card.

- [ ] **Step 6: Full suite, both sides**

Run: `cd api && pytest tests/ -q`
Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/admin/
git commit -m "feat(account): Danger Zone self-deletion"
```

---

## Done criteria

- [ ] `pytest tests/ -q` green, including all fourteen new test files
- [ ] `npx tsc -b`, `npx eslint --ext .ts,.tsx src/`, `npm test` all exit 0
- [ ] `test_every_route_is_gated.py` passes and its allowlist contains only real routes
- [ ] The end-to-end walkthrough in Task 17 Step 5 completes
- [ ] `git log --oneline master..updates` shows one commit per task
- [ ] **Not deployed.** Deploy is a separate decision — run `deploy-preflight` first, and note that migration 043 renames an enum value on production data.
