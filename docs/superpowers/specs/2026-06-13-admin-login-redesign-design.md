# Admin Login Redesign + Account Recovery — Design & Plan

**Date:** 2026-06-13 · **Branch:** `updates` · **Design source:** `design-handoff-v13` (Claude Design, chat14)

**Goal:** Replace the bland admin login with the pixel-perfect two-panel "steel PCB" auth
screen from the v13 handoff, and ship three real, secure features: (1) **30-day "keep me
signed in"**, (2) **forgot-password** with a real self-service reset-link flow, (3)
**forgot-username** email recovery.

**Scope decisions (user-confirmed 2026-06-13):**
- Recovery depth = **Full reset-link flow** (real JWT reset tokens, real `/admin/reset-password` page, real bcrypt re-hash, real emails).
- Demo creds = **keep the visible "Demo access — demo / demo" hint AND seed a real `demo`/`demo` admin user.**

---

## 1. The design (source of truth — `ui_kits/admin/login/`)

Two-panel split, `grid-template-columns: 1.12fr 0.88fr`, `min-height: 100vh`.

**Left `.brand` (dark steel `#0e1113`)** — radial green wash + vertical vignette; logo lockup
(pinging `.logo-node` + `Circuits.com` wordmark + `Account` tag); `IsoBoard` (CSS-3D isometric
PCB: floating `CIRCUITS.COM` QFP on gold gull-wing leads, flowing data packets, pulsing LED,
7s float); headline `Member Access` / "Your account, your **components**." (`em` = `--nav-green`);
mono status footer (`● Secure terminal · TLS 1.3 · AES-256 · U1 · circuits.com`). **Hidden ≤900px**
(brand collapses to a slim logo+status band; IsoBoard `display:none`).

**Right `.form-side` (white)** — top-right "Back to site" ghost link; centered `.card`
(`max-width: 372px`) hosting one of three screens; legal footer.

**Screen state machine** (`screen ∈ {signin, forgot-password, forgot-username}`), `go(screen)` swaps.
Shared primitives: `Field` (label + optional right-slot link + icon-lead input-shell + reveal toggle +
inline error), inline 24-grid stroke `I` icon set, `Svg` wrapper.

- **Sign in** — eyebrow `● Account Access`, h2 "Sign in", lede; username (`I.user`, autofocus) +
  password (`I.lock`, reveal eye/eyeOff, "Forgot password?" right-link → `forgot-password`);
  **"Keep me signed in for 30 days"** custom checkbox (**default checked**); submit "Sign in →"
  (spinner "Verifying…" busy); form-meta: "Can't remember your username? **Recover it**" →
  `forgot-username`, + mono demo hint "**Demo access** — username **demo** · password **demo**".
  Error → `.banner` (shake). *(Prototype's "Authenticated" success screen is a demo artifact —
  replaced by real redirect to `/admin`.)*
- **Forgot password** — back-link → signin; eyebrow `● Account Recovery`; "Reset your password";
  `Email or username` field (`I.id`); "Send reset link →". Success `.success`: mail mark, "Check
  your inbox", masked id (`mask()`), "expires in 30 minutes", ghost "Back to sign in" + 30s
  cooldown "Resend".
- **Forgot username** — back-link; "Recover your username"; `Account email` field (`I.mail`,
  `inputMode=email`); "Email my username →". Success: "Username sent", masked email, "Back to sign in".

**Palette maps 1:1 to project tokens:** `--exec-green #0a4a2e` = `$executive-blue`,
`--nav-green #44bd13` = `$nav-blue`, native SF Pro / SF Mono. `--radius` 9–10px. Full
responsive + `prefers-reduced-motion` rules already in `login.css` (512 lines) — ported verbatim.

---

## 2. Architecture

### 2a. Backend (`api/`)

**Migration 015 — `User.email`**
- `users.email = Column(String(255), nullable=True)`, non-unique index `ix_users_email`.
- Nullable: legacy rows + the demo user need no hard requirement. SQLite tests get it via
  `create_all`; migration is PG-only. Down = drop index + column.

**`models/user.py`** — add `email = Column(String(255), nullable=True, index=True)`.

