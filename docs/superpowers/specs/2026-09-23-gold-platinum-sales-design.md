# Gold & Platinum sales on /join — design (v2)

- **Date:** 2026-09-23 · **Status:** APPROVED by owner 14:36 ("just get it done") with amendments D8–D10; **v2** folds the max-effort review (`.superpowers/sdd/2026-09-23-gold-platinum-sales/review/{lines-up,stripe-api}.md`; ledger in §16)
- **Branch:** `updates` · alembic head `056` → this work adds `057`
- **Code map:** `.superpowers/sdd/2026-09-23-gold-platinum-sales/facts/*.md` (every claim anchored `path:line`)

## 1. Intent

Sales reps must be able to sell **Gold** and **Platinum** sponsorships **now**, on `https://circuitcenter.ai/join`, and give discounts, without ever opening the Stripe dashboard. Every sale is billed monthly by Stripe, recorded in our database, and charged automatically each month; a sponsor whose payments stop is released after two weeks.

**Success looks like:**
1. A customer can buy an open Gold (subcategory) or Platinum (top-level category) slot on /join and pay on Stripe's hosted page; the board goes live within seconds of payment.
2. A rep can create a discount code in /admin, send the customer a `/join?code=…` link, and see the sale credited to them.
3. From a sponsor's admin page a rep can see payments and invoices, cancel (and undo a scheduled cancel), refund, change the discount, retry a payment, and hand the customer a card-update link — no Stripe access.
4. Nothing charges a price the server did not compute; no path discounts more than 30% off list; two buyers never both keep a payment for one exclusive slot (the loser is cancelled and refunded automatically, and any failure of that is visible and retryable in the app).

## 2. Owner decisions (chat, 2026-09-23)

| # | Decision |
|---|---|
| D1 | **Both** channels: self-serve for open slots **and** rep-generated codes. Everything that would otherwise be done in Stripe is doable in the app; reps never see Stripe. |
| D2 | **Discount cap: 30% off list, total** ("they can only add another 15% from the base"). |
| D3 | Reps get the console actions now: payments/invoices view, cancel, refund, change discount, card-update link. |
| D4 | **Failed payments:** retries for two weeks, then the sponsorship expires and the slot reopens. |
| D5 | The Founder price is charged, **forever**; the customer always gets the better deal. |
| D6 | UI design choices first search trendy components via the Figma skills; a shader only where one arises organically. |
| D7 | No deploy builds the frontend on the prod box again (2026-09-23 outage). |
| D8 | A named **"Founder's Deal"** for every tier — Silver $210, Gold $2,100, Platinum $8,500 — charged, and shown by that name on /join, the receipt and Stripe invoices. |
| D9 | **All discounts come off the base (list) price, up to 30% off in total.** |
| D10 | Self-serve is expected (salesmen guide customers); the owner re-credits a self-serve sale through the sponsor's existing **Sold by** field when needed. |

## 3. Rulings

Each names why and what it costs if wrong. Findings `LU-Fn` / `SA-Fn` refer to the review files.

