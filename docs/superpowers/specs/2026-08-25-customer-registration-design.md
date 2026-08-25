# Customer Registration — Design Spec

**Date:** 2026-08-25 · **Branch:** `updates` · **Migration:** 043 · **Status:** approved for planning

---

## 1. What this is, and what problem it actually solves

> **Companion:** `2026-08-25-account-console-surface-map.md` records what
> `/account` is eventually for, per surface, with an honest column on whether
> the data exists yet. Read it before extending this one — it already changed
> this spec once (D18).

The site takes money and it lets staff sign in. It has never had an account for
the people who pay. A completed Silver checkout writes exactly two rows —
`Supplier` + `Sponsor` (`stripe_webhook.py:253-267`) — and stops. There is no
`User`, no password, no way for a customer to ever see their own board.

So this is not "let existing customers log in". There is no customer principal
to log in *as*. This spec creates one.

It also closes a hole that is already open. `users.role` has been
`Enum("admin", "company", "owner")` since migration 002, with `company` as the
column DEFAULT — but the value is read **nowhere**. It appears in exactly two
lines of the backend (`models/user.py:22` and `:24`) and no route, service or
dependency ever compares against it. `get_current_user` is deliberately
role-agnostic and says so in its own docstring (`auth_service.py:332`).

The consequence is proven by the existing suite, not inferred:

- `test_auth.py::test_login_company_user` — a `role="company"` user signs in
  through the normal endpoint with no role restriction.
- `test_auth_forced_password_change.py::test_unflagged_user_is_untouched` — an
  unflagged user gets **200** on `/api/admin/sponsors/`.
- `test_auth_forced_password_change.py::test_the_gate_is_role_agnostic_for_company_users`
  — a `role="company"` user goes through that same gate, role never consulted.
- `conftest.py:293` already builds such a user (`kennedy_user`).

Read together: a `company` user today reaches every admin route — the Leads CRM
with real people's phone numbers, revenue, expenses, Stripe quotes, and every
message the public has ever sent. The role column is a label, not a wall.
Opening public registration onto that is the thing this spec must not do.

---

## 2. Decision record

Owner rulings, 2026-08-25. These are settled; do not relitigate them in review.

