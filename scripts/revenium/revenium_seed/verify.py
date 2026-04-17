"""Readback verification: pull analytics + summarise what's in the tenant."""
from __future__ import annotations

import asyncio
import json

from .client import RevClient


def _pretty(obj: object) -> str:
    return json.dumps(obj, indent=2, default=str)[:2000]


async def run_verify() -> bool:
    """Returns True iff all analytics calls succeeded."""
    ok = True
    print("== verify ==\n")
    async with RevClient.from_env() as client:
        orgs = await client.list_organizations()
        seeded = [o for o in orgs if (o.get("name") or o.get("label", "")) in {
            "Digi-Key Electronics",
            "Mouser Electronics",
            "Arrow Electronics",
            "Newark Electronics",
            "RS Components",
        }]
        print(f"orgs in tenant: {len(orgs)} total, {len(seeded)} seeded")
        for org in seeded:
            print(f"  - {org.get('name') or org.get('label')}  id={org['id']}")

        print("\n-- cost-by-organization (90d aggregated) --")
        try:
            body = await client.cost_by_organization(days=90)
            print(_pretty(body))
        except Exception as exc:  # noqa: BLE001
            print(f"  analytics call failed: {exc}")
            ok = False

        print("\n-- cost-by-model (90d aggregated) --")
        try:
            body = await client.cost_by_model(days=90)
            print(_pretty(body))
        except Exception as exc:  # noqa: BLE001
            print(f"  analytics call failed: {exc}")
            ok = False
    return ok


async def main() -> int:
    ok = await run_verify()
    return 0 if ok else 1


if __name__ == "__main__":
    import sys
    sys.exit(asyncio.run(main()))