- **R1 — `sold_by` keeps today's meaning.** Self-serve without a code → `settings.SELF_SERVE_ONBOARDING_REP` (currently "Daniel"); a code sale → the code's rep; the **channel** (`self_serve` / `rep_code` / `quote`) is its own column. A literal "Self-serve" would render as a fake rep on the dashboard. D10 confirms the owner re-credits by hand.
- **R2 — The slot hold is a `checkout_intents` row, never a sponsor row** (any Active/NULL sponsor row renders on the public board). One live intent per exclusive slot is a partial unique index.
- **R3 — Billing state lives beside the sponsor** (`sponsor_billing`, `sponsor_payments`); writing it onto `sponsors` would trip the webhook's stale-event gate (`stripe_webhook.py:391-404`).
- **R4 — A staff-only `billing_audit` table**; `activity_events` has no actor and is customer-readable.
- **R5 — The sweep is a thread inside the api process** (like the category-cache warmer): no new container on the memory-starved box, and it can clear the in-process category cache.
- **R6 — Viewers are refused billing reads** (LU-F13). The viewer role is an outsider; card details, invoice links and live discount codes are customer money and bearer discounts. A new `require_billing_reader` (403 `no_billing_access`) guards the billing GET, the sales-codes GET, **and the existing quote list and PDF reads**. The retired demo account needs nothing (`test_demo_is_retired.py`).
- **R7 — A rep code may be bound to an existing company** (owner-confirmed), **with guards** (LU-F12, SA-F13): a bound code requires an `email_lock`; creating or redeeming it is refused (409 `already_sponsor`) while that company holds a non-Expired row on the target category (upgrades on the same category go through the desk); only an Expired row is reused, and its old subscription can no longer act on it (R13's foreign-subscription rule); buyer-typed fields never overwrite the bound company; checkout uses that company's Stripe customer (`customer=` + `customer_update[address]=auto`, `customer_update[name]=auto`) instead of creating another.
- **R8 — Codes apply to Gold and Platinum only in this release.** Silver keeps its category-page checkout and is now charged its Founder's Deal ($210) instead of $250; it gets no code field.
- **R9 — Existing bugs fixed on the way:** the webhook never clears the category cache (boards lag ≤ 60 min); a missing `amount_total` passes the amount gate; a tier-matrix trigger error (`InternalError`) escapes as a 500; coupon `applies_to` uses hard-coded LIVE product ids; QuotePanel shows write buttons to viewers.
- **R10 — Checkout is card-only** (`payment_method_types[]=card`) for Silver, Gold and Platinum (LU-F8). ACH completes days later as an async event nothing handles; a buyer would be charged with no board. ACH stays available through quotes (emailed invoices).
- **R11 — No new webhook event subscriptions** (LU-F23, SA-F2). Holds lapse by their own `expires_at`; refunds and period ends are read live from Stripe by the console; console actions write their own mirror rows. The live webhook endpoint is not touched, which removes a live-Stripe change from the rollout.
- **R12 — Quotes are priced by the same rule** (LU-F2, D2, D9). The quote route takes `code_points` 0–15 and prices through `sales_pricing`; `QUOTE_LADDER` shrinks to `{tier: [list]}` (the list-price single home, `test_ladder_first_entry_is_the_list_price` still holds). Subscriptions already on old ladder coupons are untouched.
- **R13 — One subscription per sponsor row** (LU-F3). The new checkout path stamps `sponsors.stripe_subscription_id` as the legacy path does. Once a sponsor has a stored subscription id, any event or console action for a different subscription naming that `sponsor_id` is ignored (outcome `foreign_subscription`). The console's lookup for a rep-quoted row with no stored id stores a match only when exactly one non-canceled subscription carries its `sponsor_id`; otherwise it shows "Several subscriptions — resolve" (409 `ambiguous_subscription`).
- **R14 — The card lives on the customer** (SA-F1, LU-F10). Checkout saves the card as the *subscription's* default, which outranks the customer's, so a portal card update would never be charged. At activation (and again whenever a card link is opened, which covers legacy subscriptions) the card is moved: customer `invoice_settings.default_payment_method` = the subscription's, then the subscription's field is cleared (`default_payment_method=""`).
- **R15 — A billed sponsor cannot be deleted or expired around its subscription** (LU-F14e). Sponsor DELETE, supplier DELETE, and a PATCH to `status=Expired` answer 409 `billing_active` ("Cancel it under Billing first") while the sponsor has a stored, non-terminal subscription. Paused stays allowed.
- **R16 — "Taken" for exclusive self-serve = any same-category, same-tier row that is not `Expired`** (Active, NULL or Paused) (LU-F7), defined once beside `is_single_slot` in `models/sponsor.py`. A paused sponsor is still paying.
- **R17 — No `FOUNDER_PRICING_ENABLED` flag** (LU-F16): D5 says forever; a flag could silently raise a Founder customer on the next discount change.

## 4. Pricing — one rule, one home

`api/app/services/sales_pricing.py` is the **single home**; nothing else computes a price, and the browser only displays numbers the server returned.

```
LIST          = QUOTE_LADDER[tier][0]          # 250 / 2,500 / 10,000
FOUNDER       = {silver: 210, gold: 2100, platinum: 8500}   # the Founder's Deal (D8)
FLOOR         = LIST * 70 // 100               # 175 / 1,750 / 7,000  (D2, D9)
MAX_CODE_PTS  = 15

price(tier, code_pts) = max(FLOOR, FOUNDER - ceil(code_pts * LIST / 100))   # whole dollars, code_pts 0..15
```

- Worked values (pinned by tests): Silver 0 → **210**; Gold 0 → **2,100**; Gold 10 → **1,850**; Gold 15 → **1,750** (floor); Platinum 10 → **7,500**; Platinum 15 → **7,000**.
- Used by: `/join` quote + checkout, Silver checkout, **rep quotes** (R12), and the console's discount change.
- **One `amount_off` coupon, `duration: forever`**, id `{TIER}-AT-{price}`; never a percentage coupon, never two discounts on one subscription (billing-stripe gotcha: percentages multiply and move the 90/10 tax split). Checkout-minted coupons are named `"{Tier} Founder's Deal — ${price}/mo"`; an id that already exists keeps its name (names are cosmetic, unverified).
- `stripe_quotes._ensure_ladder_coupon` becomes public `ensure_price_coupon(client, tier, target_usd, product_ids)`: `0 < target < list` guard; product ids **from the resolved prices** (`GET /v1/prices` rows carry `product`) instead of `_TIER_PRODUCTS` (which is deleted); reuse verifies `amount_off`, `duration == forever`, `currency == usd`, `valid is true`, and `set(applies_to.products)` via `GET /v1/coupons/{id}?expand[]=applies_to` (SA-F8).
- The Join page's `JOIN_TIERS.fd` literals stay for the card display; a cross-language test pins them to `FOUNDER`.

## 5. Stripe API version and object shapes (SA-F2, SA-F6, LU-F1)

- **Task 0 (before any code):** read, without writing, the live and sandbox accounts' default API versions and the live webhook endpoint's `api_version` (`GET /v1/webhook_endpoints/we_1U4WbrDqTxm052QNt6qH7IUn`); record them in the ledger. Require ≥ `2026-01-28.clover` (the release that reinstated `amount_off` + `forever` coupons on subscriptions and Checkout). If the endpoint version and the account default differ, stop and ask the owner.
- `make_client` pins `Stripe-Version` to the recorded account default, so REST shapes can never change under the code. Webhook payloads follow the endpoint's version; the parsers keep today's dual-shape posture.
- Field paths used everywhere (FakeStripe emits exactly these shapes, including invoices with **no** `payment_intent`/`charge` keys):

| need | path |
|---|---|
| an invoice's PaymentIntent | `GET /v1/invoice_payments?invoice=<in_>&status=paid` (via `params=`) → `data[].payment.payment_intent` (require `payment.type == "payment_intent"`, else 409 `unsupported_payment`) |
| a subscription's first invoice | `GET /v1/subscriptions/{id}` → `latest_invoice` (never `session.invoice`) |
| period end | `max(item.current_period_end for item in sub.items.data)` |
| scheduled cancel | `cancel_at_period_end` **or** `cancel_at is not None` (flexible billing mode) |
| next charge amount | `POST /v1/invoices/create_preview {subscription}` |
| clear a subscription discount | the literal form field `discounts=` (empty string); an empty list sends nothing (SA-F5) |

## 6. Data model — migration `057_gold_platinum_sales`

New tables are FK-free toward `sponsors`/`suppliers`/`users` except `sponsor_billing` (1:1, `ON DELETE CASCADE`). Actors are username strings.

### `sales_codes`
`id` · `code` String(16) UNIQUE (Crockford base32, no I/L/O/U, 8 chars, shown `XXXX-XXXX`, case-insensitive) · `code_points` SmallInteger CHECK 1–15 · `tier` NULL (`gold`/`platinum`/NULL = either) · `category_id` NULL (placement lock, validated against the tier matrix) · `supplier_id` NULL (R7 binding; requires `email_lock`) · `email_lock` String(200) NULL · `max_uses` SmallInteger default 1 CHECK ≥ 1 · `uses` SmallInteger · `expires_at` default now + 14 days · `rep` String(120) (defaults to the creator) · `created_by` · `note` String(500) NULL · `active` Boolean · `created_at`.

Usable = `active` AND `expires_at > now` AND `uses + open intents using it < max_uses` AND the request matches its locks. The count runs after `SELECT … FOR UPDATE` on the code row inside the intent transaction (LU-F19). Every public "not usable" answer is the same sentence: "This code isn't valid for this purchase."

### `checkout_intents` (every Checkout Session we mint, all tiers)
`id` · `stripe_session_id` UNIQUE NULL · `release_token_hash` NULL · `tier` · `category_id` NULL · `keyword` NULL · `sales_code_id` NULL · `supplier_id` NULL (R7) · `list_usd` · `founder_usd` · `price_usd` · `channel` · `sold_by` · `company_name` · `email` · `website` · `client_ip_hash` · `status` `open|completed|expired|released|conflict` · `conflict_reason` NULL · `expires_at` · `created_at` · `resolved_at` NULL.

- Hold: partial unique index `uq_live_exclusive_intent ON (category_id) WHERE status='open' AND tier IN ('gold','platinum')`, declared on the model (`postgresql_where` + `sqlite_where`).
- The same transaction first marks `open` intents with `expires_at < now()` as `expired`.
- Stripe `expires_at` = now + **35 min**; the hold `expires_at` = that + 10 min (SA-F14).
- The conflict queue **is** `status='conflict' AND resolved_at IS NULL`.

### `sponsor_billing` (1:1)
`sponsor_id` PK FK→sponsors CASCADE · `stripe_customer_id` · `stripe_subscription_id` · `collection_method` (`charge_automatically` | `send_invoice`) · `channel` · `list_usd` · `founder_usd` NULL · `price_usd` · `sales_code_id` NULL · `failing_since` DateTime tz NULL · `card_link_version` Integer default 0 · `post_activation_done_at` NULL · `updated_at`.

- **Backfill in 057** (LU-F9b): one row for every sponsor that already has `stripe_subscription_id` (channel `self_serve`, collection `charge_automatically`, prices from `amount`). Every webhook handler that resolves a subscription upserts the row.

### `sponsor_payments` (mirror, keyed by invoice)
`id` · `stripe_invoice_id` UNIQUE · `stripe_subscription_id` · `sponsor_id` NULL (resolved lazily, SA-F7) · `stripe_payment_intent_id` NULL (filled when first needed) · `amount_due_cents` · `amount_paid_cents` · `amount_refunded_cents` · `status` `paid|failed|refunded|partially_refunded` · `invoice_created_at` · `paid_at` NULL · `hosted_invoice_url` NULL · `updated_at`.

### `billing_audit` (staff-only, append-only)
`id` · `created_at` · `actor` (`username`, `system:webhook`, `system:sweep`) · `sponsor_id` NULL · `sales_code_id` NULL · `intent_id` NULL · `action` String(40) · `amount_cents` NULL · `detail` String(500).
Actions: `code_created`, `code_updated`, `checkout_started`, `hold_released`, `sale_activated`, `sale_conflict`, `conflict_resolved`, `cancel_period_end`, `cancel_resumed`, `cancel_now`, `refund`, `discount_changed`, `payment_retried`, `card_link_created`, `card_updated`, `dunning_cancelled`, `quote_created`.

### Existing tables and guards
- `sponsors`: no new columns; `amount` for new sales = the charged monthly price.
- `data_versions.SCOPES`: new scope `"sales": ("sales_codes", "checkout_intents")`; `"money"` += `sponsor_payments`, `billing_audit`; `"sponsors"` += `sponsor_billing`. TS `DataScope` gains `'sales'` in the same change.
- `test_leads_schema.py`: `sponsor_billing` joins `ACCEPTED_LOSSES` (it is in the reseed cascade) (LU-F17).

## 7. Public API (`/api/checkout`; every route 404s when `STRIPE_SECRET_KEY` is unset)

| route | purpose |
|---|---|
| `GET /exclusive/slots?tier=gold\|platinum` | Open and held slots (R16 defines taken; taken slots omitted). Rows: `category_id, name, parent_name, path, state ("open"\|"held"), held_until?`. Also `list_usd`, `founder_usd`. |
| `POST /quote {tier, category_id?, code?, email?}` | `list_usd, founder_usd, price_usd, savings_usd, code: {accepted, points} \| null, slot_state`. `email_lock` is evaluated only when `email` is sent (LU-F18). No side effects. |
| `POST /exclusive {tier, category_id, code?, company_name, email, website?}` | Re-validates everything; **commits** the intent (the hold); mints the session with `Idempotency-Key: checkout:{intent_id}`; on any Stripe error marks the intent `expired` before answering (LU-F6, SA-F14). Returns `{url, release_token}`. 409 `slot_taken` / `slot_held` (+`held_until`) / `already_sponsor`; 429 `hold_limit`. |
| `POST /exclusive/release {release_token}` | The buyer's own "back" path: expires the Stripe session (`POST /v1/checkout/sessions/{id}/expire`), marks the intent `released`. |
| `GET /api/billing/card/{token}` | Card-update redirect (§9). |
| `GET /api/billing/card/{token}/done` | Portal return: pays any open invoice once, then redirects to `/join?card=updated`. |

- **Anti-squatting** (LU-F6): at most one open exclusive intent per client IP and per normalised email; after two lapsed-unpaid holds on the same slot from the same IP or email within 24 h, that pair gets 429 `hold_limit` for the rest of the 24 h. Released holds never count. Checkout POSTs stay 8 / 10 min per IP; `/quote` 30 / 10 min.
- **Silver contract** (LU-F11): `GET /checkout/silver` and `/silver/boards` keep `monthly_total` = LIST (for cached old bundles) and **add** `price_usd` (charged, $210) and `founder_usd`; the Join card and `SilverCheckoutModal` render `price_usd`; `founderMonthly` is deleted. Silver sessions are recorded as intents (non-blocking; the 5-per-board rule is unchanged).
- **Session contract** (all tiers): `mode=subscription`, both tier prices, `discounts=[{coupon}]` when price < list, `payment_method_types[]=card` (R10), `automatic_tax.enabled`, `billing_address_collection=required`, `customer_email` = the entered email (R7-bound sales use `customer=` instead), `expires_at`, and metadata on session **and** `subscription_data`: `managed_by=circuits-com`, `intent_id`, `tier`. Gold/Platinum `success_url` `{APP_BASE_URL}/join?welcome={tier}`, `cancel_url` `{APP_BASE_URL}/join?released=1`.
- All new public routes are added deliberately to `PUBLIC_ROUTES` in `test_every_route_is_gated.py`.

## 8. Webhook (`services/stripe_webhook.py`) — same events as today (R11)

Contract kept: every verified event gets a 200 and a distinct outcome string; lifecycle events write only `sponsors.status`; creation on `checkout.session.completed` is the sole exception; every existing outcome string and test stays.

**Mirroring runs BEFORE the status gates** (LU-F4). For every `invoice.*` event with a subscription: upsert `sponsor_payments` by invoice id; resolve the sponsor through the stored subscription id → metadata `sponsor_id` (R13 rules) → subscription metadata `intent_id` → intent → sponsor; upsert `sponsor_billing`; set `failing_since` on `invoice.payment_failed` (if unset), clear it on `invoice.paid`. None of this writes the sponsor row. Only then do the existing status gates run (`no_sponsor_id`, `stale_event`, `left_paused`, `unchanged`, `slot_conflict`).

`checkout.session.completed`, **new path** (metadata carries `intent_id`):
1. Load the intent by `metadata.intent_id`; the stored session id must match or be NULL (then store it). Short-circuit `completed` → `duplicate_checkout`, `conflict` → `conflict_already_queued`.
2. Gates, in order: paid · subscription present · `amount_total` present **and** equal to `intent.price_usd × 100` · category exists and the tier matrix allows it (pre-checked, so the trigger never fires) · **slot free by R16** · R7 guard. The intent may be `open` **or** `expired` (a deploy's 502 window can push Stripe's retry past the hold); it is honoured whenever the slot is still free (LU-F5c).
3. **Any gate failure after payment** sets the intent `conflict` with `conflict_reason` (`amount_mismatch`, `slot_taken`, `matrix`, `category_missing`, `already_sponsor`, `bad_metadata`) and audits `sale_conflict`; outcome `checkout_conflict_refunding` (LU-F5a).
4. Success: create or reuse the supplier (fresh; or the bound company, R7), create the sponsor (`Active`, `amount` = price, `sold_by`, **`stripe_subscription_id`**), upsert `sponsor_billing`, attach any `sponsor_payments` rows already mirrored for this subscription, count the code's use, mark the intent `completed`, audit `sale_activated`, **`category_cache.clear()`**.
5. The route then runs a FastAPI background task for Stripe follow-ups; the sweep retries anything left (`post_activation_done_at IS NULL` or unresolved conflicts):
   - after activation: R14 card move; stamp `metadata[supplier_id]` on the Stripe customer; mirror `latest_invoice` (covers the first invoice's `invoice.paid` arriving before the sponsor existed, SA-F7);
   - after a conflict: the conflict resolution in §10.

**Legacy path** (metadata `self_serve=silver`, no `intent_id`): unchanged, gate pinned to `QUOTE_LADDER["silver"][0]` ($250), except that a missing `amount_total` now fails. Sessions minted before the deploy keep completing.

`customer.subscription.deleted`: unchanged → `Expired`, **plus** `category_cache.clear()` and a queued void of the subscription's open invoices (a canceled subscription's open invoice can still be paid and resurrect the row; SA-F3).

Around every commit, `IntegrityError` **and** `InternalError` are caught (roll back, still ack).

## 9. Rep console (admin; no Stripe access)

Routers carry `dependencies=[Depends(require_staff)]` (viewers get 403 `read_only` on writes); billing and code reads add `require_billing_reader` (R6); every route 404s when Stripe is unconfigured; Stripe ids are regex-validated before path interpolation; query strings only via `params=`; every action writes `billing_audit`; `detail`s are strings and new machine codes get `CODE_MESSAGES` entries.

**Idempotency** (LU-F22, SA-F9): each confirm dialog mints a UUID once and sends it as `Idempotency-Key`; the api forwards it to Stripe, so a double-click or retry cannot double-refund. The sweep uses `conflict-cancel:{intent}` / `conflict-refund:{intent}:{invoice}` and reads Stripe state before each step, treating "already canceled" and `charge_already_refunded` as success (Stripe prunes keys after 24 h).

### Sales codes — `/api/admin/sales-codes`
`GET /` (codes, uses, rep, status, the sales each produced) · `POST /` (points 1–15, tier, optional placement / company+email / email locks, max uses, expiry, note; returns the code and a ready link `/join?code=X&tier=…&slot=…` built from its own locks, LU-F18) · `PATCH /{id}` (switch off, extend expiry, edit note). No delete.

### Billing — `/api/admin/sponsors/{id}/billing`
| route | behaviour |
|---|---|
| `GET` | Live from Stripe plus our mirror: subscription status, scheduled cancel (§5), period end, next charge amount (`create_preview`), card brand/last4/expiry (customer default, R14), current price and discount, list and Founder's Deal price, channel, sold_by, code, `failing_since` and the date the sweep will cancel, invoices (number, date, amount, paid, refunded, status, hosted URL, PDF URL). Rep-quoted rows with no stored id: R13 lookup (Search query `metadata['sponsor_id']:'<id>' AND -status:'canceled'`). |
| `POST …/cancel {when: "period_end" \| "now" \| "resume"}` | `period_end` → `cancel_at_period_end=true`. `resume` → `cancel_at_period_end=false` (and `cancel_at=""` when set). `now` → cancel (`invoice_now=false`, `prorate=false`), void every open invoice (`GET /v1/invoices?subscription=…&status=open`), sponsor `Expired`, `category_cache.clear()`; the client wraps it in `bustingAfter`. |
| `POST …/refund {invoice_id, amount_cents?}` | The invoice must belong to THIS sponsor's subscription; PaymentIntent by §5; `POST /v1/refunds {payment_intent, amount}` (full when absent, never above the remainder); mirror row updated. Does not cancel. |
| `POST …/discount {code_points: 0–15}` | Price by §4; `ensure_price_coupon`; `POST /v1/subscriptions/{id}` with `discounts[0][coupon]` (or `discounts=` to clear at list); re-read `sub.discounts` and 502 if it is not the expected coupon (SA-F5). **409 `legacy_price`** when the subscription's items are not the tier's current prices. Applies from the next invoice. |
| `POST …/retry-payment` | `POST /v1/invoices/{id}/pay` on the oldest open invoice (LU-F14d). |
| `POST …/card-link` | Bumps `card_link_version`; returns `{url, expires_at}`: `{APP_BASE_URL}/api/billing/card/{token}`, 7 days, HMAC over (sponsor id, version, expiry) with a key derived from `ADMIN_SECRET_KEY` — a new link revokes the old one. The UI offers **Copy** and an **Open in email** (`mailto:` prefilled to the supplier's billing email). **Hidden for `send_invoice` subscriptions**, which show "Invoice due {date}" and the hosted invoice link instead (SA-F4). |

**Card link open** (`GET /api/billing/card/{token}`): verify token and version → R14 card move (idempotent, covers legacy subscriptions) → ensure the portal configuration (created once per account: `features[payment_method_update][enabled]=true`, every other feature disabled, `metadata[managed_by]=circuits-com`; found by paging `GET /v1/billing_portal/configurations`) → portal session with `flow_data[type]=payment_method_update` and `flow_data[after_completion][type]=redirect` to `/api/billing/card/{token}/done` → 302. `…/done` pays any open invoice once, audits `card_updated`, redirects to `/join?card=updated`.

### Needs-attention actions (LU-F14a/b)
`POST /api/admin/checkout-intents/{id}/resolve` (retry cancel + refund of a conflict) and `POST /api/admin/checkout-intents/{id}/release` (release a live hold).

### Guards on existing admin writes (R15)
Sponsor DELETE, supplier DELETE and sponsor PATCH to `Expired` → 409 `billing_active` while a stored subscription is non-terminal.

## 10. The sweep (thread in the api process, R5)

Hourly on the hour boundary (the `sync_costs.py:307` sleep, LU-F20); disabled under pytest (the `CATEGORY_CACHE_WARM` precedent); `run_sweep(now=…)` has an injectable clock and a CLI lever `python -m app.jobs.billing_sweep --once [--now ISO]` for rehearsal; survives an un-migrated schema (`_is_missing_schema`) and never dies on an error.

1. Lapsed `open` intents → `expired`.
2. Post-activation follow-ups not done (§8.5).
3. **Conflicts** (`status='conflict' AND resolved_at IS NULL`), in this order (LU-F5b): cancel the subscription (`invoice_now=false`, `prorate=false`) → refund **every** paid invoice of it → set `resolved_at`, audit `conflict_resolved`. Failures stay listed in Needs attention.
4. **Dunning** (D4; SA-F3, SA-F4, LU-F9):
   - `charge_automatically`: `failing_since` older than `BILLING_GRACE_DAYS` (**14**) and the live subscription status is `past_due` or `unpaid` → cancel, void open invoices, sponsor `Expired`, `category_cache.clear()`, audit `dunning_cancelled`.
   - `send_invoice` (rep quotes): the oldest open invoice's `due_date` is more than 14 days past → the same.
   - Live status `canceled` (Stripe or anyone else canceled) → void open invoices; the webhook already expired the row.
5. Queued open-invoice voids from `customer.subscription.deleted`.

**Required account setting (owner, sandbox and live; D1's one Dashboard-only item):** Billing → Revenue recovery → Smart Retries over **3 weeks**, ending in **"Leave the subscription past-due"**, so our 14-day sweep is the only thing that ends a sponsorship. The rehearsal reads it back.

A rep sees **"Payment failing since {date} · cancels {date + 14 days}"** from the first failed charge.

## 11. /join

- **Stage 01:** Gold and Platinum CTAs become **Buy**; Silver unchanged. `?code=`, `?tier=`, `?slot=`, `?welcome=`, `?released=`, `?card=` are read once in a `useState` initializer and stripped with a functional `setSearchParams(…, {replace: true})`. Before stripping, confirm the page-view tracker records the pathname only; if it records the query, exclude `code`.
- **Stage 02 (Gold/Platinum):** an in-page slot picker that SELECTS (it does not navigate like the Silver rows). Held slots read "Being purchased — try again after {time}". A failed fetch shows the error and the desk fallback and **never reads as sold out**. With nothing open, "Ask the desk" stays.
- **Price summary** (server numbers only): list struck through, the **Founder's Deal** line, the code line when accepted, **You pay $X/month, tax included**, "12-month minimum · billed monthly". A `money()` formatter adds thousands separators.
- **Confirm → Stripe:** `join/ExclusiveCheckoutModal.tsx` mirroring `SilverCheckoutModal` (portal, scrim rules, Esc; stash written only after the URL returns, read once, 24 h TTL, key `cc.exclusiveCheckout`, which also holds the `release_token`). 409s map to "This slot was just taken" / "Being purchased — held until {time}" / "This company already sponsors this category — ask your rep"; 429 `hold_limit` → "You already have a checkout open".
- **Back from Stripe** (`?released=1`): post the stashed `release_token`, then show the slot as open again.
- **Receipt** (`?welcome=gold|platinum`): **PAYMENT RECEIVED**, never "LIVE". **`?card=updated`**: a small confirmation.
- **Copy updates:** the header contract comment (`index.tsx:22-36`), "arranged, never self-served", the `arrange` strings, the FAQ "Is buying through the desk more expensive?" (quotes now price identically), and the applying label.
- **Design pass** (D6): `frontend-design` plus a Figma component search (`figma-use`, after the owner's one-time Figma sign-in) for the slot picker, price summary and receipt. Shader candidate, decided in that pass and never forced: the Gold/Platinum price ticket. Reduced-motion states and the standing perf rules apply.
- Pure helpers (money formatting, code normalisation, slot grouping) live in a `.ts` file for vitest.

## 12. Admin UI

- **Sales codes page** `/admin/sales-codes` (+ `/new`): nav item after Sponsors in `CATALOG_LINKS` (staff-only), explicit `TITLE_MAP` entries, Expenses list/form shape, customer-mount self-gate, Copy link, rep select from `getSalesRepOptions()`, the blocked state for viewers. Sidebar re-measured (no scroll at 100% zoom on 1080p).
- **Needs attention** strip at the top of that page: unresolved conflicts (with Retry), live holds (with Release), failing payments (linking to the sponsor). Hidden when empty.
- **Billing panel** on the sponsor edit page after `QuotePanel` (`sponsors/form/index.tsx:1271`), outside the `<form>`, hidden on 404, blocked state for viewers; status strip; invoice list with PDF links; actions behind confirm dialogs that state the money ("Refund $2,100.00 to Acme?"). `QuotePanel`'s heading becomes "Quotes", its select lists code points with the server's price (R12), and both panels hide write buttons for viewers.
- Both go through the D6 design pass.

## 13. Rollout

1. **Task 0** (§5): record API versions; verify the local `.env` and prod `/opt/circuits-com/.env` for an `APP_BASE_URL` key (names only) before allowlisting it (LU-F21).
2. **Local test mode:** sandbox key + `stripe listen --forward-to` secret passed on the recreate command line (never `.env`); `APP_BASE_URL=http://localhost` likewise.
3. **Sandbox setup script** `scripts/stripe_sandbox_setup.py` (refuses live keys): Gold and Platinum inclusive prices with the live lookup keys and tax codes; the portal configuration.
4. **Owner steps:** the Smart Retries setting in sandbox and live (§10); the one-time Figma sign-in for the design pass.
5. **Rehearsal checklist** (ledger): each tier with and without a code; R7 bound code; a second browser seeing a held slot; back-from-Stripe release; a forced double payment ending refunded; every console action (cancel/resume/now, refund full+partial, discount change and clear, retry payment, card link → portal → `done`); dunning by forcing a failed renewal (`pm_card_chargeCustomerFail`, `billing_cycle_anchor=now`) then `billing_sweep --once --now <+15 days>`.
6. **Owner playtest locally**, then the deploy go-ahead.
7. **Deploy:** reporting pulled before and after; `deploy.sh` never builds the frontend on the box in ANY path (LU-F15) — every path builds the image locally from a clean worktree of `origin/master`, ships it with `docker save | ssh … docker load`, then `up -d --no-build`; a guard test asserts no `COMPOSE_CMD build` line names `frontend`. The api still builds on the box.
8. **Probes after deploy:** unsigned POST `/api/stripe/webhook` → 400; `GET /api/checkout/exclusive/slots?tier=gold` → 200.
9. **Reseed guard** (LU-F17): `confirm_reseed` prints the count of Stripe-billed sponsors that would lose their board while still being charged, and refuses unless it is 0 or the operator types the number.

## 14. Testing

- **pytest**, FakeStripe extended (it filters on query params and emits §5's shapes): the §4 price table and the quote route's new contract; code usability, locks, `FOR UPDATE`, the uniform message; the hold index, lazy expiry, release, anti-squatting; every §8 branch including mirror-before-gates, `open`/`expired` honouring, each conflict reason, R13 `foreign_subscription`, R16 Paused-is-taken, and the legacy Silver path; every console action including refund ownership, `legacy_price`, discount clear on the wire, card-link revocation; R15 guards; the sweep's five duties with an injected clock; route-gate, compose-passthrough, data-versions, ACCEPTED_LOSSES and the deploy guard; the Founder cross-language guard.
- **PG harness:** migration 057's real `upgrade()` (including the backfill) and the partial unique index.
- **vitest:** /join pure helpers; SCSS source witnesses for new rules.
- **Gates:** `npx tsc -b`, `npx eslint --ext .ts,.tsx src/`, `npm test`, `pytest`.

## 15. Out of scope

- Keyword placements for Gold; changing a live sponsor's tier or placement on the same category (upgrades go through the desk: expire the old sponsorship first).
- Customer self-service billing beyond the card-update link; emailing the card link from our server (the rep's own mail client is used).
- New webhook event subscriptions (R11); async payment methods in Checkout (R10).
- `--reseed` destroying Stripe-sold sponsor rows beyond the §13.9 guard; the dashboard's stale `_TIER_DEFAULT_AMOUNT` placeholders.

## 16. Review ledger (v1 → v2)

| finding | disposition |
|---|---|
| LU-F1, SA-F2, SA-F6, SA-F8 | §5 (version pin, field paths), §4 coupon reuse |
| LU-F2 | R12 |
| LU-F3 | R13 |
| LU-F4, SA-F7 | §8 mirror-before-gates, lazy sponsor resolution, `latest_invoice` follow-up |
| LU-F5 | §8 conflict reasons and `open`/`expired` honouring; §10.3 order |
| LU-F6, SA-F14 | §7 commit-then-mint, release route, anti-squatting, 35 + 10 min |
| LU-F7 | R16 |
| LU-F8 | R10 |
| LU-F9, SA-F3, SA-F4 | §6 backfill, §10.4, owner retry setting, send_invoice handling |
| LU-F10, SA-F1, SA-F11 | R14, card-link open/`done` flow, pinned portal configuration |
| LU-F11 | §7 Silver contract |
| LU-F12, SA-F13 | R7 guards |
| LU-F13 | R6 |
| LU-F14 | §9 resume, retry-payment, Needs-attention actions, R15 |
| LU-F15 | §13.7 |
| LU-F16 | R17 |
| LU-F17 | §6 ACCEPTED_LOSSES, §13.9 |
| LU-F18 | §7 `/quote` email, §9 ready link |
| LU-F19 | §6 `FOR UPDATE` |
| LU-F20, SA-F12 | §10 cadence and injectable clock, §13.5 rehearsal method |
| LU-F21 | §13.1–2 |
| LU-F22, SA-F9 | §9 idempotency, card-link version |
| LU-F23 | cuts taken: R11 (no new events), R17 (no flag), no server email, no bad-code counter; R7 kept (owner-confirmed) |
| SA-F5 | §5 table, §9 discount |
| SA-F10 | R13 lookup rule |