| # | Decision | Why |
|---|---|---|
| **D1** | Customers get a **separate `/account` portal**. `/admin/*` becomes staff-only. | The customer surface starts empty and is added to deliberately, rather than starting with everything and subtracting. Subtracting is how one route gets missed. |
| **D2** | The `company` enum value is **renamed to `user`**. | Owner's own taxonomy: "all Manufacturers/Distributors are Users, but not all Users are Manufacturers." Free today — zero rows hold it, zero code reads it. Never this cheap again. |
| **D3** | Account tier is **derived**, not stored. Free = no active sponsorship; otherwise the linked supplier's highest active tier (Silver/Gold/Platinum, the `/join` tile names). | One source of truth. No column to drift from the sponsorship it describes. |
| **D4** | `users.supplier_id` is **staff-set only**. Signup always writes NULL. | A typed company name must never confer identity — the `pay $100, become Avnet` lesson. Self-registration for suppliers/distributors is a later project. |
| **D5** | Duplicate email is reported **plainly** (`409 email_taken`), with hard rate limiting. | Explicit owner carve-out from the anti-enumeration invariant, for UX. See §6 for the limits and §11 for what it costs. |
| **D6** | Notifications fire **on verify**, never on submit. | Otherwise anyone with a script sprays the staff inbox, and the SES relay mails "welcome" to strangers who never asked. |
| **D7** | `username = lower(email)`. Customers never choose one. | Email is the only login key since migration 022; a second identifier is ceremony with a collision space. |
| **D8** | Verification + welcome emails are **HTML** (multipart/alternative with a plain-text part). All other mail stays plain text. | First impression of the company. Everything else keeps the existing `_build_*() -> EmailMessage` plain-text convention. |
| **D9** | `/account` ships a **real scoped dashboard**, not a placeholder. Remaining screens are Project 2. | The scoping pattern gets built and tested once, with a working screen proving it, before more screens inherit it. |
| **D10** | The signup card's illustration is **deferred**. Ship a plain `SignupBody` matching existing bodies. | Owner is doing their own Figma research on the treatment. Not a blocker. |
| **D11** | Confirm-password is a **client-side only** check — the same phrase typed into two boxes. It is never transmitted. | Sending it would put a second copy of a live credential on the wire and in logs for zero added assurance. The server already has the one it needs. |
| **D12** | Deletion: **owner-only** from `/admin/users`, and **self-service** from `/account/settings` → Danger Zone. Deletes the login and that user's messages. Never the linked `Supplier`/`Sponsor`. Never calls Stripe. | An account is a key to the building, not the building. Deleting a customer's login must not pull a paid ad off a board or orphan a live subscription. |
| **D13** | Verification token TTL: **24 hours**. | Password reset is 30 minutes because it hands over a live credential. This only proves mailbox control, and people check email on their own schedule. |
| **D14** | Customers get password reset — but **unverified accounts are skipped**, so no link is ever sent to one. | Owner ruling. Reset is for people who forgot a credential; **resend-verification** is for people who never proved their mailbox. One door, one job. |
| **D15** | `/account/*` renders **the same admin components**, remounted. No parallel frontend tree, and **no data scoping in Project 1**. | Owner: "the pages are a duplication." Building a second component tree to show the same thing is work with no product in it. |
| **D16** | Every admin page is reachable at `/account`, **unscoped**. | Explicit owner decision, 2026-08-25, made against a written enumeration of what it exposes (see §10). |
| **D17** | An account must be **activated by staff** before it can reach `/account`. Verification ≠ activation. | The consequence of D16. Verification proves mailbox control; activation is the owner saying yes. Makes "everyone who can see this" an approved list rather than the open internet, for one column. |
| **D18** | Account capability is **two nullable links**, not a type enum: `users.supplier_id` and a new `users.manufacturer_id`. Both set = both. | Avnet is a distributor AND a manufacturer. An enum forces a wrong answer for the largest accounts on day one. The links are the capability, and staff set them (D4), so it stays unforgeable. |
| **D19** | Two banners, two links. **Verification** link → the sign-in screen + "Email confirmed". **Activation** email → `/account` + "You're in". | Owner ruling. Each email marks a different milestone and lands where the person can act on it: after verifying you can sign in; after activation there is something to see. |
| **D20** | Paired routes are fronted by the existing `CatalogSwitch`, not four sidebar entries. | Owner's suggestion, and it reuses a shipped pattern. It fronts two REAL routes and already hides a half conditionally — the same mechanism hides the half an account has no link for. |

---

## 3. Migration 043

`down_revision = "042"`.

```
users:
  ALTER TYPE user_role RENAME VALUE 'company' TO 'user'   -- D2
  username        VARCHAR(100) -> VARCHAR(255)            -- D7: must hold an email
  + first_name       VARCHAR(80)   NULL
  + last_name        VARCHAR(80)   NULL
  + email_verified_at TIMESTAMPTZ  NULL   -- NULL = unverified. The gate.
  + signup_ip        VARCHAR(45)   NULL   -- 45 = longest IPv6 text form, matches last_login_ip
  + signup_country   VARCHAR(2)    NULL   -- ISO alpha-2, DB-IP, same as page_views.country
  + manufacturer_id UUID  NULL REFERENCES manufacturers(id)  -- D18
                                        -- Peer of the existing supplier_id.
                                        -- Neither = free. One = that role.
                                        -- BOTH = a company that distributes
                                        -- and manufactures (Avnet). Staff-set.
  + activated_at    TIMESTAMPTZ  NULL   -- D17. NULL = awaiting staff approval.
                                        -- NOT the same as email_verified_at:
                                        -- verified = they own the mailbox,
                                        -- activated = staff said yes.
                                        -- Only consulted for CUSTOMER_ROLES.

messages:
  + user_id  UUID NULL REFERENCES users(id) ON DELETE CASCADE
             -- NULL = the shared staff inbox (every existing row).
             -- Populated = that customer's inbox only.
```

**`username` stays `NOT NULL UNIQUE`.** It is widened, not relaxed. Staff rows
(`matthew`, `Daniel`, `Anthony`, `Ronald`, `demo`) are untouched, so the
`${username}@circuitcenter.ai` mailbox link in the admin inbox keeps working.

**Store `username` lowercased.** `username` is a case-SENSITIVE unique
constraint; email is unique on `lower(email)` via `uq_users_email_lower`.
Storing the address as typed would have the two constraints enforcing different
notions of identity on the same value. Lowercasing makes them agree by
construction — the same reasoning that made email case-insensitive in 022.

