"""Seed circuits.com demo data into Revenium.

Idempotent on resources (orgs/subscribers/products/anomaly rule). NOT idempotent
on completions — every run appends. Use `reset` to wipe before re-seeding.
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from pathlib import Path

import yaml

from .client import RevClient
from .generators import build_completions_for_day, compute_cost
from .models import CompletionEvent, CustomerOrg, Product, ProbeResult

CONFIG_DIR = Path(__file__).resolve().parent.parent
PROBE_PATH = CONFIG_DIR / "probe_result.json"
CUSTOMERS_PATH = CONFIG_DIR / "customers.yaml"
PRODUCTS_PATH = CONFIG_DIR / "products.yaml"


def _load_customers() -> list[CustomerOrg]:
    data = yaml.safe_load(CUSTOMERS_PATH.read_text())
    return [CustomerOrg(**x) for x in data["customers"]]


def _load_products() -> list[Product]:
    data = yaml.safe_load(PRODUCTS_PATH.read_text())
    return [Product(**x) for x in data["products"]]


def _load_probe() -> ProbeResult:
    if not PROBE_PATH.exists():
        raise RuntimeError(
            "probe_result.json missing — run `python -m revenium_seed.probe` first"
        )
    return ProbeResult.model_validate_json(PROBE_PATH.read_text())


async def _ensure_resources(
    client: RevClient, orgs: list[CustomerOrg], products: list[Product]
) -> tuple[dict[str, str], dict[str, str], dict[str, str], dict[str, str]]:
    """Returns (org_ids, sub_ids, sub_emails, product_ids) keyed by slug/key."""
    org_ids: dict[str, str] = {}
    sub_ids: dict[str, str] = {}
    sub_emails: dict[str, str] = {}
    product_ids: dict[str, str] = {}

    for org in orgs:
        org_id = await client.get_or_create_organization(
            name=org.name, website=org.website, description=org.description
        )
        org_ids[org.slug] = org_id
        sub_id = await client.get_or_create_subscriber(
            email=org.contact_email,
            first_name="Engineering",
            last_name=org.name.split()[0],
            organization_ids=[org_id],
        )
        sub_ids[org.slug] = sub_id
        sub_emails[org.slug] = org.contact_email
        print(f"  org {org.slug:<14}  {org_id}  sub {sub_id}")

    default_product_id = os.environ.get("REVENIUM_DEFAULT_PRODUCT_ID", "")
    for prod in products:
        try:
            pid = await client.get_or_create_product(
                name=prod.name, external_id=prod.key, description=prod.description
            )
            print(f"  prod {prod.key:<26}  {pid}")
        except Exception as exc:  # noqa: BLE001
            # Narrow fallback: only coalesce to REVENIUM_DEFAULT_PRODUCT_ID if
            # the failure resembles the original 404 "Couldn't decode" that
            # motivated this branch. Anything else (auth, 5xx, new schema
            # regression) should halt so we see it clearly.
            reason = str(exc)
            looks_like_schema = "404" in reason or "Couldn't decode" in reason
            if not looks_like_schema or not default_product_id:
                raise
            pid = default_product_id
            print(
                f"  prod {prod.key:<26}  fallback→{pid}  (schema mismatch: {reason[:80]})"
            )
        product_ids[prod.key] = pid

    return org_ids, sub_ids, sub_emails, product_ids


_OPERATION_TYPES = {
    "ai-component-search": "SEARCH",
    "ai-datasheet-summarizer": "SUMMARIZE",
}


async def _meter_one(
    client: RevClient,
    sem: asyncio.Semaphore,
    event: CompletionEvent,
    product: Product,
    org_id: str,
    product_id: str,
    sub_id: str,
    sub_email: str,
) -> bool:
    input_cost, output_cost, total_cost = compute_cost(
        event.input_tokens,
        event.output_tokens,
        product.input_cost_per_mtok_usd,
        product.output_cost_per_mtok_usd,
    )
    async with sem:
        try:
            await client.meter_completion(
                completion_start_time=event.request_time.isoformat(),
                cost_type="AI",
                input_token_count=event.input_tokens,
                is_streamed=False,
                model=event.model,
                output_token_count=event.output_tokens,
                provider=event.provider,
                request_duration=event.duration_ms,
                request_time=event.request_time.isoformat(),
                response_time=event.response_time.isoformat(),
                stop_reason="END",
                total_token_count=event.total_tokens,
                transaction_id=event.transaction_id,
                trace_id=event.trace_id,
                organization_id=org_id,
                product_id=product_id,
                subscription_id=sub_id,
                subscriber={"id": sub_id, "email": sub_email},
                agent=f"{event.product_key}-agent",
                task_type=event.product_key,
                operation_type=_OPERATION_TYPES.get(event.product_key, "OTHER"),
                input_token_cost=input_cost,
                output_token_cost=output_cost,
                total_cost=total_cost,
            )
            return True
        except Exception as exc:  # noqa: BLE001 — partial failures logged, not re-raised
            print(f"    ! failed tx {event.transaction_id[:13]}: {str(exc)[:120]}")
            return False


async def run_seed(
    *, history_days: int | None = None, concurrency: int | None = None
) -> None:
    orgs = _load_customers()
    products = _load_products()
    probe = _load_probe()

    requested = (
        history_days
        if history_days is not None
        else int(os.environ.get("SEED_HISTORY_DAYS", 90))
    )
    days = min(requested, probe.max_backdate_days_accepted)
    if days < requested:
        print(f"! probe capped backdating at {days}d (requested {requested}d)")
    seed = int(os.environ.get("SEED_RANDOM_SEED", 42))
    conc = concurrency or int(os.environ.get("SEED_CONCURRENCY", 10))
    now = datetime.now(tz=timezone.utc)

    print(f"== seed: {len(orgs)} orgs × {len(products)} products × {days}d, "
          f"concurrency={conc}, seed={seed} ==\n")
    print("-- resources --")

    async with RevClient.from_env() as client:
        org_ids, sub_ids, sub_emails, product_ids = await _ensure_resources(
            client, orgs, products
        )

        print("\n-- metering --")
        sem = asyncio.Semaphore(conc)
        total_ok = 0
        total_fail = 0
        for day_offset in range(days):
            tasks: list[asyncio.Task[bool]] = []
            for org in orgs:
                for prod in products:
                    for event in build_completions_for_day(
                        org, prod, day_offset, now, seed
                    ):
                        tasks.append(
                            asyncio.create_task(
                                _meter_one(
                                    client, sem, event, prod,
                                    org_ids[org.slug],
                                    product_ids[prod.key],
                                    sub_ids[org.slug],
                                    sub_emails[org.slug],
                                )
                            )
                        )
            if tasks:
                results = await asyncio.gather(*tasks, return_exceptions=False)
                total_ok += sum(1 for r in results if r)
                total_fail += sum(1 for r in results if not r)
            if day_offset % 10 == 0 or day_offset == days - 1:
                print(f"  day {day_offset:>2}/{days}: ok={total_ok} fail={total_fail}")

        print("\n-- anomaly rule --")
        rule_id = await client.get_or_create_anomaly_rule(
            name="circuits.com — daily cost-per-org threshold",
            description="Demo rule: alerts when any organization's daily cost exceeds $25 USD.",
            threshold_usd=25.0,
        )
        print(f"  rule {rule_id}")

    print(f"\n== done: {total_ok} events metered, {total_fail} failures ==")


async def main() -> None:
    await run_seed()


if __name__ == "__main__":
    asyncio.run(main())
