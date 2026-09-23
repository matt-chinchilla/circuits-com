# Gold & Platinum sales on /join — design

- **Date:** 2026-09-23 · **Status:** design approved in chat (owner, 2026-09-23 14:09); this document awaits owner review
- **Branch:** `updates` · alembic head today `056` → this work adds `057`
- **Code map this spec argues from:** `.superpowers/sdd/2026-09-23-gold-platinum-sales/facts/*.md` (six read-only mappers, every claim anchored `path:line`)

## 1. Intent

Sales reps must be able to sell **Gold** and **Platinum** sponsorships **now**, on `https://circuitcenter.ai/join`, and give discounts, without ever opening the Stripe dashboard. Every sale is billed monthly by Stripe, recorded in our database, and charged automatically each month; a sponsor whose payments stop is released after two weeks.

**Success looks like:**
1. A customer can buy an open Gold (subcategory) or Platinum (top-level category) slot on /join and pay on Stripe's hosted page; the board goes live within seconds of payment, not an hour.
2. A rep can create a discount code in /admin, send the customer a `/join?code=…` link, and see the resulting sale credited to them.
3. From a sponsor's admin page a rep can see its payments and invoices, cancel, refund, change the discount, and send a card-update link — no Stripe access needed.
4. Nothing can charge the customer a price the server did not compute, and two buyers can never both end up paying for one exclusive slot (the loser is refunded automatically).

## 2. Owner decisions (verbatim sources: chat 2026-09-23)

| # | Decision |
|---|---|
| D1 | **Both** channels: self-serve for open slots **and** rep-generated codes. "all actions that would otherwise be done in Stripe need to be able to be done programmatically in the app. They are not allowed to see the Stripe app." |
| D2 | **Discount cap: 30% off list, total.** "we are running a 15% discount right now, they can only add another 15% from the base." |
| D3 | Reps get **all five** console actions now: payments/invoices view, cancel, refund, change discount, card-update link. |
| D4 | **Failed payments:** automatic retries for two weeks, then the sponsorship expires and the slot reopens. |
| D5 | The **Founder price is charged, forever** ("What founding partners keep, forever"), and the customer always gets the better deal (2026-09-21). |
| D6 | UI design choices first search trendy components via the Figma skills; a **shader only where one arises organically** (memory `feedback_design_components_figma`). |
| D7 | Deploys never build the frontend on the prod box again (2026-09-23 outage; memory `project_prod_build_thrash_2026_09_23`). |

## 3. Rulings made while writing this spec (differences from the chat design)

Each is a correction the code map forced; each names what it costs if wrong.