`ALTER TYPE ... RENAME VALUE` is transactional on the deployed Postgres, so it
runs inside alembic's single transaction like every other statement here. No
migration in this repo imports app code, and 043 does not need to.

### What the rename breaks, and what it must NOT touch

The model's `Enum(..., create_constraint=True)` renders a CHECK on SQLite, so
every fixture using the old value fails at flush the moment the tuple changes.
These are real edits, not incidental:

- `conftest.py:293` — `kennedy_user` fixture → `role="user"`
- `test_auth.py:24,104` — `test_login_company_user` / `test_me_company_user`
- `test_models.py:49,71` — default-role assertion + supplier-linked fixture

**Do not touch `test_auth_hardening.py:54,61.`** It recreates the *pre-022* enum
`('admin','company')` in raw SQL on purpose — it is simulating the old schema to
test the migration path. Renaming it there would delete the thing it tests.

---

## 4. Registration flow

### `POST /api/auth/signup` — public, unauthenticated

Body: `first_name`, `last_name`, `email`, `password`. `extra="forbid"` — the
body may not carry `role`, `supplier_id`, or anything else that confers
privilege.

**There is no `confirm_password` field on the wire** (D11). The signup screen
renders two password boxes and refuses to submit while they differ; only the
one value is sent. Mirror the mismatch message locally — do not round-trip a
credential twice to learn something the client already knows.

1. Validate the password through `password_policy.validate_password` — the ONE
   existing home, mirrored 1:1 by `@admin/services/passwordPolicy.ts`. A failure
   returns the same structured `422 {code:'password_policy', unmet:[...]}` every
   other password surface returns, so the live checklist ticks off `unmet`.
2. Duplicate address → **409 `email_taken`** (D5), after recording the probe (§6).
3. Create the user:
   `role='user'`, `username=lower(email)`, `supplier_id=NULL`,
   `email_verified_at=NULL`, `must_change_password=False`,
   `signup_ip=rate_limit.client_ip(request)`,
   `signup_country=geoip.country_for_ip(...)`.
4. Mint a verification token and dispatch the email via `BackgroundTasks`.
5. **Return `202 {"status":"ok"}` — and no token.** No session exists until
   verification. This is what makes D6 enforceable rather than advisory.

### `POST /api/auth/verify`

Token: JWT with `purpose='verify'`, 24h TTL, carrying `sub` (user id) and a
fingerprint of the address — reusing the exact shape of `create_reset_token` /
`decode_reset_token`, including the `purpose` claim that
`get_authenticated_user` already rejects for session use (`auth_service.py`
rejects any token where `payload.get("purpose") is not None`). Single-use by
construction: the token is spent the moment `email_verified_at` is stamped, and
a second presentation finds it already set.

On success, in one transaction, then side effects:

- stamp `email_verified_at`
- `Message(type='signup', user_id=NULL, seq=_next_seq(db), payload={...})` → the shared staff inbox
- `Message(type='welcome', user_id=<the user>, seq=..., payload={...})` → their inbox
- `BackgroundTasks` → `send_welcome_email(...)`

Returns `{"status":"ok"}`. The SPA then redirects to `/admin/login?welcome=1`,
which renders the "Email confirmed" banner (D19).

**Verification does NOT mint a session.** The link proves mailbox control; it is
not a credential. Emailed links leak — forwarded threads, shared devices, and
especially **corporate mail scanners that prefetch every URL in a message**.
That prefetch risk is also why verification is a `POST` performed by the SPA
rather than a `GET` on the link itself: a scanner fetching the URL renders a
page and consumes nothing.

### Activation email (D19)

Sent when staff stamp `activated_at`. Links to `/account?activated=1`, which
renders a "You're in" banner once they sign in. This is the milestone worth
telling someone about — verification only proves they own an address, whereas
activation is the moment there is something to look at.

### `POST /api/auth/resend-verification`

Rate-limited in the `signup:*` namespace. Returns the generic OK regardless —
this endpoint has no UX reason to be an oracle, so it keeps the invariant.

### Login change

In `POST /api/auth/login`, after the password verifies:

```
if user.role == 'user' and user.email_verified_at is None:
    raise HTTPException(403, "email_not_verified")
```

Correct password + unverified → 403 with a resend affordance. **Wrong password
→ the unchanged generic 401.**

