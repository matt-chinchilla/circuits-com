"""Resolve pipeline: budget, quota wall, per-miss events, persistence."""

import json

import httpx
import pytest

from app.config import settings
from app.models import Part, Supplier
from app.services import bom_resolve
from app.services.bom_resolve import DailyBudget, bom_event


def _mouser_payload(mpn: str):
    return {
        "SearchResults": {
            "Parts": [
                {
                    "ManufacturerPartNumber": mpn,
                    "Manufacturer": "TI",
                    "Description": "Adjustable regulator",
                    "Availability": "500 In Stock",
                    "LifecycleStatus": "In Production",
                    "PriceBreaks": [{"Price": "$0.50", "Quantity": 1, "Currency": "USD"}],
                }
            ]
        }
    }


def _fake_client(known: dict[str, dict]):
    """MockTransport that answers by the keyword INSIDE the posted body —
    a fake that ignores the request contents would certify a broken query
    pipeline green (the FakeStripe lesson)."""

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        keyword = (
            body.get("SearchByKeywordRequest", {}).get("keyword")
            or body.get("SearchByPartRequest", {}).get("mouserPartNumber")
            or ""
        )
        hit = known.get(keyword)
        if hit is None:
            return httpx.Response(200, json={"SearchResults": {"Parts": []}})
        return httpx.Response(200, json=hit)

    return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.fixture
def mouser_supplier(db):
    s = Supplier(name="Mouser Electronics", website="https://mouser.com")
    db.add(s)
    db.commit()
    return s


@pytest.fixture(autouse=True)
def fresh_budget():
    bom_resolve.budget.reset()
    yield
    bom_resolve.budget.reset()


@pytest.fixture(autouse=True)
def fresh_rate_buckets():
    """The /resolve limiter is 4/min of PROCESS state — more than four cases
    post here, so the window is cleared between them (the test_checkout.py
    pattern). Rate limiting itself is exercised where it is the subject."""
    from app.routes import bom as bom_route

    bom_route._resolve_limiter.buckets.clear()
    yield
    bom_route._resolve_limiter.buckets.clear()


class TestDailyBudget:
    def test_spends_to_the_setting_then_refuses(self, monkeypatch):
        monkeypatch.setattr(settings, "BOM_RESOLVE_DAILY_BUDGET", 3)
        b = DailyBudget()
        assert [b.try_spend() for _ in range(4)] == [True, True, True, False]


class TestResolveRoute:
    def _stream(self, client, misses):
        res = client.post("/api/bom/resolve", json={"misses": misses})
        assert res.status_code == 200
        return [json.loads(line) for line in res.text.splitlines() if line.strip()]

    def test_resolved_miss_persists_and_streams_the_match_row(
        self, client, db, mouser_supplier, monkeypatch
    ):
        monkeypatch.setattr(
            bom_resolve,
            "_provider_client",
            lambda: _fake_client({"LM317T": _mouser_payload("LM317T")}),
        )
        monkeypatch.setattr(
            "app.services.part_feed.registry.get_feed_key", lambda db, p="mouser": "k"
        )
        events = self._stream(client, [{"index": 0, "query": "LM317T", "mpn": "LM317T"}])
        assert events[0]["kind"] == "resolved"
        assert events[0]["row"]["part"]["sku"] == "LM317T"
        assert events[0]["row"]["status"] == "exact_live"
        part = db.query(Part).filter(Part.sku == "LM317T").one()
        assert part.lifecycle_verified_at is not None  # stamped from the feed

    def test_not_found_miss(self, client, db, mouser_supplier, monkeypatch):
        monkeypatch.setattr(bom_resolve, "_provider_client", lambda: _fake_client({}))
        monkeypatch.setattr(
            "app.services.part_feed.registry.get_feed_key", lambda db, p="mouser": "k"
        )
        events = self._stream(client, [{"index": 3, "query": "NOPE-1"}])
        assert events == [bom_event("not_found", 3, detail="No distributor result for NOPE-1")]

    def test_budget_exhaustion_marks_all_remaining_unavailable(
        self, client, db, mouser_supplier, monkeypatch
    ):
        monkeypatch.setattr(settings, "BOM_RESOLVE_DAILY_BUDGET", 1)
        monkeypatch.setattr(
            bom_resolve,
            "_provider_client",
            lambda: _fake_client({"A1111": _mouser_payload("A1111")}),
        )
        monkeypatch.setattr(
            "app.services.part_feed.registry.get_feed_key", lambda db, p="mouser": "k"
        )
        events = self._stream(
            client,
            [
                {"index": 0, "query": "A1111", "mpn": "A1111"},
                {"index": 1, "query": "B2222", "mpn": "B2222"},
            ],
        )
        assert events[0]["kind"] == "resolved"
        assert events[1]["kind"] == "resolve_unavailable"

    def test_quota_wall_stops_the_run(self, client, db, mouser_supplier, monkeypatch):
        def fatal(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, json={})

        monkeypatch.setattr(
            bom_resolve,
            "_provider_client",
            lambda: httpx.Client(transport=httpx.MockTransport(fatal)),
        )
        monkeypatch.setattr(
            "app.services.part_feed.registry.get_feed_key", lambda db, p="mouser": "k"
        )
        events = self._stream(
            client,
            [
                {"index": 0, "query": "A1111"},
                {"index": 1, "query": "B2222"},
            ],
        )
        assert [e["kind"] for e in events] == ["resolve_unavailable", "resolve_unavailable"]

    def test_no_configured_source_is_unavailable_not_500(self, client, db):
        events = self._stream(client, [{"index": 0, "query": "X9999"}])
        assert events[0]["kind"] == "resolve_unavailable"

    def test_misses_cap_50(self, client):
        misses = [{"index": i, "query": f"Q{i}"} for i in range(51)]
        assert client.post("/api/bom/resolve", json={"misses": misses}).status_code == 422
