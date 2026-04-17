"""Unified async client: revenium_metering SDK for /meter/v2, httpx for /profitstream.

The SDK covers only metering endpoints. Organization/subscriber/product/anomaly-rule
CRUD lives under /profitstream/v2/api/* which the SDK doesn't wrap, so we hit it
with httpx directly and share the same x-api-key auth header.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from revenium_metering import AsyncReveniumMetering
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

ADMIN_PREFIX = "/profitstream/v2/api"
ANALYTICS_PREFIX = "/v2/api/analytics"


class ReveniumSeedError(RuntimeError):
    pass


class RevClient:
    """Context-managed async client bundling metering SDK + admin httpx."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        tenant_id: str,
        team_id: str,
        owner_id: str,
    ):
        if not api_key or api_key.startswith("hak_REPLACE"):
            raise ReveniumSeedError("REVENIUM_METERING_API_KEY is unset or placeholder")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.tenant_id = tenant_id
        self.team_id = team_id
        self.owner_id = owner_id
        self._sdk: AsyncReveniumMetering | None = None
        self._http: httpx.AsyncClient | None = None

    @classmethod
    def from_env(cls, dotenv_path: Path | str | None = None) -> RevClient:
        load_dotenv(dotenv_path)
        return cls(
            api_key=os.environ.get("REVENIUM_METERING_API_KEY", ""),
            base_url=os.environ.get("REVENIUM_METERING_BASE_URL", "https://api.revenium.ai"),
            tenant_id=os.environ.get("REVENIUM_TENANT_ID", ""),
            team_id=os.environ.get("REVENIUM_TEAM_ID", ""),
            owner_id=os.environ.get("REVENIUM_OWNER_ID", ""),
        )

    async def __aenter__(self) -> RevClient:
        self._sdk = AsyncReveniumMetering(api_key=self.api_key, base_url=self.base_url)
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"x-api-key": self.api_key},
            timeout=httpx.Timeout(30.0),
            limits=httpx.Limits(max_connections=20),
        )
        return self

    async def __aexit__(self, *_: object) -> None:
        if self._sdk is not None:
            await self._sdk.close()
        if self._http is not None:
            await self._http.aclose()

    @property
    def sdk(self) -> AsyncReveniumMetering:
        if self._sdk is None:
            raise ReveniumSeedError("RevClient must be used as an async context manager")
        return self._sdk

    @property
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            raise ReveniumSeedError("RevClient must be used as an async context manager")
        return self._http

    async def _admin_request(
        self, method: str, path: str, *, params: dict | None = None, json: dict | None = None
    ) -> dict:
        """Retry wrapper for profitstream/analytics REST. Swallows 409 as 'already exists'."""
        async for attempt in AsyncRetrying(
            # Retry transport-level errors (timeouts, DNS, reset) AND 5xx
            # (raise_for_status raises HTTPStatusError, which is NOT a
            # TransportError subclass — we must include it explicitly).
            retry=retry_if_exception_type((httpx.TransportError, httpx.HTTPStatusError)),
            stop=stop_after_attempt(4),
            wait=wait_exponential(multiplier=1, min=1, max=20),
            reraise=True,
        ):
            with attempt:
                r = await self.http.request(method, path, params=params, json=json)
                if r.status_code == 409:
                    return {"_conflict": True, **(r.json() if r.content else {})}
                if r.status_code >= 500:
                    r.raise_for_status()  # retry via HTTPStatusError
                if r.status_code >= 400:
                    raise ReveniumSeedError(
                        f"{method} {path} → {r.status_code}: {r.text[:300]}"
                    )
                return r.json() if r.content else {}
        raise ReveniumSeedError("unreachable")

    # ---------- Organizations ----------

    async def list_organizations(self) -> list[dict]:
        body = await self._admin_request(
            "GET",
            f"{ADMIN_PREFIX}/organizations",
            params={"tenantId": self.tenant_id, "size": 200},
        )
        embedded = body.get("_embedded", {})
        return (
            embedded.get("organizationResourceList")
            or embedded.get("organizations")
            or body.get("content", [])
        )

    async def get_or_create_organization(
        self, *, name: str, website: str, description: str
    ) -> str:
        for org in await self.list_organizations():
            if org.get("name") == name or org.get("label") == name:
                return org["id"]
        body = await self._admin_request(
            "POST",
            f"{ADMIN_PREFIX}/organizations",
            json={
                "name": name,
                "tenantId": self.tenant_id,
                "website": website,
                "description": description,
            },
        )
        return body["id"]

    async def delete_organization(self, org_id: str) -> None:
        await self._admin_request("DELETE", f"{ADMIN_PREFIX}/organizations/{org_id}")

    # ---------- Subscribers ----------

    async def get_or_create_subscriber(
        self,
        *,
        email: str,
        first_name: str,
        last_name: str,
        organization_ids: list[str],
    ) -> str:
        body = await self._admin_request(
            "GET",
            f"{ADMIN_PREFIX}/subscribers",
            params={
                "tenantId": self.tenant_id,
                "teamId": self.team_id,
                "email": email,
                "size": 10,
            },
        )
        embedded = body.get("_embedded", {})
        subs = (
            embedded.get("subscriberResourceList")
            or embedded.get("subscribers")
            or body.get("content", [])
        )
        for sub in subs:
            if sub.get("email") == email:
                return sub["id"]
        created = await self._admin_request(
            "POST",
            f"{ADMIN_PREFIX}/subscribers",
            json={
                "email": email,
                "firstName": first_name,
                "lastName": last_name,
                "organizationIds": organization_ids,
            },
        )
        return created["id"]

    # ---------- Products ----------

    async def get_or_create_product(
        self, *, name: str, external_id: str, description: str
    ) -> str:
        body = await self._admin_request(
            "GET",
            f"{ADMIN_PREFIX}/products",
            params={"tenantId": self.tenant_id, "teamId": self.team_id, "size": 200},
        )
        embedded = body.get("_embedded", {})
        products = (
            embedded.get("productResourceList")
            or embedded.get("products")
            or body.get("content", [])
        )
        for p in products:
            if p.get("externalId") == external_id or p.get("name") == name:
                return p["id"]
        # teamId goes in query; product spec in body; plan MUST have its own name
        created = await self._admin_request(
            "POST",
            f"{ADMIN_PREFIX}/products",
            json={
                "name": name,
                "description": description,
                "externalId": external_id,
                "teamId": self.team_id,
                "ownerId": self.owner_id,
                "version": "1.0.0",
                "publishedStatus": True,
                "comingSoon": False,
                "plan": {
                    "type": "SUBSCRIPTION",
                    "name": f"Plan for {name}",
                    "currency": "USD",
                    "period": "MONTH",
                    "periodCount": 1,
                },
            },
        )
        return created["id"]

    # ---------- Metering (SDK wrapper) ----------

    async def meter_completion(self, **kwargs: Any) -> Any:
        """Thin wrapper so seed.py never imports the SDK directly."""
        return await self.sdk.ai.create_completion(**kwargs)

    # ---------- Anomaly rule ----------

    async def get_or_create_anomaly_rule(
        self, *, name: str, description: str, threshold_usd: float
    ) -> str:
        body = await self._admin_request(
            "GET",
            f"{ADMIN_PREFIX}/sources/ai/anomaly",
            params={"teamId": self.team_id, "size": 100},
        )
        embedded = body.get("_embedded", {})
        rules = (
            embedded.get("anomalyResourceList")
            or embedded.get("anomalies")
            or body.get("content", [])
        )
        for a in rules:
            if a.get("name") == name:
                return a["id"]
        created = await self._admin_request(
            "POST",
            f"{ADMIN_PREFIX}/sources/ai/anomaly",
            json={
                "name": name,
                "description": description,
                "teamId": self.team_id,
                "alertType": "THRESHOLD",
                "metricType": "TOTAL_COST",
                "operatorType": "GREATER_THAN",
                "threshold": threshold_usd,
                "periodDuration": "DAILY",
                "enabled": True,
                "groupBy": "ORGANIZATION",
                "isPercentage": False,
                "notificationAddresses": [],
                "slackConfigurations": [],
                "webhookConfigurations": [],
            },
        )
        return created["id"]

    # ---------- Analytics readback ----------

    async def cost_by_organization(self, *, days: int = 90) -> dict:
        end = datetime.now(tz=timezone.utc)
        start = end - timedelta(days=days)
        return await self._admin_request(
            "GET",
            f"{ANALYTICS_PREFIX}/cost-by-organization-aggregated",
            params={
                "tenantId": self.tenant_id,
                "startDate": start.isoformat(),
                "endDate": end.isoformat(),
            },
        )

    async def cost_by_model(self, *, days: int = 90) -> dict:
        end = datetime.now(tz=timezone.utc)
        start = end - timedelta(days=days)
        return await self._admin_request(
            "GET",
            f"{ANALYTICS_PREFIX}/cost-by-model-aggregated",
            params={
                "tenantId": self.tenant_id,
                "startDate": start.isoformat(),
                "endDate": end.isoformat(),
            },
        )