- **R1 — `sold_by` keeps today's meaning.** Self-serve without a code keeps `sold_by = settings.SELF_SERVE_ONBOARDING_REP` (currently "Daniel"); a code sale gets the code's rep. The *channel* (`self_serve` / `rep_code` / `quote`) is recorded in a new column instead. *Why:* a literal "Self-serve" would render as a fake rep in the dashboard's book-of-business and as "(former)" in the Sold-by select (`routes/dashboard.py:563-620`, `sponsors/form/index.tsx:1142`). *If wrong:* a one-line settings change.
- **R2 — The slot hold is NOT a sponsor row.** It is a `checkout_intents` row; one live intent per exclusive slot is enforced by a partial unique index. *Why:* any Active/NULL-status sponsor row renders on the public board (`category_service.active_sponsor_filter`), and a new "Pending" status would ripple through every status union.
- **R3 — Billing state lives beside the sponsor, not on it** (`sponsor_billing`, `sponsor_payments`). *Why:* the webhook's stale-event gate compares `event.created` to `sponsors.updated_at`; writing payment facts onto the sponsor row would make legitimate later events read as stale (`stripe_webhook.py:391-404`).
- **R4 — The audit log is its own staff-only table** (`billing_audit`). *Why:* `activity_events` has no actor column and is readable by the customer console for the customer's own supplier (`account_dashboard.py:594-598`).
- **R5 — The dunning sweep runs inside the api process** (a daemon thread, like the category-cache warmer), not a new container. *Why:* the 1.9 GB box went down today from memory pressure; an extra Python container costs ~80 MB, and only the api process can clear the category cache. *If wrong:* moving it to a container later is mechanical.
- **R6 — "Demo refused" is dropped.** The demo account is retired (migrations 043/044) and `test_demo_is_retired.py` forbids re-adding its helpers. Viewers stay read-only through the existing `require_staff` wall, matching today's quote posture.
- **R7 — A rep code may be bound to an EXISTING supplier.** Self-serve still always mints a fresh supplier (anti-impersonation, unchanged), but a rep who sells to a company already on file picks it when creating the code, so the sale attaches there instead of duplicating the company. *Cost:* the webhook must reuse an inactive `(supplier, category)` row rather than insert (unique `uq_sponsor_supplier_category` has no status predicate).
- **R8 — Codes apply to Gold and Platinum only in this release.** Silver keeps its category-page checkout, gains the Founder price ($210), and gets no code field. *Why:* the ask was Gold/Platinum; a Silver code field means reworking the category-page modal. *If wrong:* the pricing and code tables are tier-generic; only the Silver modal needs the field.
- **R9 — Existing bugs fixed on the way** (all in paths this work rewrites): the webhook never clears the category cache (boards lag ≤ 60 min today); a missing `amount_total` passes the amount gate; a tier-matrix trigger error (`InternalError`) escapes as a 500 and would start a Stripe retry storm; coupon `applies_to` uses hard-coded LIVE product ids so nothing discounted can be tested in the sandbox; the QuotePanel shows write buttons to viewers.

## 4. Pricing — one rule, one home

New module `api/app/services/sales_pricing.py` is the **single home**; nothing else computes a price, and the browser only ever displays numbers the server returned.

```
LIST          = QUOTE_LADDER[tier][0]          # 250 / 2,500 / 10,000 (unchanged single home)
FOUNDER       = {silver: 210, gold: 2100, platinum: 8500}   # owner-set literals (2026-09-21)
FLOOR         = LIST * 70 // 100               # 175 / 1,750 / 7,000  (D2: 30% total cap)
MAX_CODE_PTS  = 15                             # D2: reps add at most 15 points of LIST
FOUNDER_PRICING_ENABLED (Settings, default true) — when false, FOUNDER = LIST for NEW sales

price(tier, code_pts) = max(FLOOR, FOUNDER - ceil(code_pts * LIST / 100))   # whole dollars
```

- `code_pts` is an integer 0–15; 0 means "Founder price only". Rounding favours the customer (`ceil` on the discount).
- Worked values (pinned by tests): Silver 0 → **210**; Gold 0 → **2,100**; Gold 10 → **1,850**; Gold 15 → 1,725 → floor **1,750**; Platinum 10 → **7,500**; Platinum 15 → **7,000**.
- **Charged as ONE `amount_off` coupon, `duration: forever`**, id `{TIER}-AT-{price}` (the existing ladder naming, so a quote and a checkout at the same price share one coupon object). Never a percentage coupon, never two discounts on one subscription (percentages multiply and move the 90/10 NY tax split — `docs/claude-gotchas/billing-stripe.md`).
- `stripe_quotes._ensure_ladder_coupon` becomes a public `ensure_price_coupon(client, tier, target_usd, product_ids)`: adds a `0 < target < list` guard, verifies `amount_off` + `duration` + `currency` + `applies_to` on reuse, and takes the product ids **from the resolved prices** (`GET /v1/prices` rows carry `product`) instead of `_TIER_PRODUCTS`, so it works in the sandbox. The quotes path calls the same helper.
- Founder literals also live on the Join page's `JOIN_TIERS.fd` for display; a cross-language test pins them equal to `FOUNDER` (the `test_site_stats.py` precedent), so the card can never advertise a price the server does not charge.

## 5. Data model — migration `057_gold_platinum_sales`

All new tables are FK-free toward `sponsors`/`suppliers`/`users` **except** `sponsor_billing` (1:1, `ON DELETE CASCADE`), so payment history and the audit trail survive a `--reseed` (whose `TRUNCATE … CASCADE` is transitive) the way `sold_by`/`lead_contacts.recorded_by` do. Actors are username strings, never user FKs.