**`services/auth_service.py`**
- `TOKEN_EXPIRY_HOURS = 24` (unchanged) + `REMEMBER_EXPIRY_HOURS = 24 * 30` (720).
- `create_token(user_id, role, expires_hours=TOKEN_EXPIRY_HOURS)` — add session token a
  `"purpose": "session"`-free payload (no `purpose` key) **and** make `get_current_user` reject any
  token carrying a `purpose` claim → a reset token can never authenticate as a bearer.
- **Reset tokens (tableless, single-use):**
  - `RESET_EXPIRY_MINUTES = 30` (matches design copy).
  - `_pw_fingerprint(password_hash) -> str` = first 16 hex of `sha256(password_hash)`.
  - `create_reset_token(user) -> str` — JWT `{sub, purpose:"pwreset", pwfp:_pw_fingerprint(hash),
    exp:+30min, iat}` signed with `ADMIN_SECRET_KEY` (HS256).
  - `decode_reset_token(token) -> str` (user_id) — verifies signature + exp; raises on
    missing/`purpose != "pwreset"`. (Fingerprint compared in the route once the user is loaded:
    a mismatch = password already changed = token already used → reject. This gives single-use +
    invalidates outstanding reset tokens on any password change, with **no new table**.)

**`routes/auth.py`** (prefix `/api/auth`)
- `LoginRequest` += `remember: bool = False`; login picks TTL by `remember`.
- `POST /forgot-password` `{identifier}` — case-insensitive match on `username OR email`; if found
  **and** has email → `BackgroundTasks` send reset email with
  `{base}admin/reset-password?token=…`. **Always 200 `{status:"ok"}`** (anti-enumeration).
- `POST /reset-password` `{token, new_password}` — `decode_reset_token` → load user → verify `pwfp`
  matches current hash → enforce `len(new_password) >= 8` → `user.password_hash =
  hash_password(...)`; commit; 200. Invalid/expired/used/short → 400 (length → 422 via Pydantic
  `min_length=8`).
- `POST /forgot-username` `{email}` — case-insensitive email match; if any → email the username(s).
  **Always 200**.
- Reset URL base = `settings.APP_BASE_URL or str(request.base_url)` (ProxyHeaders gives the public
  host behind nginx).

**`config.py`** — `APP_BASE_URL: str | None = None`.