**Activation is NOT checked at login** (D17). A verified-but-unactivated
customer signs in successfully and lands on "your account is awaiting
approval"; the refusal happens at route access, in `require_account_user`.
Refusing at the door instead would be indistinguishable from a bad password,
which is exactly the wrong message for someone who did everything right. So "this account exists but is unverified" is
only learnable by someone who already proved they know the password, which is
not an enumeration oracle at all. Login's anti-enumeration property survives
D5 completely intact; only signup relaxes it.

---

## 5. The wall

`models/roles.py` is already the single home for "what counts as an admin"
(`ADMIN_ROLES = ("admin", "owner")`). It gains `CUSTOMER_ROLES = ("user",)`.
Three dependencies in `auth_service.py`, all composing with — never replacing —
`get_current_user`:

| Dependency | Admits | Used by |
|---|---|---|
| `require_staff` | `ADMIN_ROLES` | `/api/admin/users`, message deletion, anything genuinely staff-only |
| `require_account_user` | `CUSTOMER_ROLES` **and** `activated_at IS NOT NULL` | `/api/account/me` |
| `require_console_user` | either of the above | every existing admin router (D16) |

`require_console_user` is applied **at router level**
(`APIRouter(dependencies=[...])`), matching how `get_current_user` achieves
fail-closed coverage without a per-route opt-in a new endpoint could forget.

Under D16 the pages are shared, so the boundary is not *which page* — it is
**activation**, and it lives in one place: `require_account_user`'s
`activated_at` check, which `require_console_user` inherits for customers.

### The test that makes it real

`test_every_route_is_gated.py` walks `app.routes` at import time and asserts
every route carries one of the three dependencies above, or appears in an
explicit `PUBLIC_ROUTES` allowlist. A route added later fails the suite **by
default** rather than being silently reachable. Same construction as
`test_leads_never_public.py`.

The allowlist is the reviewable artifact: adding an entry is a deliberate edit a
human has to look at, which is the point. `/api/auth/signup`, `/verify` and
`/resend-verification` are its three new members.

**Introspection mechanism**, so this is not hand-waving: each `APIRoute` exposes
`route.dependant.dependencies`, whose entries carry the `call` that FastAPI will
run. The test walks that tree and matches on function identity — not on the
route path, and not on a decorator string, either of which could be spoofed by a
route that merely looks right.

## 6. Rate limiting

New `signup:*` namespace in `app/services/rate_limit.py`, deliberately NOT
shared with `login:*` or `recovery:*` — for the same reason those two are
separate: a signup flood must not lock a real customer out of signing in.

| Signal | Threshold | Response |
|---|---|---|
| Same address, repeated | 5 / 15 min | 60s lock, doubling → 15 min ceiling (the existing ladder) |
| **Distinct** addresses returning `email_taken`, one IP | 8 / 15 min | 1 hour pause |
| Distinct addresses, one IP | 25 / 1 hour | 24 hour pause |

The middle row needs something the limiter does not have today: it counts
failures per key, not *distinct values* per key. `rate_limit.py` gains
`record_probe(key, value) -> int`, returning the count of distinct values seen
for that key inside the window. That is the actual enumeration signal — a person
who forgot they registered retries **one** address; an enumerator walks many.

**Two facts to pin rather than rediscover.** Counters are in-process per worker,
so every threshold multiplies by worker count; prod runs `--workers 1` today, so
8 means 8. And cookies are not a defense here — an enumerator clears them or
never sends them, so IP is genuinely what we have.

---

## 7. Email

Both new emails are `multipart/alternative` — HTML part plus a plain-text part
that says the same thing (D8). A new `_build_html_email(...)` helper in
`services/email.py` is the only new pattern; it keeps the existing shape of a
pure `_build_*(...) -> EmailMessage` function plus a thin `async def send_*`
wrapper over `_smtp_send`, so both stay unit-testable without SMTP and both
inherit demo mode when `SMTP_HOST` is unset.

- `send_verification_email(to, first_name, verify_url)`
- `send_welcome_email(to, first_name)`

**The verify URL is built from `settings.APP_BASE_URL`, never
`request.base_url`** — the same host-poisoning rule the password-reset link
already follows.

HTML mail constraints, since this is the project's first: inline styles only (no
`<style>` block survives Gmail reliably), table-based layout, no remote images —
the logo ships as an inline SVG or is omitted, because remote images are
blocked by default and a broken image is worse than none. Max width 600px.

---

## 8. Messages