### `sales_codes`
| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `code` | String(16) UNIQUE | normalised upper-case, Crockford base32 without I/L/O/U, 8 chars, shown as `XXXX-XXXX` (≈10¹² space) |
| `code_points` | SmallInteger | CHECK 1–15 |
| `tier` | String(10) NULL | `gold` / `platinum` / NULL = either (R8) |
| `category_id` | UUID NULL | optional placement lock (validated against the tier matrix at create) |
| `supplier_id` | UUID NULL | optional existing-company binding (R7) |
| `email_lock` | String(200) NULL | checkout email must match, case-insensitive |
| `max_uses` | SmallInteger | default 1, CHECK ≥ 1 |
| `uses` | SmallInteger | redemptions counted at PAID completion |
| `expires_at` | DateTime tz | default now + 14 days |
| `rep` | String(120) | credited as `sold_by`; defaults to the creator |
| `created_by` | String(120) | |
| `note` | String(500) NULL | |
| `active` | Boolean | reps switch codes off; codes are never deleted (history) |
| `created_at` | DateTime tz | |

A code is **usable** when `active` AND `expires_at > now` AND `uses + open_intents_using_it < max_uses` AND its locks match the request. Every "not usable" reason returns the same public message (`This code isn't valid for this purchase.`) so the endpoint cannot be used to probe codes.

### `checkout_intents` (every Checkout Session we mint, all tiers)
`id` UUID PK · `stripe_session_id` String(255) UNIQUE NULL (set after Stripe answers) · `tier` · `category_id` NULL · `keyword` NULL · `sales_code_id` NULL · `supplier_id` NULL (R7) · `list_usd` Integer · `price_usd` Integer · `channel` String(12) · `sold_by` String(120) · `company_name` · `email` · `website` · `status` String(12) `open|completed|expired|conflict` · `expires_at` DateTime tz · `created_at` · `resolved_at` NULL.

