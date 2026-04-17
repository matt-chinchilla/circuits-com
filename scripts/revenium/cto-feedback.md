# Revenium — CTO Meeting Feedback

**Tenant:** `lm49Lv` (mc@matthew-chirichella.com)
**Date:** 2026-04-17
**Context:** Seeded a demo tenant with 104,362 backdated AI completions across 5 distributor customer organizations and 2 products (Haiku search + Sonnet summarizer) over 90 days, with a planted anomaly spike on day 60. Goals of the exercise: evaluate Revenium for potential circuits.com integration + validate the developer experience end-to-end.

Findings below in descending priority — the first three are **reproducible bugs**, the rest are UX/DX signals.

---

## 🚨 P0 — Chart Builder returns HTTP 500 (broken for this tenant)

Creating a custom chart at `https://app.revenium.ai/dashboards/chart-builder` → click **Create Chart** → modal opens showing *"No data available. Please try refreshing the page."*

The page fires:
```
GET https://api.prod.ai.hcapp.io/profitstream/v2/api/reports/chart-builder/available-data?teamId=5Bndx5
→ 500 Internal Server Error
x-amzn-requestid: e36737c2-87b3-4b17-84d8-d3b54452a53f
Response body: "An unexpected error occurred, please contact Revenium support"
```

Reload doesn't help. The generic "please contact Revenium support" body hides the real server-side failure — at minimum, the 500 error path should surface enough detail for a customer to self-serve (is it a missing resource, permissions, schema migration?). Affected: the entire "build your own chart" experience is unreachable on this tenant.

**Impact:** highest-value differentiator of the product (custom chart composition) is unusable for this account.

---

## 🚨 P0 — Performance dashboards show Sample Data despite 104k metered events

`https://app.revenium.ai/performance/tasks` renders every card with a "Sample Data" banner and a **"Connect your Data"** link to `/home`. Cards affected: Task Throughput, Task Volume By Type, Task Completion Rate, Task Completion Rate Over Time, Duration by Task Type, Duration Trends, Time to First Token, TTFT Trends.

Meanwhile, **Costs & Revenue** dashboards **do** populate from the same underlying metering stream (Agents, Models, Products, Customers, Top Movers all show our seed).

So Performance consumes a different data pipeline than Costs & Revenue. The "Connect your Data" link routes to an onboarding page that doesn't explain which pipeline is missing. A customer who successfully completed the `meter_ai_completion` integration reasonably expects Performance to light up — the current state is unnecessarily discouraging.

**Ask for CTO:** document which fields on `meter_ai_completion` drive Performance (we suspect `task_type` + `time_to_first_token` + `stop_reason` with specific values). The current `task_type` values we sent (`ai-component-search`, `ai-datasheet-summarizer`) don't trigger Performance, but the Performance sample data shows `code_generation`, `code_review`, `research`, `testing`, `deployment` — implying a canonical-task-type list that isn't documented in `llms.txt` or readme.io.

---

## 🚨 P0 — Subscription creation is impossible to reverse-engineer from error messages

Attempted to create 10 subscriptions (5 orgs × 2 products) programmatically to light up the **Revenue per Customer** and **Profit Margin per Customer** dashboards — both of which are currently empty for this tenant. Every attempt returned 400, with the server revealing missing fields one at a time. Full trail (each step fixed the previous error):

| Attempt | Error details |
|---|---|
| 1. nested objects `organization: {id}`, `product: {id}` | `ownerId is a required field`, `clientEmailAddress is a required field`, `productId is a required field`, `teamId is a required field` |
| 2. flat `ownerId`, `productId`, `teamId`, `clientEmailAddress` added | `{"error": "List is empty."}` — no hint which list |
| 3. probed each list field separately | `namedSubscribers` accepts only `List<String>` (emails), not objects — but the actual empty-list error was somewhere else |
| 4. added `namedSubscribers: ["engineering@digikey.com"]` + all other lists empty | still 400 `"Invalid request"` with same `"List is empty."` detail |

Two real problems here:

1. **Error messages reveal fields one at a time.** A 400 with "Validation failed for one or more fields" should list ALL failing fields, not just the first set. Every fix-and-retry cycle burns a round-trip.
2. **`"List is empty."` is not debuggable.** Which list? The schema has `namedSubscribers`, `namedOrganizations`, `credentials`, `quotas`, `tags`, `additionalInvoiceRecipients`, `notificationAddressesOnCreation`, `notificationAddressesOnQuotaThreshold` — 8 candidate lists. The error should name the field.

Also: the `POST /profitstream/v2/api/subscriptions` endpoint is not covered by the Python SDK (it only wraps the `/meter/v2/*` endpoints), so there's no typed client to lean on. Customers building revenue-tracking end up reverse-engineering Spring Boot validation errors by probe.

**WIP code:** `scripts/revenium/revenium_seed/seed_subscriptions.py` captures the attempted payload shape — will work once the `"List is empty"` error specifies which list.

**Customer-impact diff:** without subscriptions, the Customers tab shows "UNCLASSIFIED $0.00" under Revenue-per-Customer (screenshot `02-costs-revenue-customers.png`). That's the single most important dashboard for the "per-customer P&L" conversation. It's reachable data — just blocked by the schema.

