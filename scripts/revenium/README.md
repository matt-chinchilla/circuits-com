# Revenium Seed Tool

Seeds a Revenium tenant with fictional circuits.com customer usage data for a CTO-meeting demo. Demo-only — do not run against production.

## Purpose

This tool populates a Revenium tenant (https://app.revenium.ai) with 90 days of backdated AI completion events so the dashboard renders a plausible cost/usage story for the upcoming CTO meeting. It also lays the groundwork for future real sales tracking once circuits.com onboards actual distributor accounts. The data is fictional and the tenant must be a demo/sandbox — the tool is not safe to point at production.

## Prerequisites

- Python 3.12+
- Revenium API key with `ROLE_TENANT_ADMIN` role
- Target tenant should be a demo/sandbox, not production

## Install

```bash
cd scripts/revenium
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
# edit .env with your tenant details
```

Required env vars (see `.env.example`):

- `REVENIUM_API_KEY` — format `hak_...`
- `REVENIUM_BASE_URL` — default `https://api.revenium.ai`
- `REVENIUM_TENANT_ID`
- `REVENIUM_TEAM_ID`
- `SEED_RANDOM_SEED` — default `42`
- `SEED_HISTORY_DAYS` — default `90`
- `SEED_CONCURRENCY` — default `10`

## Commands

- `python -m revenium_seed probe` — canary test. POSTs a single completion at 7/30/60/90-day backdated offsets to determine the max accepted timestamp lookback. Writes `probe_result.json`. Runtime: ~30 seconds.
- `python -m revenium_seed seed` — full seeding. Creates orgs, subscribers, products, and source, then writes 90 days of backdated completions plus the day-60 anomaly and the anomaly detection rule. Runtime: ~10–15 minutes with `Semaphore(10)`.
- `python -m revenium_seed verify` — pulls analytics read endpoints and prints an expected-vs-actual table broken down by org, product, and model. Runtime: ~1 minute.
- `python -m revenium_seed reset --yes` — DESTRUCTIVE. Deletes the seeded orgs, products, and source by slug. The `--yes` flag is required.

## What gets created

- 5 customer organizations (public distributor brands as placeholder names: Digi-Key, Mouser, Arrow, Newark, RS Components — demo-only, not real customers)
- 5 subscribers, one per org, with fictional `engineering@` emails
- 2 products: `ai-component-search` (Claude Haiku, ~500 calls/day at peak) and `ai-datasheet-summarizer` (Claude Sonnet, ~30 calls/day at peak)
- ~45,000 backdated AI completion events across 90 days, uniform across orgs, with weekend dips and a realistic growth curve
- 1 anomaly spike on day 60 (Newark: 10x normal summarizer volume for 6 hours) — the "incident" the alert rule fires on
- 1 anomaly detection rule (P95 cost-per-organization threshold)

## Safety

- **Demo tenants only.** Do not run against a tenant that contains real customer data.
- Seeded orgs have deterministic slugs (e.g., `digikey`, `newark`) — `reset` removes exactly what `seed` creates.
- Seed is **idempotent on resources** (orgs/products are existence-checked before create) but **not on events** — running `seed` twice produces duplicate completions. Run `reset` first to re-seed cleanly.

## Storytelling note

The 5 distributor names are placeholders. Circuits.com does not sell parts; it sells ad placement and listing throughput to suppliers. The AI products (search + summarizer) are buyer-engagement features that increase listing value — the Revenium cost is an input to circuits.com's ad-revenue model, not a per-customer line item. CTOs viewing the dashboard should read the narrative as "here is the shape of the economics if circuits.com had N signed distributors using these two AI features for 90 days."

## Gotchas

- Timestamp lookback: if the server rejects 90-day-old `requestTime`, the probe captures the max accepted offset and seed automatically uses that as its ceiling. Don't bypass the probe.
- Don't modify `customers.yaml` slugs after seeding without running `reset` first — the idempotency check is slug-keyed, and a rename creates orphaned resources in the tenant.
- The `revenium_metering.meter()` decorator (for live LLM wrapping) is NOT used here. We post historical events directly via `ai.create_completion()` so we can supply backdated timestamps.
- The `/usr/bin/revenium-metering` Node CLI is a DIFFERENT tool (Claude Code telemetry backfill); do not confuse it with this Python SDK.

## Development

- `pytest tests/` — run the generator-logic tests
- Generators are pure-logic and tested offline; the client and orchestration layers are exercised by `probe` against the real API.
