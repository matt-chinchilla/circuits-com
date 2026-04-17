"""Seed 10 subscriptions (5 orgs × 2 products) so Revenue-per-Customer populates.

**STATUS: BLOCKED** as of 2026-04-17. `POST /profitstream/v2/api/subscriptions`
returns 400 even when all documented required fields are present. The server
progressively reveals new required fields on each attempt — see cto-feedback.md
for the full trail. Leaving this file in the tree so the attempted payload
shape is captured; it will work once the subscription validation error messages
improve.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

from .client import RevClient
from .models import CustomerOrg, Product

CUSTOMERS_PATH = Path(__file__).resolve().parent.parent / "customers.yaml"
PRODUCTS_PATH = Path(__file__).resolve().parent.parent / "products.yaml"


async def _resolve_ids(
    client: RevClient, orgs: list[CustomerOrg], products: list[Product]
) -> tuple[dict[str, str], dict[str, str]]:
    """Look up pre-existing org + product IDs by name/externalId."""
    org_by_slug: dict[str, str] = {}
    for org_record in await client.list_organizations():
        for my_org in orgs:
            if org_record.get("name") == my_org.name or org_record.get("label") == my_org.name:
                org_by_slug[my_org.slug] = org_record["id"]

    resp = await client._admin_request(
        "GET",
        "/profitstream/v2/api/products",
        params={
            "tenantId": client.tenant_id,
            "teamId": client.team_id,
            "size": 200,
        },
    )
    products_list = resp.get("_embedded", {}).get("productResourceList", [])
    product_by_key: dict[str, str] = {}
    for prod in products_list:
        for my_prod in products:
            if (
                prod.get("externalId") == my_prod.key
                or prod.get("name") == my_prod.name
            ):
                product_by_key[my_prod.key] = prod["id"]

    return org_by_slug, product_by_key


async def run_seed_subscriptions() -> None:
    orgs = [CustomerOrg(**x) for x in yaml.safe_load(CUSTOMERS_PATH.read_text())["customers"]]
    products = [Product(**x) for x in yaml.safe_load(PRODUCTS_PATH.read_text())["products"]]
    start_iso = (datetime.now(tz=timezone.utc) - timedelta(days=90)).isoformat()

    async with RevClient.from_env() as client:
        org_by_slug, product_by_key = await _resolve_ids(client, orgs, products)
        print(f"Resolved: {len(org_by_slug)} orgs, {len(product_by_key)} products")

        # Existing subscriptions (idempotency — skip if subscriptionId match)
        resp = await client._admin_request(
            "GET",
            "/profitstream/v2/api/subscriptions",
            params={
                "tenantId": client.tenant_id,
                "teamId": client.team_id,
                "size": 200,
            },
        )
        existing_ext_ids = {
            s.get("subscriptionId")
            for s in resp.get("_embedded", {}).get("subscriptionResourceList", [])
        }

        ok = skip = fail = 0
        for org in orgs:
            for prod in products:
                if org.slug not in org_by_slug or prod.key not in product_by_key:
                    print(f"  ! missing id for {org.slug}/{prod.key}")
                    fail += 1
                    continue
                sub_ext_id = f"circuits-{org.slug}-{prod.key}"
                if sub_ext_id in existing_ext_ids:
                    print(f"  = {sub_ext_id}  (already exists — skipped)")
                    skip += 1
                    continue
                payload = {
                    "name": f"{org.name} — {prod.name}",
                    "subscriptionId": sub_ext_id,
                    "organizationId": org_by_slug[org.slug],
                    "productId": product_by_key[prod.key],
                    "teamId": client.team_id,
                    "ownerId": client.owner_id,
                    "clientEmailAddress": org.contact_email,
                    "namedSubscribers": [org.contact_email],  # list of email strings
                    "start": start_iso,
                    "sendToSubscriber": False,
                }
                try:
                    r = await client._admin_request(
                        "POST",
                        "/profitstream/v2/api/subscriptions",
                        json=payload,
                    )
                    print(f"  ✓ {sub_ext_id}  →  id={r.get('id')}")
                    ok += 1
                except Exception as exc:  # noqa: BLE001
                    print(f"  ! {sub_ext_id}:  {str(exc)[:180]}")
                    fail += 1

        print(f"\n== subscriptions: ok={ok} skip={skip} fail={fail} ==")


async def main() -> None:
    await run_seed_subscriptions()


if __name__ == "__main__":
    asyncio.run(main())
