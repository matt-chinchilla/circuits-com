"""Destructive: delete seeded orgs by name."""
from __future__ import annotations

import asyncio

from .client import RevClient

SEEDED_ORG_NAMES = {
    "Digi-Key Electronics",
    "Mouser Electronics",
    "Arrow Electronics",
    "Newark Electronics",
    "RS Components",
}


async def run_reset() -> None:
    async with RevClient.from_env() as client:
        print("-- deleting orgs --")
        orgs = await client.list_organizations()
        for org in orgs:
            name = org.get("name") or org.get("label", "")
            if name in SEEDED_ORG_NAMES:
                try:
                    await client.delete_organization(org["id"])
                    print(f"  deleted org {name}  id={org['id']}")
                except Exception as exc:  # noqa: BLE001
                    print(f"  ! failed to delete {name}: {exc}")
        print(
            "\nproducts + anomaly rule + metered events are NOT auto-deleted"
            " — remove manually in the Revenium UI if needed."
        )


if __name__ == "__main__":
    asyncio.run(run_reset())