Two new types on the existing discriminated union. The backend needs **no schema
change** — `MessageResponse.type` is a plain `str` and `payload` a plain `dict`,
so the union is a frontend-side contract plus a payload convention.

| Type | `user_id` | Lands in |
|---|---|---|
| `signup` | NULL | Shared staff inbox — all four staff see it, no addressing needed |
| `welcome` | the new user | That customer's `/account` inbox only |

`assigned_to` is **not** used for any of this and must not be. It is a nullable
`String(10)` display label with a hardcoded domain of `Daniel | Anthony |
Ronald` (the owner is not even in it), carrying zero access-control semantics —
any admin can read, reply to and reassign anything. Visibility is `user_id`.

Frontend touchpoints:

- `types/messages.ts` — `'signup' | 'welcome'` in `MessageType`, two payload
  interfaces, two union arms
- `messageHelpers.ts` — `TYPE_META` entries (label/color/tint) and the
  `subjectFor`/`senderName` switches
- `MessageChips.tsx` — `TYPE_ICON` entries
- `MessageDetailBodies.tsx` — `SignupBody` + `WelcomeBody`
- `messages/detail/index.tsx` — the two branch sites (subject switch ~143-148,
  body switch ~172-178)
- `demo_messages.py` — synthetic rows of both new types, so the demo account
  still exercises the new UI branches

Note an existing gap while in there: `type === 'reply'` renders no body in the
detail switch. Not this spec's job to fix, but do not copy the pattern.

---

## 9. `/admin/users`