- **The hold:** partial unique index `uq_live_exclusive_intent ON checkout_intents (category_id) WHERE status = 'open' AND tier IN ('gold','platinum')`, declared on the model (`postgresql_where` + `sqlite_where`) so the test suite builds it too.
- Before inserting, the same transaction marks `open` intents whose `expires_at < now()` as `expired`, so a lapsed hold never blocks.
- `expires_at` = Stripe session `expires_at` (now + 31 min; Stripe's minimum is 30) **+ 10 min grace** for webhook latency.
- The webhook's expected amount comes **from this row** (looked up by session id), never from Stripe metadata.

### `sponsor_billing` (1:1 with a Stripe-billed sponsor)
`sponsor_id` UUID PK FK→sponsors CASCADE · `stripe_customer_id` · `stripe_subscription_id` (also for rep-quoted rows, captured on their first `invoice.paid`) · `channel` · `list_usd` · `price_usd` · `sales_code_id` NULL · `payment_failing_since` DateTime tz NULL · `cancel_at_period_end` Boolean · `current_period_end` DateTime tz NULL · `updated_at`.

### `sponsor_payments` (mirror of Stripe invoices, fed by the webhook)
`id` UUID PK · `stripe_invoice_id` UNIQUE · `stripe_payment_intent_id` NULL · `sponsor_id` UUID (no FK) · `amount_due_cents` · `amount_paid_cents` · `amount_refunded_cents` · `status` `paid|failed|refunded|partially_refunded` · `invoice_created_at` · `paid_at` NULL · `hosted_invoice_url` NULL · `updated_at`. Idempotent by invoice id: every event upserts.

### `billing_audit` (staff-only, append-only)
`id` · `created_at` · `actor` String(120) (`username`, or `system:webhook` / `system:dunning`) · `sponsor_id` UUID NULL · `sales_code_id` UUID NULL · `action` String(40) (`code_created`, `code_disabled`, `checkout_started`, `sale_activated`, `sale_conflict_refunded`, `cancel_period_end`, `cancel_now`, `refund`, `discount_changed`, `card_link_created`, `card_link_emailed`, `dunning_cancelled`) · `amount_cents` NULL · `detail` String(500).

### Changes to existing
- `sponsors`: none. `amount` for new sales = the **charged** monthly price (Silver self-serve used to store list).
- `data_versions.SCOPES`: new scope `"sales": ("sales_codes", "checkout_intents")`; `"money"` += `sponsor_payments`, `billing_audit`; `"sponsors"` += `sponsor_billing`. The TS `DataScope` union gains `'sales'` in the same change (`test_data_versions.py` pins both).

## 6. Public API (`/api/checkout`, all 404 when `STRIPE_SECRET_KEY` is unset)

| route | purpose |
|---|---|
| `GET /api/checkout/exclusive/slots?tier=gold\|platinum` | Open and held slots. Gold = subcategories, Platinum = top-level categories. Each row: `category_id, name, parent_name, path, state: "open" \| "held"`, `held_until` for held rows. Taken slots are omitted (the Silver `open_slots === 0` precedent). Also returns `list_usd`, `founder_usd`. |
| `POST /api/checkout/quote` `{tier, category_id?, code?}` | The price summary: `list_usd, founder_usd, code: {accepted, points} \| null, price_usd, savings_usd, slot_state`. No side effects. |
| `POST /api/checkout/exclusive` `{tier, category_id, code?, company_name, email, website?}` | Re-validates slot, code, locks and price server-side; inserts the intent (the hold); mints the Stripe Checkout Session; returns `{url}`. 409 `slot_taken` / `slot_held` (with `held_until`), 422 on validation. |
| `GET /api/billing/card/{token}` | Card-update redirect (§8). |

- Silver keeps `GET/POST /api/checkout/silver*`, now priced by `sales_pricing.price("silver", 0)` = $210 and recorded as an intent (non-blocking: Silver's 5-per-board capacity rule is unchanged).
- **Session contract** (all tiers): `mode=subscription`, both tier prices, `discounts=[{coupon}]` when price < list, `automatic_tax.enabled`, `billing_address_collection=required`, `customer_email` = the entered email (Stripe locks it), `expires_at`, metadata on session **and** `subscription_data`: `managed_by=circuits-com`, `intent_id`, `tier`. Gold/Platinum `success_url` = `{APP_BASE_URL}/join?welcome={tier}`, `cancel_url` = `{APP_BASE_URL}/join`.
- **Rate limits** (in-process, per IP, the existing `_rate_limited` pattern): checkout POSTs 8 / 10 min (unchanged); quote 30 / 10 min; after 10 rejected codes in an hour an IP gets only the generic message until the hour passes.
- All four new public routes are added deliberately to `PUBLIC_ROUTES` in `test_every_route_is_gated.py`.

## 7. Webhook changes (`services/stripe_webhook.py`)

The module keeps its contract: every verified event gets a 200 and a distinct outcome string; lifecycle events write `sponsors.status` only; creation on `checkout.session.completed` is the sole exception. Every existing outcome string and test stays.

| event | new behaviour |
|---|---|
| `checkout.session.completed` | **New path** when metadata has `intent_id`: load the intent by session id → gates: paid · subscription present · **`amount_total` present AND equal to `intent.price_usd × 100`** · idempotent by subscription id · tier-matrix pre-check (so the trigger never fires) · slot still free. Then create or reuse the supplier (fresh, or the code's bound supplier with inactive-row reuse, R7), create the sponsor (`status Active`, `amount` = price, `sold_by`), write `sponsor_billing`, count the code's use, mark the intent `completed`, audit `sale_activated`, **`category_cache.clear()`**. **Legacy path** (metadata `self_serve=silver`, no `intent_id`) unchanged except that a missing `amount_total` now fails, so Silver sessions minted before the deploy (24 h default expiry) still complete. |
| — slot lost to a race | Intent → `conflict` (the queue IS `checkout_intents` rows with `status='conflict' AND resolved_at IS NULL` — no separate table); outcome `checkout_conflict_refunding`; the route schedules the refund as a FastAPI background task after acking, and the sweep (§9) retries anything left. |
| `checkout.session.expired` (new) | Intent → `expired` (the hold is released). |
| `invoice.paid` | Unchanged status write, **plus**: upsert `sponsor_payments`, clear `payment_failing_since`, capture `stripe_subscription_id`/`stripe_customer_id` into `sponsor_billing` for rep-quoted rows, `category_cache.clear()` when the status changed. |
| `invoice.payment_failed` | Still writes no sponsor status (`test_payment_failed_changes_nothing` holds); upserts `sponsor_payments` as failed and sets `payment_failing_since` if unset. |
| `charge.refunded` (new) | Resolves the payment row via `invoice` or `payment_intent` and updates the refunded amount and status. |
| `customer.subscription.updated` (new) | Mirrors `cancel_at_period_end`, `current_period_end` into `sponsor_billing` (no sponsor write). |
| `customer.subscription.deleted` | Unchanged → `Expired`, **plus `category_cache.clear()`**. |

- `IntegrityError` **and** `InternalError` are both caught around every commit (roll back, still ack).
- The live endpoint `we_1U4WbrDqTxm052QNt6qH7IUn` must additionally subscribe to `checkout.session.expired`, `charge.refunded`, `customer.subscription.updated`. `enabled_events` **replaces** the list, so a new `scripts/stripe_webhook_events.py` does GET → union → POST (idempotent, `--live` gate). Running it against live is a rollout step that needs the owner's go-ahead (§12).

## 8. Rep console (admin, no Stripe access)

All routes sit on a router with `dependencies=[Depends(require_staff)]` (viewers read, 403 `read_only` on writes); all 404 when Stripe is unconfigured; Stripe ids are regex-validated before path interpolation; query strings only via `params=`; every POST carries an `Idempotency-Key` (new optional `_call` argument); every action writes `billing_audit`; error `detail`s are strings, with new machine codes added to `CODE_MESSAGES`.

### Sales codes — `/api/admin/sales-codes`
`GET /` (list with uses, rep, status, the sales each code produced), `POST /` (create: points 1–15, tier, optional category / supplier / email locks, max uses, expiry, note; returns the code and its `/join?code=` link), `PATCH /{id}` (switch off, extend expiry, edit note). No delete.

### Billing — `/api/admin/sponsors/{id}/billing`
| route | Stripe calls |
|---|---|
| `GET` | subscription (`expand[]=default_payment_method`, falling back to the customer's default) + its invoices + our `sponsor_payments`; returns status, next charge date and amount, card brand/last4/expiry, current price and discount, list price, channel, sold_by, code, `payment_failing_since`, invoices (number, date, amount, status, refunded, hosted URL, PDF URL). For a rep-quoted sponsor with no stored subscription id it looks the subscription up by `metadata['sponsor_id']` (Search API) and stores it. |
| `POST …/cancel {when: "period_end" \| "now"}` | `period_end` → `cancel_at_period_end=true`. `now` → cancel the subscription (`invoice_now=false`, `prorate=false`), **void its open invoices** (a late `invoice.paid` would otherwise resurrect it — billing-stripe gotcha), set the sponsor `Expired` immediately, `category_cache.clear()`. The client wraps it in `bustingAfter`. |
| `POST …/refund {invoice_id, amount_cents?}` | `POST /v1/refunds {payment_intent, amount}` for a paid invoice of THIS sponsor's subscription (ownership checked); full when `amount_cents` is absent; cannot exceed the refundable remainder. Does not cancel. |
| `POST …/discount {code_points: 0–15}` | New price by §4, `ensure_price_coupon`, `POST /v1/subscriptions/{id}` with `discounts[0][coupon]` (or cleared at list price); applies from the next invoice. **Refused (409 `legacy_price`) when the subscription's items are not the tier's current prices** (subscriptions still on the archived 2026-08-22 prices; a quote re-prices those). |
| `POST …/card-link {email: bool}` | Returns a signed link `{APP_BASE_URL}/api/billing/card/{token}` valid 7 days (HMAC over sponsor id + expiry with a key derived from `ADMIN_SECRET_KEY`; no table); `email: true` also sends it to the supplier's billing email through the existing mail path. Opening the link mints a Stripe **billing-portal** session limited to updating the card (`flow_data[type]=payment_method_update`, portal configuration ensured once per account and found by metadata) and redirects. Portal sessions are short-lived, which is why the emailed link is ours and not Stripe's. |

### Permissions
Admins and the owner act; viewers see the console read-only (matching today's quote PDFs); customers are refused by the staff wall. Client-side, `useAuth().isReadOnly` hides every action button, and the same fix is applied to `QuotePanel`.

## 9. Monthly billing, failures, and the background sweep

- Stripe renews and charges each subscription; retries on failure are Stripe's (the account's Smart Retries).
- **`billing_sweep` thread in the api process** (R5), started with the app, disabled under pytest by a setting (the `CATEGORY_CACHE_WARM` precedent), running **hourly** on the hour boundary (`seconds_until_hour` from `feed_import_daily`):
  1. Marks lapsed `open` intents `expired`.
  2. Drains conflict intents (`status='conflict' AND resolved_at IS NULL`): refund the session's first-invoice payment, cancel the subscription, set `resolved_at`, audit `sale_conflict_refunded`. Idempotent; a failure leaves the row unresolved and it shows in the Sales codes page's **Needs attention** strip (§11).
  3. **Dunning:** for every `sponsor_billing` row with `payment_failing_since` older than `BILLING_GRACE_DAYS` (default **14**, D4) whose subscription is still unpaid in Stripe: cancel it (void open invoices), set the sponsor `Expired`, `category_cache.clear()`, audit `dunning_cancelled`.
  - Survives an un-migrated schema (the `_is_missing_schema` pattern) and never kills the thread on an error.
- A rep sees **"Payment failing since {date} · cancels {date + 14 days}"** on the sponsor, from the first failed charge.

## 10. /join (customer-facing)

- **Stage 01:** the Gold and Platinum cards change their CTA from "Ask about…" to **Buy**; Silver unchanged. `?code=XXXX-XXXX` is read **once** from the URL in a `useState` initializer and stripped with a functional `setSearchParams(…, {replace: true})` (the category page's `welcome` pattern). A tier-locked code preselects its tier; a placement-locked code preselects its slot.
- **Stage 02 (Gold/Platinum):** an in-page slot picker (it SELECTS; it does not navigate like the Silver board rows), fed by `exclusive/slots`. Held slots show "Being purchased — try again after {time}". A failed fetch shows the error or desk fallback and **never reads as sold out**. When nothing is open, the existing "Ask the desk" application stays available.
- **Price summary** (server numbers only, from `POST /quote`): list price struck through, Founder price, the code's line when one is accepted, **You pay $X/month, tax included**, "12-month minimum · billed monthly". A `money()` formatter adds thousands separators (`monthlyLabel` does not).
- **Confirm → Stripe:** a new `join/ExclusiveCheckoutModal.tsx` mirroring `SilverCheckoutModal` (portal, scrim rules, Esc; stash written only after the URL returns, read once, 24 h TTL, own key `cc.exclusiveCheckout`), fields company / email / website, then "Continue to secure checkout". 409s map to "This slot was just taken" / "Being purchased — held until {time}".
- **Receipt:** `/join?welcome=gold|platinum` shows a receipt ticket: **PAYMENT RECEIVED**, never "LIVE" (the webhook may lag).
- **Copy updates:** the header contract comment (`index.tsx:22-36`), stage-02 line "arranged, never self-served", the `arrange` strings, the FAQ "Is buying through the desk more expensive?", and the applying label (which ignores the Founder price today).
- **Design pass** (D6): `frontend-design` plus a Figma component search (`figma-use`; the Figma connector needs a one-time owner sign-in) for the slot picker, price summary, and receipt. **Shader candidate, decided in that pass, never forced:** the Gold/Platinum price ticket, a metallic surface the Platinum/Gold boards already establish. Any motion gets a reduced-motion state; the standing perf rules apply (no per-path SVG filters, no animated `drop-shadow`, `whileHover` only behind `@media (hover: hover)`).
- Pure helpers (price formatting, code normalisation, slot grouping) live in a `.ts` file so vitest can test them.

## 11. Admin UI

- **Sales codes page** at `/admin/sales-codes` (+ `/new`): nav item after Sponsors in `CATALOG_LINKS` (staff-only, never in `customerLinks`), explicit `TITLE_MAP` entries (the fallback regex `\w+` does not match a hyphen), the Expenses list/form shape, a customer-mount self-gate, a copy-link button, and a rep select fed by `getSalesRepOptions()`. The sidebar height is re-measured (it must not scroll at 100% zoom on 1080p).
- **Needs attention** strip at the top of the Sales codes page: unresolved conflict intents (a buyer paid for a slot someone else won and the automatic refund has not gone through yet) and sponsors whose payments are failing, each linking to its sponsor. Hidden when empty.
- **Billing panel** on the sponsor edit page directly after `QuotePanel` (`sponsors/form/index.tsx:1271`), outside the `<form>`, hidden when the routes 404; the existing panel's heading "Stripe billing" becomes "Quotes" so the two read apart. Status strip, invoice list with PDF links, the four actions each behind a confirm dialog that states the money consequence ("Refund $2,100.00 to Acme?").
- Both go through the D6 design pass.

## 12. Rollout

1. **Local, test mode:** `STRIPE_SECRET_KEY` = the sandbox key and a `stripe listen --forward-to` secret, both in one recreate; `APP_BASE_URL` is added to the compose allowlist (default mirrors `https://circuitcenter.ai`) so return URLs come back to localhost.
2. **Sandbox setup script** (`scripts/stripe_sandbox_setup.py`, refuses live keys): creates the Gold and Platinum inclusive prices with the live lookup keys and tax codes, and the portal configuration.
3. **Rehearsal checklist** (recorded in the ledger): each tier with and without a code; a held slot seen by a second browser; a forced double-payment (refund arrives); every console action; dunning via a Stripe **test clock** advanced 15 days.
4. **Owner playtest locally**, then explicit go-ahead to deploy (memory `feedback_phase_gated_builds`).
5. **Deploy:** reporting pulled before and after; api built on the box as today; **frontend built locally and shipped by `docker save | ssh docker load`**, which becomes `deploy.sh`'s frontend path, building from a clean worktree of `origin/master` (D7).
6. **Live Stripe steps, each with the owner's go-ahead:** update the webhook endpoint's events (script, §7) and ensure the live portal configuration. Then probe: unsigned POST to `/api/stripe/webhook` → 400; `GET /api/checkout/exclusive/slots?tier=gold` → 200.

## 13. Testing

- **pytest:** the FakeStripe transport (which filters on query params) is extended for checkout sessions, subscriptions, invoices, refunds, the portal and search, rather than monkeypatching. Covered: the price table (§4 values); code usability and locks, with the uniform public message; the hold (the partial index rejects a second live intent; a lapsed intent frees the slot); every webhook row in §7, including the conflict path queueing a refund and the legacy Silver path; every console action including the ownership check on refunds and the `legacy_price` refusal; the sweep's three duties; the route-gate and compose-passthrough guards; the scopes mirror; and a cross-language guard for Founder literals.
- **PG harness** (`tests/pg_harness.py`): migration 057's real `upgrade()` and the partial unique index on Postgres.
- **vitest:** the /join pure helpers; the SCSS source witnesses for new rules (`css:false` makes class assertions vacuous).
- **Gates:** `npx tsc -b`, `npx eslint --ext .ts,.tsx src/`, `npm test`, `pytest`.

## 14. Out of scope (named so they are not mistaken for gaps)

- Keyword placements for Gold (multi-occupant; no slot to hold).
- Customer self-service billing (the card-update link is the only customer-facing billing surface).
- Changing a live sponsor's tier or placement from the console (a new sale or quote does that).
- `--reseed` destroying Stripe-sold sponsor rows: an existing risk of the reseed path, recorded here rather than solved (the new tables deliberately survive it).
- The dashboard's stale `_TIER_DEFAULT_AMOUNT` placeholders.
- Pinning `Stripe-Version` (the code reads both invoice shapes today; pinning mid-flight changes payload shapes).
