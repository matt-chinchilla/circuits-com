"""Tests for dashboard routes: stats, activity, revenue, popular."""

import uuid
from datetime import datetime

from app.models import ActivityEvent


class TestDashboardAuth:
    def test_stats_requires_auth(self, client, seeded_db):
        resp = client.get("/api/dashboard/stats")
        assert resp.status_code == 401

    def test_activity_requires_auth(self, client, seeded_db):
        resp = client.get("/api/dashboard/activity")
        assert resp.status_code == 401

    def test_revenue_requires_auth(self, client, seeded_db):
        resp = client.get("/api/dashboard/revenue")
        assert resp.status_code == 401

    def test_popular_requires_auth(self, client, seeded_db):
        resp = client.get("/api/dashboard/popular")
        assert resp.status_code == 401


def _auth_header(client):
    resp = client.post(
        "/api/auth/login",
        json={
            "email": "admin@test.example",
            "password": "testpass123",
        },
    )
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


class TestStats:
    def test_stats_returns_counts(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.get("/api/dashboard/stats", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["parts_count"] == 2
        assert data["suppliers_count"] == 2
        assert data["revenue_total"] == 600.0  # 500 + 100
        assert data["sponsors_count"] == 1


class TestActivity:
    def test_activity_returns_recent_items(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.get("/api/dashboard/activity", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) <= 10
        # Should have both part_added and revenue types
        types = {item["type"] for item in data}
        assert "part_added" in types
        assert "revenue" in types
        for item in data:
            assert "description" in item
            assert "created_at" in item


def _event(db, kind, title, detail=None, image_url=None, minute=0, supplier_id=None):
    """Append one activity_events row dated well past the seeded rows.

    Naive datetimes on purpose: SQLite stores TIMESTAMPTZ naively, and the feed
    orders on the isoformat STRING — a mixed naive/aware pair would sort by
    text, not by instant.
    """
    row = ActivityEvent(
        id=uuid.uuid4(),
        kind=kind,
        supplier_id=supplier_id,
        title=title,
        detail=detail,
        image_url=image_url,
        created_at=datetime(2030, 1, 1, 12, minute, 0),
    )
    db.add(row)
    db.commit()
    return row


class TestActivitySyncEvents:
    """`/dashboard/activity` merges the newest activity_events rows in."""

    def test_part_synced_event_carries_image_url(self, client, db, seeded_db, auth_header):
        _event(
            db,
            "part_synced",
            "STM32F407VGT6 — STMicroelectronics",
            detail="Clock and Timing",
            image_url="https://cdn.example.com/stm32.png",
        )
        data = client.get("/api/dashboard/activity", headers=auth_header()).json()
        synced = [i for i in data if i["type"] == "part_synced"]
        assert len(synced) == 1
        assert synced[0]["description"] == (
            "Synced STM32F407VGT6 — STMicroelectronics into Clock and Timing"
        )
        assert synced[0]["image_url"] == "https://cdn.example.com/stm32.png"

    def test_part_synced_without_detail_degrades(self, client, db, seeded_db, auth_header):
        """An uncategorized part has a NULL detail — no dangling "into"."""
        _event(db, "part_synced", "NE555P — Texas Instruments")
        data = client.get("/api/dashboard/activity", headers=auth_header()).json()
        synced = [i for i in data if i["type"] == "part_synced"]
        assert len(synced) == 1
        assert synced[0]["description"] == "Synced NE555P — Texas Instruments"
        assert synced[0]["image_url"] is None

    def test_sync_finished_renders_counts_detail(self, client, db, seeded_db, auth_header):
        _event(db, "sync_finished", "Avnet", detail="3 synced · 1 images filled · 0 not found")
        data = client.get("/api/dashboard/activity", headers=auth_header()).json()
        finished = [i for i in data if i["type"] == "sync_finished"]
        assert len(finished) == 1
        assert finished[0]["description"] == (
            "Inventory sync — 3 synced · 1 images filled · 0 not found"
        )

    def test_started_and_error_kinds_are_excluded(self, client, db, seeded_db, auth_header):
        """Task 4 persists them; the feed shows only what a sync ACHIEVED."""
        _event(db, "sync_started", "Avnet", detail="25 parts queued", minute=1)
        _event(db, "sync_error", "Feed unavailable", detail="quota exceeded", minute=2)
        _event(db, "part_synced", "NE555P — TI", detail="Clock and Timing", minute=3)
        data = client.get("/api/dashboard/activity", headers=auth_header()).json()
        types = {i["type"] for i in data}
        assert "sync_started" not in types
        assert "sync_error" not in types
        assert "part_synced" in types

    def test_legacy_items_carry_null_image_url(self, client, seeded_db, auth_header):
        data = client.get("/api/dashboard/activity", headers=auth_header()).json()
        legacy = [i for i in data if i["type"] in ("part_added", "revenue")]
        assert legacy
        for item in legacy:
            assert item["image_url"] is None

    def test_newest_first_and_capped_at_ten(self, client, db, seeded_db, auth_header):
        for i in range(14):
            _event(db, "part_synced", f"SKU-{i:02d}", detail="Clock and Timing", minute=i)
        data = client.get("/api/dashboard/activity", headers=auth_header()).json()
        assert len(data) == 10
        # All 14 events post-date the seeded parts/revenue, so the feed is all
        # events — the newest 10, newest first.
        assert [i["description"] for i in data] == [
            f"Synced SKU-{i:02d} into Clock and Timing" for i in range(13, 3, -1)
        ]


class TestRevenue:
    def test_revenue_returns_monthly(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.get("/api/dashboard/revenue", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        # Revenue in seeded_db is for March 2026
        if data:
            entry = data[0]
            assert "month" in entry
            assert "total" in entry
            assert "sponsorship" in entry
            assert "listing_fee" in entry
            assert "featured" in entry


class TestPopular:
    def test_popular_returns_top(self, client, seeded_db):
        headers = _auth_header(client)
        resp = client.get("/api/dashboard/popular", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "top_categories" in data
        assert "top_suppliers" in data
        assert len(data["top_categories"]) > 0
        assert len(data["top_suppliers"]) > 0
        # Check structure
        cat = data["top_categories"][0]
        assert "name" in cat
        assert "parts_count" in cat
        sup = data["top_suppliers"][0]
        assert "name" in sup
        assert "listings_count" in sup
