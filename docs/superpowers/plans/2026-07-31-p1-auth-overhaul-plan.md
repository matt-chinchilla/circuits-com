# P1 — Auth overhaul: implementation plan

Executes phase P1 of `docs/superpowers/specs/2026-07-31-mail-server-and-auth-design.md`.
Email becomes the login key; temporary passwords are force-rotated under a real
policy; sessions die on password change; login gets rate limited; the `owner`
tier lands for later phases.

No mail-server dependency — this ships on its own.

## Global Constraints

- **Branch:** `updates` (repo convention: `master` is the deploy tip). No deploy
  in this plan; committing only.
- **Never break the demo login.** `demo` / `demo` must keep working end-to-end,
  exempt from the forced reset (`must_change_password = false`).
- **Anti-enumeration is preserved everywhere.** Login timing stays equalized
  (existing dummy-hash path), recovery endpoints keep returning the generic OK,
  and rate-limit rejections must not reveal whether an account exists.
- **Password policy (exact):** 8–24 characters inclusive, ≥1 uppercase letter,
  ≥1 digit, ≥1 symbol (non-alphanumeric). One server-side module is the source
  of truth; the frontend mirrors the same rule list.
- **Gates:** `cd api && python -m pytest tests/ -q` and, for frontend tasks,
  `cd frontend && npx tsc -b && npm test && npx eslint --ext .ts,.tsx src/`.
  `tsc -b` — never `tsc --noEmit` (a no-op in this repo).
- **Commits:** conventional-commit subject, no `Co-Authored-By` lines, no
  emoji.
- **Migrations:** alembic revision `022`, `down_revision = "021"`. Postgres-only
  features must degrade on SQLite (the test suite uses SQLite via
  `Base.metadata.create_all`) — assert contracts on model metadata where SQLite
  ignores them.
- Follow `CLAUDE.md` gotchas, especially: `?:` catches `undefined` but not
  `null`; admin ↛ public imports; cancel-flag law for async effects.

## Task 1 — Migration 022 + User model columns

Add to `api/alembic/versions/022_auth_hardening.py` and `api/app/models/user.py`:

- `users.email` → `NOT NULL`, plus a **unique index on `lower(email)`**
  (`uq_users_email_lower`) so login is case-insensitive and duplicates are
  impossible. All existing rows already have addresses; assert non-null before
  altering and fail loudly if any row is empty.
- `users.must_change_password BOOLEAN NOT NULL DEFAULT false`.
- `users.password_changed_at TIMESTAMPTZ NULL` — backfill `now()` for every
  existing row so pre-existing tokens are not mass-invalidated at deploy.
- Extend the `user_role` enum with **`owner`** (`ALTER TYPE user_role ADD VALUE
  'owner'`). Document in the migration docstring that Postgres enum additions
  are irreversible and that `downgrade()` therefore leaves the value in place.
- Data backfill: `must_change_password = true` for usernames
  `anthony`, `daniel`, `matthew`, `ronald`; `matthew` → `role = 'owner'`.
  `demo` untouched.

Tests (`api/tests/test_auth_hardening.py`, new): model metadata carries the
three columns; `must_change_password` defaults false; a second user with the
same email in different case is rejected where the backend enforces it.

## Task 2 — Password policy module

`api/app/services/password_policy.py`:

- `PASSWORD_RULES` — ordered list of `(key, description)` for the four rules.
- `validate_password(password: str) -> list[str]` returning the **keys of unmet
  rules** (empty list = valid). Rules: `length` (8–24 inclusive), `uppercase`,
  `digit`, `symbol` (any non-alphanumeric character).
- `PASSWORD_HELP` — a single human sentence for API error bodies.

Tests: each rule independently unmet; boundary lengths 7 / 8 / 24 / 25; a
password failing several rules returns all of their keys; a valid password
returns `[]`; unicode symbols count as symbols.

## Task 3 — Email login + session invalidation