**`services/email.py`** — `send_password_reset(to_email, username, reset_url)` and
`send_username_reminder(to_email, usernames)` (both to the user's address, demo-mode aware).

**`db/seed.py`** — `_seed_admin_user`: `(username, password, email)` rows
matthew/mike/john (`@circuits.com`) + **`demo`/`demo`/`demo@circuits.com`**; backfill `email` on
existing rows when missing (stays idempotent).

### 2b. Frontend (`frontend/src/admin/`)

**`services/adminApi.ts`** — `login(username,password,remember)`; add `forgotPassword(identifier)`,
`forgotUsername(email)`, `resetPassword(token,newPassword)`.
**`contexts/AuthContext.tsx`** — `login(username,password,remember)` threads `remember`.

**`pages/login/`** (rebuilt) —
- `index.tsx` — `AuthApp` shell: `screen` state machine; renders `<AuthShell>` (brand+IsoBoard) +
  active screen.
- `components/AuthShell.tsx` — the two-panel chrome (brand panel + IsoBoard + form-side + legal),
  `children` = the active card. **Reused by reset-password page.**
- `components/IsoBoard.tsx` — React port of the CSS-3D board (Cube/Trace/Flow/Lead/SidePin +
  geometry constants, verbatim).
- `components/Field.tsx`, `components/icons.tsx` (`I` set + `Svg`), `lib/recovery.ts`
  (`isEmail`, `mask`).
- `screens/SignIn.tsx` — real `useAuth().login(u,p,remember)`; success → React Router redirect to
  `/admin` (AuthContext `isAuthenticated` already drives `<Navigate to="/admin">`).
- `screens/ForgotPassword.tsx` — `adminApi.forgotPassword`; design success + 30s cooldown.
- `screens/ForgotUsername.tsx` — `adminApi.forgotUsername`; design success.
- `LoginPage.module.scss` — `login.css` ported into a single hashed `.authRoot` wrapper with a
  nested `:global { … }` block so every design class (`.auth`, `.brand`, `.field`, `.tr-sig`, …)
  compiles to `.authRoot_HASH .auth` etc. — **literal design class names in JSX (zero pixel drift),
  fully scoped, no leakage** of the design's `*`/`body`/`form` globals. `:root` vars → `.authRoot`
  custom props. `@keyframes` stay global (unique names).

**`pages/reset-password/index.tsx`** (new, design-consistent) — reads `?token`; reuses `AuthShell`;
"Set a new password" screen (new + confirm password, reveal, ≥8 validation) → `adminApi.resetPassword`
→ success "Password updated → Back to sign in"; invalid/expired/used token → error state with a path
back to forgot-password.

**`App.tsx`** — `const ResetPasswordPage = lazy(() => import("@admin/pages/reset-password"))` +
`<Route path="/admin/reset-password" element={<ResetPasswordPage />} />` (sibling of
`/admin/login`, OUTSIDE `ProtectedRoute`).

---

## 3. Security model (the risky part — explicit)

1. **Anti-enumeration:** forgot-password/username always return `200 {status:"ok"}` regardless of
   match. Masked identifiers only echo what the user typed (client-side `mask()`).
2. **Token-type isolation:** reset tokens carry `purpose:"pwreset"`; `get_current_user` rejects any
   bearer token with a `purpose` claim → a reset token cannot be used to access the admin API.
3. **Single-use reset:** `pwfp` fingerprint of the current `password_hash` is embedded; once the
   password changes the fingerprint no longer matches → the link is dead (and so is every other
   outstanding reset link for that user). No table, no revocation list.
4. **Short TTL:** reset tokens expire in 30 min (`exp`), signed with `ADMIN_SECRET_KEY`
   (already rotated off the public default — `581e500`).
5. **Password policy:** `min_length=8` on reset (Pydantic 422).
6. **Note:** server-side rate-limiting on the recovery endpoints is out of scope for the demo
   (client has a 30s resend cooldown); flagged as future hardening.

---

## 4. Task plan (TDD, commits on `updates`, NO Co-Authored-By)

**Backend (sequential — each: failing test → impl → ruff → pytest → commit)**
- **B1** Migration 015 + `User.email` + column-metadata guard test (length ≥255, dialect-agnostic).
- **B2** `auth_service`: `expires_hours` param + `REMEMBER_EXPIRY_HOURS`; reset-token helpers +
  `get_current_user` purpose-rejection. Unit tests (round-trip, expired, wrong-purpose,
  fingerprint-mismatch, reset-token-rejected-as-bearer).
- **B3** `config.APP_BASE_URL` + `email.send_password_reset` + `email.send_username_reminder`.
- **B4** `routes/auth.py`: `remember` on login (TTL assertions) + `/forgot-password` +
  `/reset-password` + `/forgot-username` (contract + anti-enumeration + real-reset round-trip:
  reset → new password logs in, old fails, token now dead).
- **B5** `seed.py`: emails + `demo` user (idempotency + demo-login test).

**Frontend (after backend green; B-shell parallelizable)**
- **F1** `adminApi` + `AuthContext` (remember + 3 recovery calls).
- **F2** `LoginPage.module.scss` (scoped port) + `icons.tsx` + `Field.tsx` + `IsoBoard.tsx` +
  `AuthShell.tsx`.
- **F3** `screens/SignIn|ForgotPassword|ForgotUsername.tsx` + `pages/login/index.tsx`.
- **F4** `pages/reset-password/` + `App.tsx` route.
- **F5** Gate: `npx tsc -b` + `npx eslint --ext .ts,.tsx src/` clean.

**Verify / polish**
- **V1** Full `pytest` green (no regressions to the existing 282).
- **V2** chrome-devtools-mcp: build frontend; screenshot `/admin/login` (signin + both recovery
  screens + reset page) at 1280/900/560; confirm pixel parity vs `login.css`; `/a11y-debugging`
  (focus, contrast, labels, reduced-motion) + LCP sanity.
- **V3** `/code-review` + `/simplify` + `silent-failure-hunter` on the diff.
- **V4** `/claude-md-improver` (recovery flow + scoped-`:global` port pattern + 30-day TTL).

**Out of scope:** deploy (separate, user-gated), SMTP password rotation, server rate-limiting.