A staff page modelled on `/admin/manufacturers`, backed by a new
`routes/admin_users.py` (`require_staff`, demo REFUSED on reads — the roster is
real people's addresses and IP-derived locations).

Columns: `Name` · `Email` · `Member Since` · `Location` · `Website` · `Tier` ·
`Verified` · `Linked company`

- **Location** renders `signup_country` and carries the DB-IP CC-BY attribution
  the Reports map panel already renders. Do not drop it.
- **Website** comes from the linked supplier, so it is `—` for unlinked
  accounts. That is most rows at launch, and is correct rather than broken.
- **Linked company** is the control surface for D3/D4 — the dropdown that sets
  `supplier_id`, and therefore the only path to a non-free tier.

Two row-level controls, both staff-only:

- **Activate / deactivate** (D17) — stamps or clears `activated_at`, and
  dispatches the activation email (D19) on the activating edge only. This is the
  entire authorization boundary in Project 1, so the list's default sort puts
  **unactivated accounts first**: the page's job is to show you who is waiting.
- **Link company** (D3/D4/D18) — **two** independent dropdowns, `supplier_id`
  and `manufacturer_id`. Either, both, or neither. Both is a real and important
  case, not an edge case, so the UI must not present them as a choice between
  two. Setting `supplier_id` is also the only path to a non-free tier.

Deactivating is not deleting. It revokes access and keeps the row, which is what
you want for a customer who lapses or a signup you are unsure about.

---

## 10. `/account` — the same console, remounted

**No new frontend tree.** The admin route table is extracted into one
`<ConsoleRoutes />` component, mounted twice:

```
/admin/*    → ConsoleRoutes   guarded by role in ADMIN_ROLES
/account/*  → ConsoleRoutes   guarded by role in CUSTOMER_ROLES + activated
```

Same components, same `AdminLayout`, same SCSS. The only per-mount differences
are the base path used to build links and which role may enter. `nginx` needs
no change — `try_files` already falls `/account` through to the SPA shell.

### What D16 means, written down

Project 1 applies **no per-customer filtering**. An activated customer sees
what an admin sees, on every page. Stated plainly so nobody has to infer it
later, and so the decision is auditable:

| Page | What an activated customer can read |
|---|---|
| Dashboard, Reports | Company revenue, AWS spend, analytics, book of business |
| Expenses | The full cost breakdown |
| Leads | The CRM — real names, companies and **phone numbers** of third parties |
| Settings | **Distributor feed API keys** (Mouser, DigiKey) |
| Messages | Every public form submission, incl. senders' contact details |
| Sponsors | Every sponsor, amount and selling rep |
| Parts, Suppliers, Import, Categories | The whole catalog and its write surfaces |

Two rows there are not the owner's data alone: the Leads roster is other
people's personal information, and the feed keys are credentials issued under a
third party's terms. That is precisely why D17 exists.

### D17 — activation is the gate

`users.activated_at` (NULL = not activated). It is **not** the same thing as
`email_verified_at`:

- **verified** = they control that mailbox (proved by clicking the link)
- **activated** = staff said yes (a toggle in `/admin/users`)

`require_account_user` refuses an unactivated account. The SPA renders a plain
"your account is awaiting approval" screen rather than an error — nothing to
retry, so nothing to present as a failure. Staff accounts are unaffected:
`activated_at` is only consulted for `CUSTOMER_ROLES`.

This is the whole of Project 1's authorization story. It is deliberately a
**gate**, not a filter — one boolean a human sets, rather than forty `WHERE`
clauses that each have to be right.

---

## 10a. Deletion (D12)

Two doors, one implementation: `DELETE /api/account/me` (self, from
`/account/settings` → Danger Zone) and `DELETE /api/admin/users/{id}`
(`require_owner`, matching how message deletion is already gated for being
irreversible).

**What it deletes:** the `users` row, and `messages WHERE user_id = :them` via
the FK cascade.

**What it must NOT touch, ever:**

- the linked `Supplier` row, or any of its parts, listings or prices
- any `Sponsor` row — a live placement is paid inventory on a public board
- anything in Stripe — no cancel, no void, no API call at all

If the linked supplier carries an active sponsorship, both doors say so before
confirming: the company's sponsorship keeps running and billing; this only
removes the sign-in. The supplier-delete cascade in `routes/suppliers.py` is the
opposite operation and must not be reused here.

Self-delete **re-authenticates** — the Danger Zone requires the current password
in the body, checked with `verify_password` before anything is removed. A stolen
session should not be able to destroy an account.

The demo account is refused at both doors.

---

## 11. Files

**Backend**

```
NEW  api/alembic/versions/043_customer_accounts.py
NEW  api/app/routes/admin_users.py             /api/admin/users — list, activate, link, delete
NEW  api/app/routes/account.py                 ONLY /me and DELETE /me (settings + Danger Zone)
NEW  api/app/services/account_tier.py          D3 derivation, one home
MOD  api/app/models/user.py                    enum rename, 6 columns, username 255
MOD  api/app/models/message.py                 user_id
MOD  api/app/models/roles.py                   CUSTOMER_ROLES
MOD  api/app/routes/auth.py                    signup / verify / resend, login gate, reset skips unverified
MOD  api/app/services/auth_service.py          require_staff, require_account_user, verify tokens
MOD  api/app/services/rate_limit.py            signup namespace + record_probe
MOD  api/app/services/email.py                 _build_html_email + 2 senders
MOD  api/app/services/demo_messages.py         2 synthetic rows
MOD  api/app/main.py                           register 2 routers
MOD  <every admin router>                      dependencies=[Depends(require_staff_or_activated_customer)]
```

Note the last line: because D16 gives customers the same pages, the admin
routers' dependency admits **both** principals. `require_staff` still exists and
still guards the genuinely staff-only endpoints — `/api/admin/users` itself, and
message deletion, which stays `require_owner`.

**Frontend**

```
NEW  frontend/src/admin/pages/login/screens/SignUp.tsx
NEW  frontend/src/admin/pages/verify/index.tsx
NEW  frontend/src/admin/pages/users/…                   list + row controls (activate, link)
NEW  frontend/src/admin/pages/settings/DangerZone.tsx   self-delete
NEW  frontend/src/admin/routes/ConsoleRoutes.tsx        the extracted route table, mounted twice
MOD  frontend/src/admin/pages/login/screens/types.ts    + 'signup'
MOD  frontend/src/admin/pages/login/index.tsx           + the screen arm
MOD  frontend/src/admin/pages/login/screens/SignIn.tsx  + Sign Up link, + welcome banner
MOD  frontend/src/admin/pages/login/LoginPage.module.scss  + .banner-ok
MOD  frontend/src/admin/contexts/AuthContext.tsx        + signup(), role-aware
MOD  frontend/src/admin/components/ProtectedRoute.tsx   role-aware redirect + awaiting-approval
MOD  frontend/src/admin/services/adminApi.ts            + signup/verify/resend/users
MOD  frontend/src/App.tsx                               /admin/signup, /admin/verify, /account/*
MOD  frontend/src/admin/types/messages.ts               2 types
MOD  frontend/src/admin/components/messages/*           TYPE_META, TYPE_ICON, 2 bodies
```

There is no `frontend/src/account/` directory. D15 deleted it.

### What is genuinely free

Three stated requirements are pure reuse:

- **The password reveal toggle already exists** — `login/components/Field.tsx`
  has `reveal`/`revealed`/`onReveal` with eye/eye-off icons.
- **The complexity checklist already exists** — `PASSWORD_RULES` +
  `.rules`/`.rule-ok`/`.rule-no`/`.rule-idle`, driven by `unmetKeysFromDetail`.
- **The signup screen is not a new page** — `LoginPage` is a screen-switcher
  (`Screen = 'signin' | 'forgot-password'`); signup is a third value inside the
  existing `AuthShell`, reusing `.screen`, `.field`, `.input-shell`, `.btn`,
  `.banner`, `.rules`, `.form-meta`.

The Sign Up link goes in `SignIn.tsx`'s `.form-meta`, **between** the "Reset your
password" line and the demo CTA — the demo block's own comment calls itself
"deliberately secondary to Sign in"; signup is the same audience with stronger
intent.

One new class: `.banner-ok`, a success variant of `.banner` (which is an error
banner with a shake animation).

---

## 12. Tests

| File | Pins |
|---|---|
| `test_signup.py` | 202-no-token; `role='user'`; `supplier_id` NULL even if the body sends one; `username == lower(email)`; policy 422 shape; 409 on duplicate; **no `confirm_password` accepted** (`extra="forbid"`) |
| `test_email_verification.py` | Token single-use; 24h expiry; a `purpose='verify'` token is rejected as a session token; side effects fire on verify and **not** on signup |
| `test_account_activation.py` | Verified-but-unactivated is refused; activation admits; **staff are never gated on `activated_at`**; activation is staff-only to set |
| `test_signup_rate_limit.py` | The three thresholds; `record_probe` distinct-counting; a signup lockout does not lock login |
| `test_forgot_password_skips_unverified.py` | No mail sent for an unverified address, and the response is byte-identical to the verified case |
| `test_account_deletion.py` | Self-delete requires the current password; removes user + their messages; leaves `Supplier`, `Sponsor` and Stripe **untouched**; demo refused |
| `test_staff_wall.py` | `/api/admin/users` and message deletion refuse `role='user'` — the pages are shared, these endpoints are not |
| `test_account_tier.py` | Derivation incl. `status IS NULL` counting as active, and TitleCase/lowercase normalization |
| `passwordPolicy.test.ts` | Unchanged — the mirror must still agree |

`test_account_activation.py` needs a **mutation check**: remove the
`activated_at` condition and confirm the suite goes red. Under D16 that one
condition is the entire authorization boundary, so a test that passes without it
is measuring nothing — the trap `test_price_break_writes_pg.py` documents.

---

## 13. Out of scope — Project 2

- **Per-customer data scoping** — the `WHERE supplier_id` filtering that D16
  defers. Until it lands, D17's activation gate is what stands in for it.
- Trimming pages that have no customer-scoped meaning (Reports, Expenses,
  Leads, Settings) out of the customer mount
- Customer **write** surfaces — `parts` has no owner column; "parts they added"
  is currently only expressible through `part_listings.supplier_id`
- Supplier/distributor **self**-registration with identity proof (D4 defers it)
- The signup card illustration (D10) and the orientation guide's copy

---

## 14. Resolved, and the one question left

All three questions this spec opened with were answered by the owner on
2026-08-25 and are recorded as **D12**, **D13** and **D14** above:

1. Customer password reset — **wanted**, served by the existing endpoint.
2. Deletion — **owner-only from `/admin/users`, plus self-service Danger Zone**.
3. Verification TTL — **24 hours**.

### 14a. Closed — reset-and-verify

This spec previously asked whether completing a password reset should also mark
an address verified, to avoid a dead end: sign up, ignore the email, reset the
password, still be refused.

The owner's D14 ruling dissolves it rather than answering it. An unverified
account never receives a reset link at all, so the sequence cannot occur. The
door for someone who never verified is **resend-verification**, which already
exists. Each door does one job; no state transition gained a second path.

### Content deferred, by owner instruction

The orientation guide's copy is **not specified here** (owner: "for now, don't
worry about it"). The recorded assumption for whoever writes it: the customer
will eventually reach the same subpages an admin does, each scoped to their own
data. Project 1 ships the welcome message with placeholder-free but minimal
copy; the guide proper is Project 2, once those subpages exist to describe.
