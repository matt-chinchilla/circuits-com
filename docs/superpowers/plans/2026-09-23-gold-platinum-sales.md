# Gold & Platinum Sales on /join — Implementation Plan

> **For agentic workers:** execution is **parallel worktree seats per wave + one assembly seat**, then **ONE general review at the end** (owner rule 2026-09-22, memory `feedback_single_end_review` — no per-task reviews). Each seat implements only its own task(s), TDD, commits small units on its own branch, and never dispatches subagents. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Customers buy Gold/Platinum (and Silver at its Founder's Deal) on /join through Stripe Checkout; reps create discount codes and run every billing action from /admin; Stripe bills monthly; our DB mirrors it; a 14-day sweep releases non-payers.

**Architecture:** One server-side price rule (`sales_pricing`) feeds checkout, quotes and the console; one amount-off coupon per price. Checkout holds exclusive slots in `checkout_intents` (partial unique index). The webhook mirrors invoices before its status gates and activates sales from intents; Stripe follow-ups (card move, conflict refunds, voids) run as FastAPI background tasks with an hourly in-process sweep as the backstop. Admin routes wrap a Stripe ops layer (`stripe_billing`) pinned to `Stripe-Version: 2026-07-29.dahlia`.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic (PG16, SQLite in tests) · raw httpx to Stripe (no SDK) · React 19 + TS strict + SCSS modules + vitest · Stripe Checkout / Billing / Customer Portal.

**Spec:** `docs/superpowers/specs/2026-09-23-gold-platinum-sales-design.md` (v2, commit 088065b). **Code map:** `.superpowers/sdd/2026-09-23-gold-platinum-sales/facts/*.md`. **Review findings:** `.superpowers/sdd/2026-09-23-gold-platinum-sales/review/*.md`. **Task 0 (done):** `task0-stripe-versions.md` — both accounts default `2026-07-29.dahlia`.

## Global Constraints

- Price rule, verbatim: `price(tier, code_pts) = max(FLOOR, FOUNDER - ceil(code_pts * LIST / 100))`; `LIST = QUOTE_LADDER[tier][0]` (250/2500/10000); `FOUNDER = {silver: 210, gold: 2100, platinum: 8500}`; `FLOOR = LIST * 70 // 100`; `code_pts` 0–15. No other code computes a price; the browser renders only server numbers.
- One `amount_off`, `duration: forever` coupon per price, id `{TIER}-AT-{price}`, name `"{Tier} Founder's Deal — ${price}/mo"` when created by checkout; never percent coupons; never two discounts on one subscription.
- `Stripe-Version: 2026-07-29.dahlia` on every app Stripe call. Field paths per spec §5 (invoice → `/v1/invoice_payments`; period end from `items.data[]`; clear discount with `discounts=`).
- Query strings to Stripe ONLY via httpx `params=`. Stripe ids regex-validated before path interpolation. Every Stripe POST from a console action or the sweep carries an `Idempotency-Key`.
- Checkout: `payment_method_types[]=card`, `automatic_tax.enabled`, `billing_address_collection=required`, Stripe `expires_at = now + 35 min`, hold = that + 10 min.
- Webhook: every verified event → 200 + a distinct outcome string; existing outcome strings unchanged; catch `IntegrityError` AND `InternalError`; `category_cache.clear()` after every sponsor write.
- Status literals are TitleCase `'Active' | 'Paused' | 'Expired'`, compared case-sensitively. Tier keys lowercase in code, normalize on read.
- New public routes → `PUBLIC_ROUTES` in `api/tests/test_every_route_is_gated.py`. Admin routes on routers with `dependencies=[Depends(require_staff)]`; billing/code READS also `Depends(require_billing_reader)` (403 `no_billing_access` for viewers).
- Every 4xx `detail` is a STRING; every new machine code gets a `CODE_MESSAGES` entry in `frontend/src/admin/services/apiError.ts`.
- New Settings → both compose files' `environment:` allowlists with defaults mirroring code, plus `test_compose_env_passthrough.py` assertions.
- No `<input type="url|email|tel">` (and never spell that token in comments). Non-ASCII glyphs in JSX as entities or `{'→'}`. `setSearchParams` never in effect deps. Async effects carry cancel flags.
- Frontend gates: `npx tsc -b`, `npx eslint --ext .ts,.tsx src/`, `npm test`. API gate: `cd api && pytest tests/ -q`.
- Commits: small units on your seat branch; **never add Co-Authored-By or any attribution trailer** (owner rule).
- UI tasks: design pass with `frontend-design` + a Figma component search (`figma-use`, if the Figma connector is signed in); a shader only if it arises organically (the Gold/Platinum price ticket is the one candidate); reduced-motion states; no per-path SVG filters, no animated `drop-shadow`, `whileHover` only behind `@media (hover: hover)`.

## Review Focus

Inputs the spec implies that tests most easily miss; each has a test in the named task.
1. **A buyer hits Back on Stripe and immediately tries again** → their own hold must not block them (release path works; if the stash is gone the hold still lapses and a staff Release exists). → T4 `test_release_frees_own_slot_for_immediate_retry`.
2. **`invoice.paid` for the first invoice arrives BEFORE `checkout.session.completed`** → the payment row exists and attaches to the sponsor at activation. → T5 `test_first_invoice_paid_before_completion_is_attached`.
3. **A code typed in lower case, with spaces or a dash, or with O/0 and I/1 confusion** → normalizes to the same code. → T1 `test_normalize_code_variants`.
4. **A rep clicks Refund twice / network retry** → one refund. → T7 `test_refund_idempotency_key_forwarded_and_reused`.
5. **A paused (still-paying) Gold sponsor's slot** → never offered or sold. → T4 `test_paused_sponsor_slot_is_taken`.

---

## Wave map (what runs in parallel)

| wave | seats (parallel within a wave) | merges into |
|---|---|---|
| **1** | **T1** data foundation · **T2** Stripe ops layer · **T3** ops (deploy/sandbox/reseed) | integration branch `sales/integration` (assembly seat), then re-based seats for wave 2 |
| **2** | **Track A:** T4 public checkout API · **Track B:** T5 webhook → T6 follow-ups + sweep + guards (one seat, sequential) · **Track C:** T7 admin API · **Track D:** T8 /join UI · **Track E:** T9 admin UI | `sales/integration` |
| **3** | **T10** assembly + sandbox rehearsal + docs → **T11** general review + one fix round | `updates` (ff) |

Seats branch from `sales/integration` at their wave's start. Known shared-file merges (trivial, resolved by the assembly seat): `api/app/main.py` (router registration, lifespan), `api/tests/test_every_route_is_gated.py` (allowlist lines), `frontend/src/public/services/api.ts` vs admin (separate files — no clash).

---

## Wave 1

### Task T1: Data foundation — migration 057, models, price rule, code core, occupancy, mirror helpers, settings, scopes

**Files:**
- Create: `api/alembic/versions/057_gold_platinum_sales.py`
- Create: `api/app/models/sales.py`
- Modify: `api/app/models/__init__.py` (register 5 models)
- Modify: `api/app/models/sponsor.py` (add `exclusive_occupant_clause`)
- Create: `api/app/services/sales_pricing.py`
- Create: `api/app/services/sales_codes.py`
- Create: `api/app/services/checkout_intents.py` (core helpers only; T4 appends)
- Create: `api/app/services/billing_mirror.py`
- Modify: `api/app/config.py` (3 settings)
- Modify: `docker-compose.yml`, `docker-compose.prod.yml` (api allowlist)
- Modify: `api/app/services/data_versions.py`, `frontend/src/admin/services/queryCache.ts` (scope `sales`)
- Modify: `api/tests/test_leads_schema.py` (`ACCEPTED_LOSSES`)
- Modify: `api/tests/conftest.py` (`BILLING_SWEEP_ENABLED=false`)
- Test: `api/tests/test_sales_pricing.py`, `api/tests/test_sales_codes_core.py`, `api/tests/test_sales_models.py`, `api/tests/test_compose_env_passthrough.py` (extend), `api/tests/test_migration_057_pg.py`

**Interfaces — Produces (exact):**
```python
# app/services/sales_pricing.py
TIERS: tuple[str, ...] = ("silver", "gold", "platinum")
EXCLUSIVE_TIERS: tuple[str, ...] = ("gold", "platinum")
FOUNDER_USD: dict[str, int] = {"silver": 210, "gold": 2100, "platinum": 8500}
MAX_CODE_POINTS: int = 15
def list_usd(tier: str) -> int            # QUOTE_LADDER[tier][0]
def founder_usd(tier: str) -> int
def floor_usd(tier: str) -> int           # list * 70 // 100
def price_usd(tier: str, code_points: int = 0) -> int   # raises ValueError outside 0..15 / unknown tier
def coupon_id(tier: str, price: int) -> str             # f"{tier.upper()}-AT-{price}"
def coupon_name(tier: str, price: int) -> str           # f"{tier.capitalize()} Founder's Deal — ${price:,}/mo"

# app/services/sales_codes.py
NOT_VALID_MESSAGE = "This code isn't valid for this purchase."
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"   # Crockford base32 minus I L O U
def generate_code() -> str                      # 8 chars from ALPHABET (secrets.choice)
def normalize_code(raw: str | None) -> str | None   # upper, strip spaces/dashes, O→0, I/L→1; None if not 8 valid chars
def display_code(code: str) -> str              # "XXXX-XXXX"
def usable_code(db, raw: str | None, *, tier: str, category_id: uuid.UUID | None,
                email: str | None, lock: bool = False, now: datetime | None = None) -> SalesCode | None
    # None = not usable for ANY reason. lock=True runs SELECT … FOR UPDATE on the row.
    # email_lock checked only when `email` is not None. Counts open intents referencing the code.

# app/services/checkout_intents.py (core)
OPEN, COMPLETED, EXPIRED, RELEASED, CONFLICT = "open", "completed", "expired", "released", "conflict"
STRIPE_SESSION_MINUTES = 35
HOLD_GRACE_MINUTES = 10
def expire_lapsed(db, now: datetime | None = None) -> int   # open & expires_at < now → expired; no commit
def hash_token(token: str) -> str                           # sha256 hex
def client_ip_hash(ip: str) -> str                          # sha256(ip + ADMIN_SECRET_KEY)[:32]

# app/services/billing_mirror.py  (no commits inside; caller commits)
def audit(db, actor: str, action: str, *, sponsor_id=None, sales_code_id=None, intent_id=None,
          amount_cents: int | None = None, detail: str = "") -> None
def upsert_billing(db, sponsor_id: uuid.UUID, **fields) -> SponsorBilling
def upsert_payment_from_invoice(db, invoice: dict) -> SponsorPayment | None   # None when no subscription id
def attach_payments(db, subscription_id: str, sponsor_id: uuid.UUID) -> int

# app/models/sponsor.py
def exclusive_occupant_clause():  # SQL: status IS NULL OR status != 'Expired'   (R16)
```
Models (`app/models/sales.py`): `SalesCode`, `CheckoutIntent`, `SponsorBilling`, `SponsorPayment`, `BillingAudit` — columns exactly as spec §6, plus `SponsorBilling.void_pending: Boolean default false` (implements spec §10.5's "queued voids").

- [ ] **Step 1: Check `.env` key names for `APP_BASE_URL` (LU-F21), names only**

Run: `cd /home/matthew/circuits-com && grep -c '^APP_BASE_URL=' .env || true`
Expected: `0` (absent). If `1`, stop and report — the allowlist would activate it.

- [ ] **Step 2: Write the failing pricing test**

```python
# api/tests/test_sales_pricing.py
import pytest
from app.services import sales_pricing as sp

@pytest.mark.parametrize("tier,pts,expected", [
    ("silver", 0, 210), ("gold", 0, 2100), ("platinum", 0, 8500),
    ("gold", 10, 1850), ("gold", 15, 1750), ("platinum", 10, 7500),
    ("platinum", 15, 7000), ("silver", 15, 175), ("silver", 10, 185),
])
def test_price_table(tier, pts, expected):
    assert sp.price_usd(tier, pts) == expected

def test_never_below_seventy_percent_of_list():
    for tier in sp.TIERS:
        for pts in range(0, sp.MAX_CODE_POINTS + 1):
            assert sp.price_usd(tier, pts) >= sp.list_usd(tier) * 70 // 100

@pytest.mark.parametrize("pts", [-1, 16, 100])
def test_points_out_of_range_rejected(pts):
    with pytest.raises(ValueError):
        sp.price_usd("gold", pts)

def test_unknown_tier_rejected():
    with pytest.raises(ValueError):
        sp.price_usd("diamond", 0)

def test_coupon_naming():
    assert sp.coupon_id("gold", 1850) == "GOLD-AT-1850"
    assert sp.coupon_name("platinum", 8500) == "Platinum Founder's Deal — $8,500/mo"

def test_founder_literals_match_the_join_page():
    """Cross-language guard: the Join cards advertise JOIN_TIERS.fd; it must equal what we charge."""
    import re, pathlib
    src = (pathlib.Path(__file__).parents[2] / "frontend/src/public/pages/join/index.tsx").read_text()
    gold = re.search(r'id:\s*"gold".*?fd:\s*"\$([\d,]+)"', src, re.S).group(1)
    plat = re.search(r'id:\s*"platinum".*?fd:\s*"\$([\d,]+)"', src, re.S).group(1)
    assert int(gold.replace(",", "")) == sp.FOUNDER_USD["gold"]
    assert int(plat.replace(",", "")) == sp.FOUNDER_USD["platinum"]
```

- [ ] **Step 3: Run it — expect ImportError**

Run: `cd api && pytest tests/test_sales_pricing.py -q` → FAIL (`No module named app.services.sales_pricing`).

- [ ] **Step 4: Implement `sales_pricing.py`**

```python
"""The ONE price rule (spec §4). Nothing else computes a sponsorship price."""
import math

from app.services.stripe_quotes import QUOTE_LADDER

TIERS: tuple[str, ...] = ("silver", "gold", "platinum")
EXCLUSIVE_TIERS: tuple[str, ...] = ("gold", "platinum")
# The Founder's Deal (owner, 2026-09-21 / D8): charged, forever.
FOUNDER_USD: dict[str, int] = {"silver": 210, "gold": 2100, "platinum": 8500}
MAX_CODE_POINTS = 15


def _tier(tier: str) -> str:
    t = (tier or "").strip().lower()
    if t not in TIERS:
        raise ValueError(f"unknown tier {tier!r}")
    return t


def list_usd(tier: str) -> int:
    return QUOTE_LADDER[_tier(tier)][0]


def founder_usd(tier: str) -> int:
    return FOUNDER_USD[_tier(tier)]


def floor_usd(tier: str) -> int:
    return list_usd(tier) * 70 // 100


def price_usd(tier: str, code_points: int = 0) -> int:
    if not isinstance(code_points, int) or not 0 <= code_points <= MAX_CODE_POINTS:
        raise ValueError(f"code_points must be 0..{MAX_CODE_POINTS}")
    base = list_usd(tier)
    discount = math.ceil(code_points * base / 100)
    return max(floor_usd(tier), founder_usd(tier) - discount)


def coupon_id(tier: str, price: int) -> str:
    return f"{_tier(tier).upper()}-AT-{price}"


def coupon_name(tier: str, price: int) -> str:
    return f"{_tier(tier).capitalize()} Founder's Deal — ${price:,}/mo"
```

- [ ] **Step 5: Run — expect PASS**; commit `feat(sales): one server-side price rule with the Founder's Deal and the 30% floor`.

- [ ] **Step 6: Models + migration.** Write `test_sales_models.py` first:

```python
import uuid
from datetime import UTC, datetime, timedelta
import pytest
from sqlalchemy.exc import IntegrityError
from app.models.sales import CheckoutIntent, SalesCode, SponsorBilling, SponsorPayment, BillingAudit

def _intent(**kw):
    base = dict(tier="gold", category_id=uuid.uuid4(), list_usd=2500, founder_usd=2100,
                price_usd=2100, channel="self_serve", sold_by="Daniel", company_name="Acme",
                email="a@acme.test", status="open",
                expires_at=datetime.now(UTC) + timedelta(minutes=45))
    base.update(kw); return CheckoutIntent(**base)

def test_one_live_hold_per_exclusive_slot(db):
    cat = uuid.uuid4()
    db.add(_intent(category_id=cat)); db.commit()
    db.add(_intent(category_id=cat))
    with pytest.raises(IntegrityError):
        db.commit()

def test_expired_hold_does_not_block(db):
    cat = uuid.uuid4()
    db.add(_intent(category_id=cat, status="expired")); db.commit()
    db.add(_intent(category_id=cat)); db.commit()   # no error

def test_silver_intents_never_block(db):
    cat = uuid.uuid4()
    db.add(_intent(tier="silver", category_id=cat)); db.add(_intent(tier="silver", category_id=cat))
    db.commit()

def test_check_literals_match_migration_057():
    import pathlib
    from app.models import sales
    src = (pathlib.Path(__file__).parents[1] / "alembic/versions/057_gold_platinum_sales.py").read_text()
    for literal in (sales.CODE_POINTS_CHECK, sales.MAX_USES_CHECK, sales.LIVE_EXCLUSIVE_WHERE):
        assert literal in src
```
(Use the conftest `db` fixture name the suite already uses — check `tests/conftest.py` and adapt the fixture name, not the assertions.)

Implement `app/models/sales.py` with the §6 columns. Key declarations:

```python
from sqlalchemy import (Boolean, CheckConstraint, Column, DateTime, ForeignKey, Index, Integer,
                        SmallInteger, String, text)
from sqlalchemy.dialects.postgresql import UUID
from app.db.base import Base   # use the same Base the other models import

CODE_POINTS_CHECK = "code_points >= 1 AND code_points <= 15"   # pinned against 057's literal
MAX_USES_CHECK = "max_uses >= 1"
LIVE_EXCLUSIVE_WHERE = "status = 'open' AND tier IN ('gold','platinum')"

class CheckoutIntent(Base):
    __tablename__ = "checkout_intents"
    # ... columns per spec §6 ...
    __table_args__ = (
        Index("uq_live_exclusive_intent", "category_id", unique=True,
              postgresql_where=text(LIVE_EXCLUSIVE_WHERE), sqlite_where=text(LIVE_EXCLUSIVE_WHERE)),
        Index("ix_checkout_intents_status_expires", "status", "expires_at"),
    )

class SponsorBilling(Base):
    __tablename__ = "sponsor_billing"
    sponsor_id = Column(UUID(as_uuid=True), ForeignKey("sponsors.id", ondelete="CASCADE"), primary_key=True)
    # ... per spec §6, plus:
    void_pending = Column(Boolean, nullable=False, server_default=text("false"), default=False)
```
Migration `057_gold_platinum_sales.py` (header style of 056: docstring with `Revision ID: 057` / `Revises: 056`, `revision = "057"`, `down_revision = "056"`, literal constants, never imports app code): creates the five tables, the partial unique index via `op.execute("CREATE UNIQUE INDEX uq_live_exclusive_intent ON checkout_intents (category_id) WHERE status = 'open' AND tier IN ('gold','platinum')")`, and the backfill:

```sql
INSERT INTO sponsor_billing (sponsor_id, stripe_subscription_id, collection_method, channel,
                             list_usd, price_usd, card_link_version, void_pending, updated_at)
SELECT s.id, s.stripe_subscription_id, 'charge_automatically', 'self_serve',
       250, COALESCE(s.amount, 250)::int, 0, false, now()
FROM sponsors s
WHERE s.stripe_subscription_id IS NOT NULL
ON CONFLICT (sponsor_id) DO NOTHING
```
`downgrade()` drops the five tables. A model test pins `CODE_POINTS_CHECK`, `MAX_USES_CHECK` and `LIVE_EXCLUSIVE_WHERE` to the migration's source text (the 055/056 precedent).

`test_migration_057_pg.py`: using `tests/pg_harness.py`, run 057's real `upgrade()` inside the rolled-back transaction; assert the index rejects a second open gold intent on Postgres and that a sponsor with a `stripe_subscription_id` gets exactly one backfilled row. Skips when the local stack is down.

- [ ] **Step 7:** Register models in `app/models/__init__.py` and `__all__`. Add to `test_leads_schema.py`: `ACCEPTED_LOSSES = {"activity_events", "supplier_badges", "sponsor_billing"}`. Run `pytest tests/test_sales_models.py tests/test_leads_schema.py -q` → PASS. Commit `feat(sales): migration 057 — codes, intents (one live hold per exclusive slot), sponsor billing, payments, audit`.

- [ ] **Step 8: Occupancy (R16).** Test first in `test_sales_models.py`:

```python
def test_paused_and_null_occupy_expired_does_not(db, seeded_child_category, make_supplier):
    from app.models.sponsor import Sponsor, exclusive_occupant_clause
    cat = seeded_child_category  # a child with NO gold sponsor; create one via the existing fixtures
    for status, occupies in (("Paused", True), (None, True), ("Active", True), ("Expired", False)):
        s = Sponsor(supplier_id=make_supplier().id, category_id=cat.id, tier="Gold", status=status)
        db.add(s); db.flush()
        hit = db.query(Sponsor).filter(Sponsor.id == s.id, exclusive_occupant_clause()).first()
        assert (hit is not None) is occupies
        db.delete(s); db.flush()
```
(Build the category/supplier with the fixtures conftest already offers; the conftest `seeded_db` child already holds a NULL-status Gold — use a different child.) Implement:

```python
def exclusive_occupant_clause():
    """R16: an exclusive (Gold-on-child / Platinum-on-top) slot is TAKEN by any
    same-category, same-tier row that is not Expired — Paused still pays."""
    from sqlalchemy import or_
    return or_(Sponsor.status.is_(None), Sponsor.status != "Expired")
```
Commit.

- [ ] **Step 9: Code core.** Tests (`test_sales_codes_core.py`):

```python
from app.services import sales_codes as sc

def test_generate_is_eight_unambiguous_chars():
    for _ in range(200):
        c = sc.generate_code()
        assert len(c) == 8 and set(c) <= set(sc.ALPHABET)

def test_normalize_code_variants():
    assert sc.normalize_code(" ab1c-d2ef ") == "AB1CD2EF"
    assert sc.normalize_code("abic-dzef".replace("z", "2")) == "AB1CD2EF"   # I → 1
    assert sc.normalize_code("OOOO-LLLL") == "00001111"                    # O → 0, L → 1
    assert sc.normalize_code("short") is None
    assert sc.normalize_code("ABCD-EFGU") is None                          # U is not in the alphabet
    assert sc.normalize_code(None) is None

def test_display_code():
    assert sc.display_code("AB1CD2EF") == "AB1C-D2EF"
```
plus `usable_code` tests against the DB: inactive, expired, exhausted (`uses == max_uses`), exhausted by an OPEN intent, tier lock mismatch, category lock mismatch, email lock checked only when email given (case-insensitive), and a happy path. Every negative returns `None` (no reason leaks). Implement with `.with_for_update()` when `lock=True`. Commit.

- [ ] **Step 10: Intents core + mirror helpers.** Tests: `expire_lapsed` flips only `open` rows past `expires_at`; `hash_token` stable; `upsert_payment_from_invoice` with a **dahlia-shaped** invoice (subscription id at `parent.subscription_details.subscription`, NO `payment_intent`/`charge` keys) creates then updates by `stripe_invoice_id`, maps `status` (`paid`→paid; `amount_paid==0 and attempted`→failed); returns None without a subscription id; `attach_payments` fills `sponsor_id`; `audit` inserts a row; `upsert_billing` creates then updates. Implement; commit.

- [ ] **Step 11: Settings + compose + scopes.**
  - `config.py`: `BILLING_GRACE_DAYS: int = 14`, `BILLING_SWEEP_ENABLED: bool = True`, `SALES_CARD_LINK_DAYS: int = 7`. conftest: `os.environ.setdefault("BILLING_SWEEP_ENABLED", "false")` beside `CATEGORY_CACHE_WARM`.
  - Both compose files, api service: `APP_BASE_URL: ${APP_BASE_URL:-https://circuitcenter.ai}`, `BILLING_GRACE_DAYS: ${BILLING_GRACE_DAYS:-14}`, `BILLING_SWEEP_ENABLED: ${BILLING_SWEEP_ENABLED:-true}`, `SALES_CARD_LINK_DAYS: ${SALES_CARD_LINK_DAYS:-7}`.
  - `test_compose_env_passthrough.py`: assert all four pass through in both files and that each compose default mirrors `Settings.model_fields[...].default` (follow the existing feed-import tests).
  - `data_versions.SCOPES`: add `"sales": ("sales_codes", "checkout_intents")`; `"money": ("revenue", "expenses", "sponsor_payments", "billing_audit")`; `"sponsors": ("sponsors", "sponsor_billing")`. `queryCache.ts` `DataScope` gains `| 'sales'`.
  - Run `pytest tests/test_data_versions.py tests/test_compose_env_passthrough.py -q` → PASS; `cd ../frontend && npx tsc -b` → clean. Commit.

- [ ] **Step 12:** Full `pytest tests/ -q` green; report file list + commits.

---

### Task T2: Stripe ops layer — version pin, idempotency, coupon helper, `stripe_billing`, shared FakeStripe

**Files:**
- Modify: `api/app/services/stripe_quotes.py`
- Create: `api/app/services/stripe_billing.py`
- Create: `api/tests/fake_stripe.py`
- Test: `api/tests/test_stripe_billing.py`, `api/tests/test_stripe_quotes.py` (keep green; adapt for removed `_TIER_PRODUCTS`)

**Interfaces — Produces (exact):**
```python
# stripe_quotes.py
STRIPE_API_VERSION = "2026-07-29.dahlia"
def make_client(secret_key: str, transport=None) -> httpx.AsyncClient   # now sends Stripe-Version
async def _call(client, method, url, data=None, params=None, idempotency_key: str | None = None) -> dict
async def resolve_tier_prices(client, tier: str) -> list[dict]   # [{"id","product","unit_amount","lookup_key"}] in lookup_keys_for order
async def ensure_price_coupon(client, tier: str, target_usd: int, product_ids: list[str],
                              name: str | None = None) -> str
# _TIER_PRODUCTS and _ensure_ladder_coupon are DELETED; create_sponsor_quote uses the two above.

# stripe_billing.py — every function async, first arg `client`
STRIPE_ID = {"sub": r"^sub_[A-Za-z0-9]{8,64}$", "in": r"^in_[A-Za-z0-9]{8,64}$",
             "cus": r"^cus_[A-Za-z0-9]{8,64}$", "cs": r"^cs_(test|live)_[A-Za-z0-9]{8,128}$"}
def checked_id(kind: str, value: str) -> str             # StripeApiError(…, 422) on mismatch
def period_end(sub: dict) -> int | None                  # max(items.data[].current_period_end)
def cancel_scheduled(sub: dict) -> bool                  # cancel_at_period_end or cancel_at is not None
async def get_subscription(client, sub_id) -> dict
async def list_invoices(client, sub_id, status: str | None = None, limit: int = 24) -> list[dict]
async def invoice_payment_intent(client, invoice_id) -> str    # via /v1/invoice_payments; 409 unsupported_payment
async def refund_invoice(client, invoice_id, amount_cents: int | None, idempotency_key: str) -> dict | None
    # None when already fully refunded (charge_already_refunded → success)
async def cancel_now(client, sub_id, idempotency_key: str) -> dict        # already canceled → returns the sub
async def set_period_end_cancel(client, sub_id, cancel: bool, idempotency_key: str) -> dict  # resume also sends cancel_at=""
async def void_open_invoices(client, sub_id) -> int
async def set_coupon(client, sub_id, coupon_id: str | None, idempotency_key: str) -> dict
    # None → sends discounts="" ; re-reads and raises StripeApiError(502) if the result differs
async def pay_oldest_open_invoice(client, sub_id, idempotency_key: str) -> dict | None
async def preview_next(client, sub_id) -> dict | None     # POST /v1/invoices/create_preview
async def move_card_to_customer(client, sub_id) -> bool   # R14; False when nothing to move
async def default_card(client, customer_id) -> dict | None   # {"brand","last4","exp_month","exp_year"}
async def ensure_portal_configuration(client) -> str
async def card_update_session(client, customer_id, config_id, return_url) -> str   # portal session url
async def search_sponsor_subscriptions(client, sponsor_id: str) -> list[dict]      # non-canceled only
async def expire_checkout_session(client, session_id) -> None  # already expired/complete → no error
async def stamp_customer_supplier(client, customer_id, supplier_id: str) -> None
```

- [ ] **Step 1: Shared FakeStripe.** `tests/fake_stripe.py` — an `httpx.MockTransport` handler with an in-memory store (`subscriptions`, `invoices`, `invoice_payments`, `coupons`, `customers`, `payment_methods`, `sessions`, `portal_configurations`, `refunds`) and a `tape` of `(method, path, form, params, headers)`. Rules: filters list endpoints by their query params (the existing FakeStripe lesson); emits **dahlia shapes** — invoices carry `parent.subscription_details.subscription` and **no** `payment_intent`/`charge`/`paid`; subscriptions carry `items.data[].current_period_end`, `cancel_at`, `cancel_at_period_end`, `default_payment_method`, `discounts`; coupons omit `applies_to` unless `expand[]=applies_to`; `/v1/invoice_payments?invoice=…&status=paid` returns `{"data":[{"payment":{"type":"payment_intent","payment_intent":"pi_…"}}]}`; refund of an already-refunded PI answers 400 `code=charge_already_refunded`; cancel of a canceled sub answers 400 with message "…is already canceled…" (or returns it — model both via flags); asserts every request carries `Stripe-Version: 2026-07-29.dahlia`. Expose `fake.client()` → `make_client("sk_test_x", transport=…)`.
- [ ] **Step 2: Failing tests** (`test_stripe_billing.py`), one per function above, e.g.:

```python
def test_invoice_payment_intent_uses_invoice_payments(fake):
    fake.add_paid_invoice("in_000000001", sub="sub_000000001", pi="pi_000000001", amount=210000)
    pi = run(lambda c: sb.invoice_payment_intent(c, "in_000000001"), fake)
    assert pi == "pi_000000001"
    assert fake.last("GET", "/v1/invoice_payments").params == {"invoice": "in_000000001", "status": "paid"}

def test_set_coupon_none_sends_empty_discounts_on_the_wire(fake):
    fake.add_subscription("sub_000000001", discounts=["di_x"])
    run(lambda c: sb.set_coupon(c, "sub_000000001", None, "k1"), fake)
    assert fake.last("POST", "/v1/subscriptions/sub_000000001").form == {"discounts": ""}

def test_refund_already_refunded_is_success(fake):
    fake.add_paid_invoice("in_000000002", sub="sub_000000001", pi="pi_000000002", amount=210000, refunded=True)
    assert run(lambda c: sb.refund_invoice(c, "in_000000002", None, "k2"), fake) is None

def test_idempotency_key_header_forwarded(fake):
    fake.add_paid_invoice("in_000000003", sub="sub_000000001", pi="pi_000000003", amount=210000)
    run(lambda c: sb.refund_invoice(c, "in_000000003", 5000, "refund:abc"), fake)
    assert fake.last("POST", "/v1/refunds").headers["Idempotency-Key"] == "refund:abc"

def test_move_card_to_customer(fake):
    fake.add_subscription("sub_000000001", customer="cus_000000001", default_payment_method="pm_1")
    assert run(lambda c: sb.move_card_to_customer(c, "sub_000000001"), fake) is True
    assert fake.last("POST", "/v1/customers/cus_000000001").form == {"invoice_settings[default_payment_method]": "pm_1"}
    assert fake.last("POST", "/v1/subscriptions/sub_000000001").form == {"default_payment_method": ""}

def test_period_end_reads_items():
    assert sb.period_end({"items": {"data": [{"current_period_end": 5}, {"current_period_end": 9}]}}) == 9

def test_every_request_is_version_pinned(fake):
    run(lambda c: sb.get_subscription(c, "sub_000000001"), fake)
    assert all(h.get("Stripe-Version") == "2026-07-29.dahlia" for *_ , h in fake.tape)
```
Also: `ensure_price_coupon` creates with `applies_to[products][0..1]` from `resolve_tier_prices`' products, reuses when `GET ?expand[]=applies_to` matches (amount/duration/currency/valid/products), 409 when any differs, refuses `target >= list` and `target <= 0` with StripeApiError 422 before any call; `ensure_portal_configuration` pages the list, finds `metadata.managed_by == "circuits-com"`, else creates with exactly `features[payment_method_update][enabled]=true` and the other four features `false`; `checked_id` rejects `sub_../x`.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement (`_flatten` must pass `""` through as `""` — add a unit test; `_call` adds `Idempotency-Key` header when given). Update `create_sponsor_quote` to `resolve_tier_prices` + `ensure_price_coupon`, delete `_TIER_PRODUCTS`/`_ensure_ladder_coupon`; adapt `test_stripe_quotes.py` fakes to return `product` on price rows (keep every assertion's intent). **Step 5:** `pytest tests/ -q` green. Commit in units (`client pin + idempotency`, `ensure_price_coupon`, `stripe_billing ops`).

---

### Task T3: Ops — deploy never builds the frontend on the box; sandbox setup; reseed guard

**Files:**
- Modify: `deploy.sh`
- Create: `scripts/stripe_sandbox_setup.py`
- Test: `api/tests/test_deploy_frontend_ships_prebuilt.py`, `api/tests/test_stripe_sandbox_setup.py`

- [ ] **Step 1: Guard test first**

```python
# api/tests/test_deploy_frontend_ships_prebuilt.py
import pathlib, re
DEPLOY = (pathlib.Path(__file__).parents[2] / "deploy.sh").read_text()

def test_no_remote_line_builds_the_frontend():
    for line in DEPLOY.splitlines():
        if "COMPOSE_CMD build" in line:
            assert not re.search(r"\bbuild\b[^&|;]*\bfrontend\b", line), line

def test_every_deploy_path_ships_the_prebuilt_image():
    for fn in ("deploy_all", "deploy_frontend", "deploy_reseed"):
        body = re.search(rf"{fn}\(\)\s*\{{(.*?)\n\}}", DEPLOY, re.S).group(1)
        assert "ship_frontend_image" in body, fn

def test_ship_builds_from_a_clean_origin_master_worktree():
    body = re.search(r"ship_frontend_image\(\)\s*\{(.*?)\n\}", DEPLOY, re.S).group(1)
    assert "git worktree add" in body and "origin/master" in body
    assert "docker save" in body and "docker load" in body
```
- [ ] **Step 2:** Implement in `deploy.sh`:

```bash
ship_frontend_image() {
    # D7 (2026-09-23 outage): the Vite build + 15k-page prerender swap-thrashes the
    # 1.9 GB box, so the frontend image is built HERE from a clean worktree of
    # origin/master and shipped; the box never builds it.
    local sha wt tag
    git fetch -q origin master
    sha=$(git rev-parse --short origin/master)
    wt=$(mktemp -d "${TMPDIR:-/tmp}/cc-ship-XXXXXX")
    git worktree add -q --detach "$wt" origin/master
    tag="circuits-com-frontend:$sha"
    yellow "Building $tag locally..."
    if ! DOCKER_BUILDKIT=1 docker build -q --target prod -t "$tag" "$wt/frontend" > /dev/null; then
        git worktree remove --force "$wt"; red "Local frontend build failed"; exit 1
    fi
    git worktree remove --force "$wt"
    run_remote "sudo docker image inspect circuits-com-frontend:latest > /dev/null 2>&1 && sudo docker tag circuits-com-frontend:latest circuits-com-frontend:previous || true"
    yellow "Shipping $tag to the box..."
    docker save "$tag" | gzip -1 | { push_ssh_key; ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=no "$EC2_USER@$EC2_IP" 'gunzip | sudo docker load'; } \
        || { red "Image transfer failed"; exit 1; }
    run_remote "sudo docker tag $tag circuits-com-frontend:latest"
}
```
Each of `deploy_all`, `deploy_frontend`, `deploy_reseed` calls `ship_frontend_image` BEFORE its remote line, and each remote line drops `build frontend` and uses `up -d --no-build frontend` where it starts the frontend (the full paths keep `build api calendar-reminders cost-sync feed-import` then `up -d`, which does not rebuild an existing image). Add to `verify_site`: `curl -s -o /dev/null -w '%{http_code}' -X POST https://circuitcenter.ai/api/stripe/webhook` must be `400`.
- [ ] **Step 3: Reseed guard.** In `confirm_reseed`, before the existing prompt, count `SELECT count(*) FROM sponsor_billing b JOIN sponsors s ON s.id=b.sponsor_id WHERE s.status IS NULL OR s.status <> 'Expired'` on the box (through `run_remote … psql … < /dev/null`); if non-zero, print "Stripe-billed sponsors that will lose their board but keep being charged: N" and require the operator to type N. Test by grepping the function body for that sentence and the typed-count check.
- [ ] **Step 4: Sandbox setup.** `scripts/stripe_sandbox_setup.py` (stdlib urllib like `scripts/invoice.py`; `Stripe-Version: 2026-07-29.dahlia`): refuses unless the key starts `sk_test_`; idempotently ensures for gold and platinum the two products (tax codes `txcd_10701000` advertising / `txcd_10103001` platform) and monthly INCLUSIVE prices with lookup keys `{tier}_{advertising|platform}_monthly` at 90/10 of list (Gold 225000+25000 cents, Platinum 900000+100000); ensures the portal configuration exactly as T2's `ensure_portal_configuration`. `--dry-run` prints the plan. Test: a unit test monkeypatches the HTTP function and asserts a `sk_live_` key exits non-zero without any request and that the price bodies carry `tax_behavior=inclusive` and the lookup keys. Commit.

---

## Wave 2 (starts when T1 and T2 are merged into `sales/integration`)

### Task T4 (Track A): Public checkout API

**Files:**
- Modify: `api/app/services/checkout_intents.py` (append), `api/app/services/stripe_checkout.py`, `api/app/routes/checkout.py`
- Modify: `api/tests/test_every_route_is_gated.py` (4 new PUBLIC_ROUTES)
- Test: `api/tests/test_checkout_exclusive.py`, `api/tests/test_checkout.py` (Silver contract updates)

**Interfaces — Produces:**
```python
# checkout_intents.py (appended)
class SlotTaken(Exception): ...
class SlotHeld(Exception):  held_until: datetime
class AlreadySponsor(Exception): ...
class HoldLimit(Exception): ...
class CodeInvalid(Exception): ...
@dataclass
class SlotRow: category_id: str; name: str; parent_name: str | None; path: str; state: str; held_until: str | None
def slot_rows(db, tier: str, now=None) -> list[SlotRow]
def quote(db, *, tier, category_id=None, code=None, email=None) -> dict   # spec §7 /quote shape
def open_exclusive_intent(db, *, tier, category_id, code, company_name, email, website, ip, now=None) -> tuple[CheckoutIntent, str]
    # returns (intent, release_token); raises the exceptions above; commits the hold
def release(db, release_token: str) -> CheckoutIntent | None   # open → released (caller expires the Stripe session)

# stripe_checkout.py
async def create_tier_checkout_session(client, *, intent: CheckoutIntent, customer_id: str | None,
                                       success_path: str, cancel_path: str) -> dict   # {"session_id","url"}
def silver_monthly_usd() -> int   # unchanged meaning: LIST (for the legacy gate + old bundles)
```
Route contracts (JSON):
```
GET  /api/checkout/exclusive/slots?tier=gold
  200 {"tier":"gold","list_usd":2500,"founder_usd":2100,
       "slots":[{"category_id","name","parent_name","path","state":"open"|"held","held_until":null|"ISO"}]}
POST /api/checkout/quote {"tier","category_id"?,"code"?,"email"?}
  200 {"tier","list_usd","founder_usd","price_usd","savings_usd",
       "code": null | {"accepted": bool, "points": int|null, "message": str|null},
       "slot_state": "open"|"held"|"taken"|null}
POST /api/checkout/exclusive {"tier","category_id","code"?,"company_name","email","website"?}
  200 {"url","release_token","held_until"}
  409 {"detail": "slot_taken"} | {"detail": "slot_held", ...held_until in message} | {"detail":"already_sponsor"}
  422 string details ("This code isn't valid for this purchase.", validation)
  429 {"detail":"hold_limit"}
POST /api/checkout/exclusive/release {"release_token"}  → 200 {"released": bool}
GET  /api/checkout/silver         → adds "price_usd":210, "founder_usd":210   (monthly_total stays 250)
GET  /api/checkout/silver/boards  → adds "price_usd", "founder_usd"
```
(For 409 `slot_held`, return `{"detail": "slot_held"}` with the time in a response header `X-Held-Until` so `detail` stays a machine code; the client reads the header.)

- [ ] **Step 1: Failing tests** (`test_checkout_exclusive.py`, shared FakeStripe via `monkeypatch.setattr(stripe_quotes, "make_client", fake.make_client)`):
  - slots: Gold lists children without an occupant; Platinum lists top-level; **`test_paused_sponsor_slot_is_taken`** (a Paused Gold on child X → X absent); a live intent → `state=held` with `held_until`; an expired intent → `open`.
  - quote: no code → 2100 Gold; valid 10-pt code → 1850, `code.accepted=true`; tier-locked code on the other tier → `accepted=false`, message is the uniform sentence; email-locked code without email → accepted; with a wrong email → not accepted; `slot_state` values.
  - exclusive POST: happy path commits one `open` intent with price 2100, session form carries `payment_method_types[0]=card`, `expires_at` ≈ now+35 min, `discounts[0][coupon]=GOLD-AT-2100`, `metadata[intent_id]`, `subscription_data[metadata][intent_id]`, `success_url=…/join?welcome=gold`, `cancel_url=…/join?released=1`, header `Idempotency-Key: checkout:{intent_id}`; second buyer same slot → 409 `slot_held` + `X-Held-Until`; occupied slot → 409 `slot_taken`; Stripe 502 on session create → intent `expired` and a retry succeeds; **`test_release_frees_own_slot_for_immediate_retry`**; one open intent per IP (429) and per email (429); two lapses on the same slot by the same email in 24 h → 429; a released hold does not count; single-use code used by two concurrent intents → second gets 422 (sequential simulation of the FOR UPDATE path); bound code (R7) with a company that has an Active row on that category → 409 `already_sponsor`; bound code → session uses `customer=` + `customer_update[address]=auto` + `customer_update[name]=auto` and no `customer_email`.
  - Silver: GET probes add `price_usd:210`, `founder_usd:210`, keep `monthly_total:250`; Silver POST session carries `discounts[0][coupon]=SILVER-AT-210`, card-only, `metadata[intent_id]` and records a non-blocking `silver` intent; update `test_session_carries_the_contract` expectations deliberately (the `?welcome=silver` success URL stays).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. `open_exclusive_intent` in one transaction: `expire_lapsed` → validate tier ∈ EXCLUSIVE_TIERS and category shape (Gold = child, Platinum = top-level; else 422) → R16 occupant check (409 `slot_taken`) → anti-squat checks → `usable_code(..., lock=True)` (422 uniform message) → R7 guard → insert intent (catch `IntegrityError` on the partial index → 409 `slot_held`) → commit → return token. The route then mints the session; on `StripeApiError` it marks the intent `expired`, commits, and answers 502/422 as the Silver route does. Rate limits: reuse `_rate_limited` with a second bucket dict for `/quote` (30 / 10 min). **Step 4:** PASS; add the 4 routes to `PUBLIC_ROUTES` (`GET /api/checkout/exclusive/slots`, `POST /api/checkout/quote`, `POST /api/checkout/exclusive`, `POST /api/checkout/exclusive/release`); full suite green. Commit per unit.

---

### Task T5 (Track B, part 1): Webhook — mirror before gates, intent activation, conflicts, legacy path

**Files:**
- Modify: `api/app/services/stripe_webhook.py`, `api/app/routes/stripe_webhooks.py`
- Create: `api/app/services/billing_followups.py` (stubs here are REAL functions; T6 fills the Stripe side — see Interfaces)
- Test: `api/tests/test_stripe_webhook_sales.py`, `api/tests/test_stripe_webhook.py` / `test_checkout.py` (keep green)

**Interfaces — Produces:**
```python
# stripe_webhook.py
def apply_stripe_event(db, event: dict) -> str          # unchanged signature
FOLLOWUP_OUTCOMES = {"checkout_activated", "checkout_conflict_refunding", "status_expired"}
def followup_for(event: dict, outcome: str) -> tuple[str, str] | None
    # ("post_activation", sponsor_id) | ("conflict", intent_id) | ("void", sponsor_id) | None

# billing_followups.py  (T5 creates the module + dispatcher; T6 implements the three bodies)
async def run_followup(kind: str, ref: str) -> None     # opens its own SessionLocal + make_client; never raises
```
The route (`stripe_webhooks.py`) gains `background_tasks: BackgroundTasks` and, after computing the outcome, `if (f := followup_for(event, outcome)): background_tasks.add_task(run_followup, *f)`. It still returns 200 with the outcome.

- [ ] **Step 1: Failing tests** (`test_stripe_webhook_sales.py`, calling `apply_stripe_event(db, event)` directly plus one signed end-to-end through the route):
  - **`test_first_invoice_paid_before_completion_is_attached`**: deliver `invoice.paid` (dahlia shape, subscription `sub_A`, no sponsor yet) → outcome `no_sponsor_id` but a `sponsor_payments` row exists; then `checkout.session.completed` for the intent → sponsor created with `stripe_subscription_id=sub_A`, the payment row's `sponsor_id` is set.
  - renewal `invoice.paid` on an Active sponsor → outcome `unchanged` AND the payment row is upserted AND `failing_since` cleared.
  - `invoice.payment_failed` → `failing_since` set once (a second failure keeps the first date); sponsor status untouched (`test_payment_failed_changes_nothing` still passes).
  - new path happy: Gold intent → sponsor `Active`, tier `Gold`, `amount=2100`, `sold_by` = code rep (or `SELF_SERVE_ONBOARDING_REP`), `sponsor_billing` row (channel, prices, customer id, collection `charge_automatically`), code `uses+1`, intent `completed`, audit `sale_activated`, `category_cache.clear` called (monkeypatch spy), outcome `checkout_activated`.
  - `amount_total` missing → conflict `amount_mismatch`; wrong amount → conflict `amount_mismatch`; slot occupied (incl. **Paused**) → conflict `slot_taken`; category deleted → `category_missing`; tier-matrix violation → `matrix` (and the trigger path never raises: simulate `InternalError` from commit → rolled back, still 200); redelivery of `completed` for a `completed` intent → `duplicate_checkout`; for a `conflict` intent → `conflict_already_queued`; intent `expired` but slot free → activates.
  - R13: sponsor with stored `sub_A`; an `invoice.paid` for `sub_B` whose metadata names the same `sponsor_id` → outcome `foreign_subscription`, no status write.
  - R7 reuse: bound supplier with an **Expired** row on the category → that row is reused (tier/status/amount/subscription updated), buyer-typed company/website NOT written onto the supplier.
  - legacy Silver session (metadata `self_serve=silver`, no `intent_id`) with `amount_total=25000` → `checkout_activated` exactly as before; with `amount_total` missing → `amount_mismatch`.
  - `customer.subscription.deleted` → `status_expired`, cache cleared, `sponsor_billing.void_pending=true`.
  - route: a `checkout_activated` delivery schedules `run_followup("post_activation", sponsor_id)` (spy on BackgroundTasks via monkeypatching `run_followup`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement per spec §8; keep every existing outcome string. Mirroring (`upsert_payment_from_invoice`, lazy sponsor resolution, `upsert_billing`, `failing_since`) runs before the gates and commits in its own short transaction so a gate's early return keeps it. Wrap commits in `except (IntegrityError, InternalError)`. **Step 4:** PASS + full suite. Commit per unit.

### Task T6 (Track B, part 2 — same seat, after T5): follow-ups, sweep thread, needs-attention routes, R15 guards

**Files:**
- Modify: `api/app/services/billing_followups.py`
- Create: `api/app/services/billing_sweep.py`, `api/app/jobs/billing_sweep.py` (CLI lever), `api/app/routes/admin_checkout_intents.py`
- Modify: `api/app/main.py` (lifespan starts the sweep when `BILLING_SWEEP_ENABLED`; register router), `api/app/routes/admin_sponsors.py`, `api/app/routes/suppliers.py`
- Test: `api/tests/test_billing_sweep.py`, `api/tests/test_billing_followups.py`, `api/tests/test_admin_checkout_intents.py`, `api/tests/test_billing_active_guard.py`

**Interfaces — Produces:**
```python
# billing_followups.py
async def post_activation(db, client, sponsor_id) -> bool   # R14 card move, stamp supplier on customer, mirror latest_invoice; sets post_activation_done_at
async def resolve_conflict(db, client, intent_id) -> bool   # cancel → refund EVERY paid invoice → resolved_at; idempotency keys conflict-cancel:{id} / conflict-refund:{id}:{invoice}
async def void_pending(db, client, sponsor_id) -> bool
# billing_sweep.py
def run_sweep(now: datetime | None = None) -> dict          # counts per duty; sync entry, runs the async parts via asyncio.run
def start_sweeper() -> None                                  # daemon thread, idempotent, sleeps to the next hour boundary
# routes (require_staff; GET also require_billing_reader from T7 — import it; if T7 has not merged, T10 wires it)
GET  /api/admin/checkout-intents/attention  → {"conflicts":[…], "holds":[…], "failing":[…]}
POST /api/admin/checkout-intents/{id}/resolve  → {"resolved": bool}
POST /api/admin/checkout-intents/{id}/release  → {"released": bool}
```
- [ ] **Step 1: Failing tests** with the shared FakeStripe and an injected `now`:
  - `resolve_conflict`: cancels first, then refunds every paid invoice, then sets `resolved_at`; a failed refund leaves `resolved_at` NULL and a second run completes; "already canceled" and `charge_already_refunded` count as done; the idempotency keys on the tape are `conflict-cancel:{id}` and `conflict-refund:{id}:{in}`.
  - `post_activation`: moves the card, stamps `metadata[supplier_id]`, upserts `latest_invoice` payment, sets `post_activation_done_at`; re-run is a no-op.
  - sweep duties: lapsed intents expire; pending post-activation retried; dunning — `charge_automatically` with `failing_since = now-15d` and live status `past_due` → cancel + void + sponsor `Expired` + audit `dunning_cancelled`; same with status `active` (payment recovered) → nothing; `failing_since = now-13d` → nothing; `send_invoice` with an open invoice `due_date = now-15d` → cancelled; live `canceled` → voids only; `void_pending` rows voided and flag cleared; an exception in one row does not stop the others; missing tables (drop-and-run in a throwaway engine) → warning, no crash.
  - `start_sweeper` is not started under pytest (`BILLING_SWEEP_ENABLED=false`).
  - R15: DELETE sponsor, DELETE supplier (with a billed sponsor), PATCH sponsor `status=Expired` → 409 `billing_active` while the sponsor has a `sponsor_billing` row with a `stripe_subscription_id` AND its status is not `Expired` (no Stripe call; the webhook's `customer.subscription.deleted` and every console/sweep cancel set `Expired`, which is what lifts the guard); Paused PATCH still 200; an already-Expired billed sponsor deletes normally.
  - attention routes: lists; resolve calls `resolve_conflict`; release expires the Stripe session and marks `released`; viewer → 403 on POST; customer → 403.
- [ ] **Step 2-4:** FAIL → implement → PASS + full suite. `start_sweeper` loop: `run_sweep()` then `time.sleep(3600 - (time.time() % 3600))`, every exception logged and swallowed. `python -m app.jobs.billing_sweep --once [--now ISO]` calls `run_sweep(now)` and prints the counts. Commit per unit.

---

### Task T7 (Track C): Admin API — sales codes, billing console, card links, quotes under the rule, billing reader wall

**Files:**
- Create: `api/app/routes/admin_sales_codes.py`, `api/app/routes/admin_billing.py`, `api/app/routes/billing_card.py`, `api/app/services/card_links.py`
- Modify: `api/app/services/auth_service.py` (`require_billing_reader`), `api/app/routes/admin_quotes.py` (R12 + reader wall), `api/app/services/stripe_quotes.py` (`QUOTE_LADDER` → list-only; `create_sponsor_quote(..., code_points)`), `api/app/main.py` (3 routers), `api/tests/test_every_route_is_gated.py` (2 public card routes)
- Test: `api/tests/test_admin_sales_codes.py`, `api/tests/test_admin_billing.py`, `api/tests/test_card_links.py`, `api/tests/test_stripe_quotes.py` (R12 updates), `api/tests/test_billing_reader_wall.py`

**Interfaces — Produces (API contracts the admin UI codes against):**
```
GET   /api/admin/sales-codes            (staff + billing reader)
  200 {"codes":[{"id","code","display","code_points","tier","category_id","category_name",
                 "supplier_id","supplier_name","email_lock","max_uses","uses","expires_at",
                 "rep","created_by","note","active","status":"live"|"expired"|"used_up"|"off",
                 "link","sales":[{"sponsor_id","company","tier","price_usd","sold_at"}]}]}
POST  /api/admin/sales-codes {"code_points","tier"?,"category_id"?,"supplier_id"?,"email_lock"?,
                               "max_uses"?,"expires_in_days"?,"rep"?,"note"?}   → 201 one code (shape above)
        422 "A code tied to a company needs the customer's email." ; 409 already_sponsor
PATCH /api/admin/sales-codes/{id} {"active"?,"expires_in_days"?,"note"?} → 200 one code

GET   /api/admin/sponsors/{id}/billing   (staff + billing reader)
  200 {"configured": true, "subscription_id", "status", "collection_method",
       "cancel_scheduled": bool, "cancel_at": ISO|null, "period_end": ISO|null,
       "next_charge": {"amount_cents","date"}|null, "card": {"brand","last4","exp_month","exp_year"}|null,
       "list_usd","founder_usd","price_usd","code_points": int|null, "channel","sold_by","code": str|null,
       "failing_since": ISO|null, "cancels_on": ISO|null, "legacy_price": bool,
       "invoices":[{"id","number","created","amount_due_cents","amount_paid_cents",
                    "amount_refunded_cents","status","hosted_url","pdf_url","due_date"}],
       "needs_resolution": null | "ambiguous_subscription" | "no_subscription"}
POST  /api/admin/sponsors/{id}/billing/cancel {"when":"period_end"|"now"|"resume"}  (Idempotency-Key header required)
POST  /api/admin/sponsors/{id}/billing/refund {"invoice_id","amount_cents"?}          (Idempotency-Key required)
POST  /api/admin/sponsors/{id}/billing/discount {"code_points": 0..15}                (Idempotency-Key required)
POST  /api/admin/sponsors/{id}/billing/retry-payment {}                               (Idempotency-Key required)
POST  /api/admin/sponsors/{id}/billing/card-link {} → {"url","expires_at","email": supplier billing email|null}
      409 "send_invoice" subscriptions: "This customer pays by emailed invoice — share the invoice link instead."
GET   /api/billing/card/{token}        (public) → 302 portal | 410 "This link has expired — ask your rep for a new one."
GET   /api/billing/card/{token}/done   (public) → 302 /join?card=updated
GET   /api/admin/quote-ladder          → {"tiers":{"gold":{"list":2500,"founder":2100,"floor":1750,
                                          "options":[{"code_points":0,"price_usd":2100}, … 15]}}}
POST  /api/admin/sponsors/{id}/quote {"code_points": 0..15, "address": {...}}   (was monthly_total)
Error machine codes (string details): no_billing_access, billing_active, legacy_price,
  ambiguous_subscription, unsupported_payment, already_sponsor, idempotency_key_required
```
- [ ] **Step 1: Failing tests:**
  - reader wall: viewer GET billing / sales-codes / quote list / quote PDF → 403 `no_billing_access`; admin/owner → 200; customer → 403 `staff_only`.
  - codes: create returns 8-char code + `link` built from its own locks (`/join?code=AB1C-D2EF&tier=gold&slot=<id>`); bound supplier without email_lock → 422; bound supplier with Active row on the placement → 409 `already_sponsor`; PATCH off/extend/note; list status derivation; `rep` defaults to the caller's username; audit rows `code_created` / `code_updated`.
  - billing GET: live composition from FakeStripe (status, period end from items, scheduled cancel via `cancel_at`, next charge from `create_preview`, card from customer default, invoices); `legacy_price=true` when sub items' price ids ≠ the tier's current price ids; rep-quoted row with no stored sub → Search; exactly one → stored; two → `needs_resolution="ambiguous_subscription"`; Stripe unconfigured → 404.
  - cancel `period_end` / `resume` (sends `cancel_at=""` when set) / `now` (cancel + void open invoices + sponsor Expired + cache clear + audit); missing `Idempotency-Key` header → 422 `idempotency_key_required`.
  - refund: invoice of another subscription → 404; full and partial; amount above remainder → 422; **`test_refund_idempotency_key_forwarded_and_reused`** (the route forwards the caller's key; a second call with the same key produces one refund on the fake).
  - discount: 10 pts on a Gold sub → coupon `GOLD-AT-1850` set, verified by re-read; 0 pts → `GOLD-AT-2100`; clearing to list is not offered (0 = Founder's Deal); `legacy_price` → 409; audit `discount_changed` with the new price.
  - retry-payment pays the oldest open invoice.
  - card-link: version bump invalidates the previous token (410); a tampered token → 410; `/done` pays an open invoice once and redirects; the link route performs `move_card_to_customer` before minting the portal session; send_invoice → 409.
  - quotes (R12): ladder payload shape; create with `code_points=10` on Gold → quote total 185000 with coupon `GOLD-AT-1850`; `code_points=16` → 422; `QUOTE_LADDER == {"silver":[250],"gold":[2500],"platinum":[10000]}`.
- [ ] **Step 2-4:** FAIL → implement → PASS + full suite; commit per unit. Card-link token: `base64url(sponsor_id|version|exp) + "." + hmac_sha256(key, payload)[:32]` with `key = sha256(ADMIN_SECRET_KEY + ":card-link")`.

---

### Task T8 (Track D): /join — buy flow, price summary, checkout modal, receipt; Silver renders `price_usd`

**Files:**
- Create: `frontend/src/public/pages/join/exclusive.ts` (pure helpers), `frontend/src/public/pages/join/exclusive.test.ts`, `frontend/src/public/pages/join/ExclusiveBuy.tsx`, `frontend/src/public/pages/join/ExclusiveCheckoutModal.tsx`, `frontend/src/public/pages/join/ExclusiveCheckout.module.scss`
- Modify: `frontend/src/public/pages/join/index.tsx`, `frontend/src/public/services/api.ts`, `frontend/src/public/pages/category/components/SilverCheckoutModal.tsx` (render `price_usd`), `frontend/src/public/pages/category/components/SilverPartners.tsx` (pass `price_usd`)

**Interfaces — Consumes:** the T4 JSON contracts verbatim. **Produces (TS):**
```ts
// exclusive.ts
export type ExclusiveTier = 'gold' | 'platinum';
export interface SlotRow { category_id: string; name: string; parent_name: string | null; path: string; state: 'open' | 'held'; held_until: string | null }
export interface QuoteResult { tier: string; list_usd: number; founder_usd: number; price_usd: number; savings_usd: number; code: null | { accepted: boolean; points: number | null; message: string | null }; slot_state: 'open' | 'held' | 'taken' | null }
export function money(usd: number): string                 // "$2,100"
export function normalizeCodeInput(raw: string): string    // mirrors the server: upper, strip, O→0, I/L→1, re-dash as XXXX-XXXX when 8 chars
export function groupSlots(rows: SlotRow[], tier: ExclusiveTier): { key: string; name: string; rows: SlotRow[] }[]
export function readJoinParams(search: string): { code?: string; tier?: ExclusiveTier; slot?: string; welcome?: ExclusiveTier; released?: boolean; card?: 'updated' }
export const EXCLUSIVE_STASH_KEY = 'cc.exclusiveCheckout';
```
- [ ] **Step 1: Failing vitest** (`exclusive.test.ts`): `money(2100) === '$2,100'`, `money(8500) === '$8,500'`; `normalizeCodeInput(' ab1c d2ef') === 'AB1C-D2EF'`, `normalizeCodeInput('oooollll') === '0000-1111'`; `groupSlots` groups Gold by parent and Platinum flat, drops nothing held; `readJoinParams('?code=ab1c-d2ef&tier=gold&slot=x&released=1')` parses and ignores unknown tiers.
- [ ] **Step 2: Design pass.** Invoke `frontend-design`; if the Figma connector is signed in, run a `figma-use` component search for a slot picker, a price-summary ticket and a receipt that fit the existing /join design language (`JoinPage.module.scss` tokens, `--tsel`, `GlowButton`, `StageNum`); decide whether the Gold/Platinum price ticket earns a shader (only if it fits the metallic language already on the Gold/Platinum boards; reduced-motion = static). Record the decision in the task report.
- [ ] **Step 3: Implement.** In `index.tsx`: read params once (`readJoinParams(window.location.search)` in a `useState` initializer) and strip them with functional `setSearchParams(prev => …, { replace: true })` in a `[]` effect; first confirm the inline page-view tracker in `frontend/index.html` records `location.pathname` only (if it records the query, exclude `code` there). Replace the Gold/Platinum `.arrange` branch (`index.tsx:987-1003`) with `<ExclusiveBuy tier=… initialCode=… initialSlot=… onAskDesk={() => setApplyOpen(true)} />`: fetches slots (cancel-flagged effect; loading / error / unconfigured never reads as sold out), code field (`type="text"`, `autoCapitalize="characters"`, `spellCheck={false}`, `inputMode="text"`), debounced `POST /quote`, price summary (list struck, **Founder's Deal** line, code line, "You pay $X/month, tax included", "12-month minimum · billed monthly"), Buy → `ExclusiveCheckoutModal` (portal; mirrors `SilverCheckoutModal` scrim/Esc/stash rules; stash written only after the URL returns; holds `release_token`; 409/429 copy per spec §11). On `?released=1` post the stashed token to `/checkout/exclusive/release`. `?welcome=gold|platinum` renders the receipt ticket (**PAYMENT RECEIVED**, never "live"); `?card=updated` shows a small confirmation. Copy updates per spec §11 (header contract comment, stage-02 line, `arrange` strings removed, FAQ answer, applying label shows the Founder's Deal). `api.ts`: `getExclusiveSlots`, `quoteExclusive`, `createExclusiveCheckout`, `releaseExclusiveHold`; Silver types gain `price_usd`, `founder_usd`; the Join Silver card and `SilverCheckoutModal` render `price_usd` (fallback `monthly_total` only for an old API response without it); delete `founderMonthly`.
- [ ] **Step 4:** `npx tsc -b`, `npx eslint --ext .ts,.tsx src/`, `npm test` green; SCSS source witnesses for any new rule a test relies on. Commit per unit.

---

### Task T9 (Track E): Admin UI — Sales codes page + Needs attention, Billing panel, QuotePanel under the rule, viewer gating

**Files:**
- Create: `frontend/src/admin/pages/sales-codes/list/index.tsx`, `frontend/src/admin/pages/sales-codes/form/index.tsx`, `frontend/src/admin/pages/sales-codes/SalesCodes.module.scss`, `frontend/src/admin/pages/sponsors/form/BillingPanel.tsx`, `frontend/src/admin/pages/sponsors/form/billingFormat.ts`, `frontend/src/admin/pages/sponsors/form/billingFormat.test.ts`, `frontend/src/admin/pages/sales-codes/salesCodes.test.ts`
- Modify: `frontend/src/admin/routes/ConsoleRoutes.tsx`, `frontend/src/admin/components/AdminLayout.tsx` (nav + `TITLE_MAP`), `frontend/src/admin/services/adminApi.ts`, `frontend/src/admin/services/apiError.ts`, `frontend/src/admin/pages/sponsors/form/index.tsx`, `frontend/src/admin/pages/sponsors/form/QuotePanel.tsx`, `frontend/src/admin/types/admin.ts`

**Interfaces — Consumes:** T6 attention routes and T7 contracts verbatim. **Produces:** `adminApi.listSalesCodes/createSalesCode/updateSalesCode/getAttention/resolveIntent/releaseIntent/getSponsorBilling/cancelBilling/refundInvoice/changeDiscount/retryPayment/createCardLink`; every POST takes an `idempotencyKey: string` argument sent as the `Idempotency-Key` header; reads via `cachedRead` with scopes `['sales']` (codes, attention) and `['money','sponsors']` (billing).

- [ ] **Step 1: Failing vitest:** `billingFormat.ts` — `cents(210000) === '$2,100.00'`; `cancelsOn('2026-09-01T00:00:00Z', 14)` date math; `billingStatusLabel({status:'past_due', failing_since:…})` → "Payment failing since Sep 1 · cancels Sep 15"; `salesCodes.test.ts` — status chip mapping and link text; `apiError` — `apiErrorDetail` maps each new code (`no_billing_access`, `billing_active`, `legacy_price`, `ambiguous_subscription`, `unsupported_payment`, `already_sponsor`, `idempotency_key_required`, `hold_limit`) to prose.
- [ ] **Step 2: Design pass** (frontend-design + Figma component search when signed in) for the codes table, the Needs-attention strip and the billing panel; money actions behind confirm dialogs that state the consequence ("Refund $2,100.00 to Acme?"); each dialog mints `crypto.randomUUID()` once on open and reuses it for retries.
- [ ] **Step 3: Implement.** Routes `sales-codes`, `sales-codes/new` in `ConsoleRoutes.tsx`; nav `{ to: '/admin/sales-codes', label: 'Sales codes', icon: 'ticket' }` after Sponsors in `CATALOG_LINKS` (verify the Phosphor glyph exists in `public/fonts/phosphor-light/`; fall back to `tag`); explicit `TITLE_MAP` entries; customer-mount self-gate; viewer blocked state (403 `no_billing_access`). Billing panel after `QuotePanel` (`sponsors/form/index.tsx:1271`), outside the `<form>`, hidden on 404, `bustingAfter` around cancel-now; card link shows Copy + Open in email (`mailto:` with the supplier's billing email, subject "Update the card for your Circuit Center sponsorship"). QuotePanel: heading "Quotes"; select lists `options` from the new ladder payload ("Founder's Deal — $2,100" / "+10 pts — $1,850"); posts `code_points`. Hide every write button when `useAuth().isReadOnly` (QuotePanel and the sponsor form Save/Delete too). Re-measure the sidebar height at 1080p/100% (must not scroll); if it overflows, tighten per the existing compact block rules.
- [ ] **Step 4:** gates green; commit per unit.

---

## Wave 3

### Task T10: Assembly, sandbox rehearsal, docs

- [ ] **Step 1:** Merge every seat branch into `sales/integration` in order T1, T2, T3, T4, T5+T6, T7, T8, T9; resolve the known shared-file merges; wire `require_billing_reader` into T6's attention GET if T6 predates T7. Run all gates (`pytest tests/ -q`, `npx tsc -b`, `npx eslint --ext .ts,.tsx src/`, `npm test`) — all green.
- [ ] **Step 2: Local test mode.** Apply migration 057 locally (`docker compose up -d --build api` runs alembic). Run `scripts/stripe_sandbox_setup.py` with the sandbox key (key read from `.env` by the script, never printed). Start `stripe listen --api-key "$SANDBOX_KEY" --forward-to http://localhost/api/stripe/webhook --print-secret` to get the `whsec_`; recreate api with `STRIPE_SECRET_KEY=<sandbox> STRIPE_WEBHOOK_SECRET=<whsec> APP_BASE_URL=http://localhost` on ONE command line; rebuild the local frontend (`docker compose up -d --build frontend` — local builds are fine).
- [ ] **Step 3: Rehearsal checklist** — run each and record the result (and any Stripe ids) in `.superpowers/sdd/2026-09-23-gold-platinum-sales/rehearsal.md`: Gold without a code (card `4242…`) → board live within seconds, receipt shown; Platinum with a 15-pt code → $7,000 charged; bound code for an existing supplier; held slot seen from a second browser profile; Back from Stripe → slot free again; forced double payment (two sessions forced by expiring the first hold in the DB) → loser cancelled and refunded, visible in Needs attention until resolved; every console action (cancel period-end → resume; cancel now; full + partial refund; discount change; retry payment; card link → portal → update → `done` → `/join?card=updated`); dunning: set the subscription's card to `pm_card_chargeCustomerFail`, force a renewal with `billing_cycle_anchor=now`, then `docker compose exec api python -m app.jobs.billing_sweep --once --now <ISO +15 days>` → sponsor Expired, slot reopened; confirm the Smart Retries setting reads 3 weeks / leave past-due in the sandbox (owner step).
- [ ] **Step 4: Docs.** CLAUDE.md: rewrite the "Self-serve Silver checkout" and "/join" bullets and the "Sales quotes" bullet; add a compressed "Gold/Platinum sales + billing console" bullet pointing to `docs/claude-gotchas/billing-stripe.md`; add the deploy D7 rule to the deploy bullets. `billing-stripe.md`: the dahlia pin, the field-path table, R10/R11/R14, the conflict/sweep order, the card-on-customer rule, the quote rule. Commit.
- [ ] **Step 5:** Hand the owner the local playtest (URLs + what to try).

### Task T11: General review + one fix round (owner rule: one review at the end)

- [ ] **Step 1:** One max-effort Opus reviewer over `git diff updates...sales/integration` + the spec + `rehearsal.md` + the owner's playtest notes; findings to `.superpowers/sdd/2026-09-23-gold-platinum-sales/final-review.md` ranked BLOCKER/MAJOR/MINOR.
- [ ] **Step 2:** One fix seat for BLOCKER + MAJOR; re-run all gates and the affected rehearsal items; MINORs ledgered.
- [ ] **Step 3:** ff-merge `sales/integration` into `updates`; deploy only on the owner's go-ahead (reporting pulled before and after; `deploy.sh` full path, which now ships the locally built frontend; probes per spec §13.8).