---

## 💰 Hypothetical per-customer P&L (what the Revenue dashboards WOULD show)

Captured here because the subscription API is blocked (see above). This is the narrative I'd want the Revenue and Profit-Margin dashboards to tell:

**Assumption set:** circuits.com markets AI search + summarizer at a **3× gross margin** over raw token cost, billed monthly per subscriber. Based on actual 90-day metered spend from our seed:

| Customer | 90d cost (metered) | 90d revenue @ 3× | Gross margin | Note |
|---|---|---|---|---|
| Digi-Key Electronics | $117.21 | $351.63 | $234.42 (66.7%) | Largest account by margin |
| Mouser Electronics | $116.67 | $350.01 | $233.34 (66.7%) | |
| Arrow Electronics | $115.44 | $346.32 | $230.88 (66.7%) | |
| Newark Electronics | $115.14 | $345.42 | $230.28 (66.7%) | Skewed by day-60 anomaly |
| RS Components | $114.96 | $344.88 | $229.92 (66.7%) | |
| **Total** | **$579.42** | **$1,738.26** | **$1,158.84** | ARR projection: **$6,953** |

At these rates, each new distributor customer contributes **~$2,317/year ARR** with **~66.7% gross margin** before overhead. The Day-60 Newark anomaly would have temporarily pushed their margin below the SLA floor — exactly the scenario the cost anomaly rule is designed to catch.

---

## 🚨 P1 — `llms.txt` analytics endpoint paths return 404

Your public `llms.txt` at `https://docs.revenium.io/~gitbook/mcp` (and exposed at `docs.revenium.io/for-ai-agents`) lists endpoints like:

- `get_api-v2-analytics-cost-by-organization-aggregated`
- `get_api-v2-analytics-cost-by-model`
- `get_api-v2-analytics-top-movers`

These slugs suggest `/v2/api/analytics/cost-by-organization-aggregated`. Empirically:

```
GET https://api.revenium.ai/v2/api/analytics/cost-by-organization-aggregated → 404 (HTML, not JSON)
GET https://api.revenium.ai/profitstream/v2/api/analytics/cost-by-organization-aggregated → 404 (JSON)
GET https://api.revenium.ai/api/v2/analytics/cost-by-organization-aggregated → 404
```

The actual working prefix, discovered via the browser's network tab, is:
```
https://api.prod.ai.hcapp.io/profitstream/v2/api/reports/...
```

Two separate issues here:

1. **Public API host vs UI-internal host divergence.** `api.revenium.ai` serves some routes (metering + admin confirmed), `api.prod.ai.hcapp.io` serves others (reports/analytics). Docs point at the former; UI uses the latter. An SDK consumer building analytics readback against the documented host silently fails.
2. **`llms.txt` path convention is wrong.** The slug-to-path translation in `llms.txt` encodes `/v2/api/analytics/`, but the real path is `/profitstream/v2/api/reports/`. Agents using `llms.txt` for endpoint discovery get 404s with zero signal about the discrepancy.

Proposed fix: either expose the reports service on `api.revenium.ai` under the advertised path, or correct `llms.txt` to reference the real path. Either way, document which host is canonical.

---

## 🟡 P1 — "Top Movers" / "Cost by Customer" display raw organization IDs instead of names

Screenshot context: `https://app.revenium.ai/costs-revenue/top-movers` shows:

| # | Entity | Current | Previous | Change |
|---|---|---|---|---|
| 1 | `l344j5` | $39.07 | $23.78 | +64.3% |
| 2 | `5orrQl` | $38.48 | $23.47 | +63.9% |
| 3 | `lmGGVD` | $38.32 | $23.49 | +63.2% |

Those IDs correspond to our 5 distributor orgs ("Digi-Key Electronics", "Arrow Electronics", "RS Components") — the org records have `name` fields populated. The Products table has the same issue (`l334Kl`, `5joBBD`).

A CTO/finance user can't make sense of a leaderboard of opaque IDs. The backend already returns a `_links.self` href; it should denormalize the `name` into the analytics response.

**Quick fix (likely one JSON join):** `Top Movers` → lookup `organizations.name by id` and `products.name by externalId`.

**Confirmed via API inspection 2026-04-17:** every org record has `name: 'Digi-Key Electronics'` and matching `label`. The fields exist at source; the analytics response simply doesn't include them. This is a one-JOIN fix on the reports service — but the report endpoint currently emits only `organizationId`, never `organizationName`.

**Related cleanup blocker:** we created duplicate orgs during an early iteration run (before the `_embedded.organizationResourceList` idempotency fix). `DELETE /organizations/{id}` returns 400 `"Can't delete organizations with existing users. Remove other users first or transfer ownership."` Subscribers are shared across orgs by email (engineering@digikey.com is tied to BOTH the active and duplicate org records), so removing them to enable deletion would orphan the active org's subscription. Effective outcome: duplicate empty orgs persist in the dashboard with $0.00 bars.

*Proposed API change:* support `DELETE /organizations/{id}?force=true` that cascades subscriber unlinking (not subscriber deletion — keep the user, just drop the org link). Current path makes cleanup of prototype data impractical.