`api/app/routes/auth.py` + `api/app/services/auth_service.py`:

- `POST /api/auth/login` accepts `email` (not `username`) plus `password`,
  matching case-insensitively on `lower(email)`. Keep the dummy-hash timing
  equalization exactly as-is.
- The login response gains `must_change_password: bool`.
- `create_token` stamps `iat`; `get_current_user` rejects a token whose `iat`
  predates the user's `password_changed_at` (401 "Session expired"). Compare
  with a 1-second grace to absorb clock/rounding skew.
- `GET /api/auth/me` additionally returns `must_change_password` and `role`.
- Retire `POST /api/auth/forgot-username` (the username IS the email now);
  return 410 Gone, or remove the route and its test — implementer's choice,
  stated in the report.

Tests: login by email in mixed case succeeds; wrong password fails with the
same shape; a token minted before a password change is rejected afterwards;
`demo` still logs in; the response carries the flag.

## Task 4 — Forced password change + server-side enforcement

- `POST /api/auth/change-password` (authenticated): body `current_password`,
  `new_password`. Verifies the current password, runs `validate_password`
  (422 with the unmet-rule keys), rejects a new password equal to the current
  one, then writes the new hash, sets `password_changed_at = now()`, clears
  `must_change_password`. Returns a **fresh token** so the caller is not
  immediately logged out by its own session-invalidation rule.
- A FastAPI dependency — applied to the admin routers — that returns **403
  `password_change_required`** whenever `current_user.must_change_password` is
  set. Exempt: `change-password`, `auth/me`, and logout. This is the real gate;
  the UI screen is only its front end.

Tests: a flagged user gets 403 on a representative admin route (e.g. sponsors
list) and 200 on `auth/me`; after a successful change the same route returns
200; policy violations return 422 listing the unmet keys; reusing the current
password is rejected; the returned token authenticates immediately.

## Task 5 — Login rate limiting

No rate limiting exists anywhere in the API today.

- In-process limiter (no new dependency; single-worker-safe and correct enough
  at this scale — document the multi-worker caveat in the module docstring):
  per-IP **and** per-email counters with escalating backoff, e.g. 5 failures →
  60 s lock, doubling to a 15 min cap; a success clears that key's counters.
- A locked-out attempt returns the **same generic 401** as a wrong password
  (never "account locked"), so the limiter cannot be used as an enumeration
  oracle. `Retry-After` is set on the response.
- Applies to `POST /api/auth/login` and the recovery endpoints.
- The clock is injectable (`_now()` seam) so tests fast-forward instead of
  sleeping.

Tests: N failures then lockout; lockout returns the generic error; a fresh IP
is unaffected by another IP's lockout; the counter resets after a success;
fast-forwarding past the window unlocks.

## Task 6 — Frontend: email login + forced-reset screen

- `LoginPage`: the username field becomes **Email**, `type="text"` +
  `inputMode="email"` (per the repo's `type="url|email"` gotcha), with matching
  labels, autocomplete, and validation copy. "Can't remember your username?
  Recover it" becomes password recovery.
- New **Set a new password** screen shown when the login response (or
  `auth/me`) reports `must_change_password`: current password, new password,
  confirm, plus a **live rule checklist** mirroring the four server rules from
  one shared frontend constant. It routes there before any admin page renders,
  and a 403 `password_change_required` from anywhere also routes there.
- `adminApi`: `login(email, password)`, `changePassword(...)`, and the 403
  interceptor. Preserve the existing 401 → token-clear behavior.
- Vitest: the mirrored validator agrees with the backend rule set on a shared
  table of cases (same inputs, same expected unmet keys).

## Task 7 — Docs

Update `CLAUDE.md`: login is email-keyed, the policy, the `owner` tier, session
invalidation, rate limiting, and the fact that `demo` is exempt. Purge the dead
**Hover** SMTP references (frontend `hover` hits are CSS pseudo-classes — leave
them). Note migration 022 in the schema list.