---

## 🟡 P1 — Coverage Ratio math for sandbox tenants

`https://app.revenium.ai/overview/providers?range=30d` shows:

| Provider | Metered | Billing | Coverage |
|---|---|---|---|
| Anthropic | $130.15 | $0.07 | **186 927.5 %** |

The 186,000% figure is technically correct (metered / billing × 100) — but for a sandbox/demo tenant it looks like a bug. The billing number is the user's real Anthropic bill ($0.07 from a small real pipeline); the metered number is 104k fictional events we posted.

Three options for making this less alarming:

1. **"Sandbox" tenant flag** that suppresses the billing cross-reference card entirely.
2. **Explicit disclaimer** when coverage > 150% or < 50% ("This may indicate metering misconfiguration or a demo tenant with synthetic data").
3. **Per-subscription tagging** — mark individual completions as `environment = "demo"` and exclude them from the coverage calc.

From the SDK, `environment` is already a field on `ai_create_completion_params` (line 44 of the generated Python SDK). It's not used by the dashboard today.

---

## 🟡 P2 — Anomaly rule toggle state ambiguous

At `https://app.revenium.ai/alerts/alerts-configuration`, the rule list shows a toggle switch labeled **"Disabled alert"** with `checked=true`. Unclear if "checked" means "the disabled state is on" (rule is off) or "the rule is on, and the toggle is checked." Our programmatically-created rule `circuits.com — daily cost-per-org threshold` appears in the list but its on/off status is unreadable from the column.

The ARIA label should be explicit: either `"Enable alert"` / `"Disable alert"` based on current state, or add a **STATUS** column with `Active` / `Disabled` text.

---

## 🟢 Positive signals (worth amplifying)

1. **Top Movers is a great landing experience** — immediately shows which agents/models/customers/products are drifting. For a cost-conscious buyer, this is the single most compelling view in the app. Consider making it the default landing page.
2. **Coverage Ratio concept is differentiating** — "here's what I think I spent vs what the provider actually billed" is a real observability problem that nobody else solves. The execution just needs demo-tenant guard rails (see P1 above).
3. **Stainless-generated Python SDK (`revenium_metering` v6.8+) is excellent** — typed, camelCase-to-snake_case aliasing handled, async client works out of the box, `max_retries` sensible default. The one rough edge: profitstream admin endpoints (orgs / subscribers / products / anomaly rules) are NOT in the SDK, so consumers fall back to raw HTTP for those. Consider a second Stainless generation from the profitstream OpenAPI spec.

---

## 🧰 Integration-specific gotchas discovered while seeding (would be worth a "common traps" doc)

| Trap | Symptom | Fix |
|---|---|---|
| List-response shape | `_embedded.organizations` doesn't exist; actual key is `_embedded.organizationResourceList` (same for `productResourceList`, `subscriberResourceList`). Idempotency checks looking at the wrong key always create duplicates. | Document the HAL-style naming convention. |
| `teamId` + `ownerId` required on **POST /products BODY**, not query params | Returns 400 `"teamId is a required field"` even when present in query. | Clarify in readme.io. |
| `plan.name` required on product create but not listed in docs | Returns 400 `"Invalid JSON format"` with details `{"Missing required parameter":"name"}` — confusing because top-level `name` is present. The error is about `plan.name`. | Fix the error message to say `plan.name`. |
| Anomaly `periodDuration` enum is `DAILY`, not `ONE_DAY` | Server returns 404 `"Could not find a tracking period for ONE_DAY"` instead of 400 with enum list. | Return 400 with valid enum values in the error body. |
| `/usr/bin/revenium-metering` (Node CLI) vs `revenium_metering` (Python SDK) | Two unrelated tools ship under confusingly similar names. The Node CLI only backfills Claude Code telemetry; the Python SDK does general metering. | Rename one of them; or document the distinction loudly on the docs landing page. |

---

## 📊 Custom dashboard I built for the meeting

`https://app.revenium.ai/dashboards/P8M0ELRjWtRdyPO` — titled *"Circuits.com 90-Day Executive View"*.

Composed of 5 pre-built cards (screenshot: `scripts/revenium/screenshots/04-custom-dashboard.png`):

1. **Cost / Customer** — bar chart, 5 distributor orgs
2. **Customer Cost Over Time** — 30d line chart showing growth ramp per org
3. **Costs by Model** — donut, clean 60% Sonnet / 40% Haiku split (Sonnet is ~40× more expensive per call but 10× fewer calls → surprising "the expensive feature is most of the bill" narrative)
4. **Top Movers** — catches `claude-opus-4-6 -100%` (my real Claude Code usage tapered off), plus `claude-haiku-4-5` and `claude-sonnet-4-6` both at +52.8% (our seed growth)
5. **Revenue / Customer** — intentionally left empty; shows the subscription-API-blocker gap directly. When that's unblocked, this would populate with the hypothetical P&L table above.

---

**Happy to walk through any of this live during the meeting.**

*Screenshots: `scripts/revenium/screenshots/*.png` in the `feat/revenium-seeding` branch.*
