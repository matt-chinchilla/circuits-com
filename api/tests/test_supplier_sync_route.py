"""POST /api/suppliers/{id}/sync — the live NDJSON sync stream.

The admin clicks "Sync inventory" on a supplier and watches the parts go by.
The route is the thin part: it decides WHETHER a sync may run, then hands the
socket to `sync_supplier_listings` (which owns the actual import) and writes an
ActivityEvent per event on the way past.

Three contracts are pinned here because nothing else would notice them break:

1. **Order of refusal.** Feature-off (no key) 404s BEFORE the supplier lookup
   and before `resolve_provider` — the Mouser provider's constructor raises
   without a key, so resolving first would turn "sync is not configured" into a
   500.
2. **What gets persisted.** The wire stream carries every event; the
   activity_events table only takes the ones that describe a real change.
   `not_found` / `no_data` part events are honest on the wire and would be lies
   in the dashboard, which renders a part_synced row as "Synced X into Y".
3. **The stream never truncates.** A raise inside the response body cuts the
   NDJSON mid-line and the client sees a half-written run with no ending. Any
   non-fatal exception is turned into `sync_error` + `sync_finished` instead.
"""

import json
import uuid

import bcrypt
import pytest

from app.models import ActivityEvent, Supplier, User
from app.services.part_feed.base import FeedPart, FeedPriceBreak
from app.services.part_feed.registry import resolve_provider

FAKE_KEY = "test-key-not-real"  # never a real credential; the route only checks truthiness
DEMO_EMAIL = "demo@circuitcenter.ai"


class _FakeProvider:
    """A provider that answers from a dict — no network, no key, no sleep."""

    supplier_name = "Mouser Electronics"
    supplier_website = "mouser.com"

    def __init__(self, by_mpn=None):
        self.by_mpn = by_mpn or {}

    def search(self, keyword, limit=50):
        return []

    def lookup_mpn(self, mpn):
        return self.by_mpn.get(mpn)


class _ExplodingProvider(_FakeProvider):
    def lookup_mpn(self, mpn):
        raise RuntimeError("Mouser API HTTP 500 on /search/partnumber")


def _feed_part(
    mpn: str,
    manufacturer: str = "Feed Mfr",
    image: str | None = "https://img.example/p.jpg",
    breaks: bool = True,
) -> FeedPart:
    return FeedPart(
        mpn=mpn,
        manufacturer=manufacturer,
        description="10uF 25V ceramic capacitor 0805",
        image_url=image,
        datasheet_url="https://docs.example/d.pdf",
        supplier_sku=f"621-{mpn}",
        stock_quantity=500,
        lead_time_days=7,
        price_breaks=[FeedPriceBreak(1, 0.10), FeedPriceBreak(100, 0.08)] if breaks else [],
    )


def _events(resp):
    """The NDJSON body as event dicts — every line must be valid JSON."""
    return [json.loads(line) for line in resp.text.splitlines() if line.strip()]


@pytest.fixture
def feed_key(monkeypatch):
    """The feature is ON. The value is a placeholder: nothing calls Mouser here."""
    monkeypatch.setenv("MOUSER_API_KEY", FAKE_KEY)


@pytest.fixture
def use_fake_provider(monkeypatch):
    """Swap the registry lookup the ROUTE uses for a scripted provider."""

    def _install(provider):
        monkeypatch.setattr("app.routes.suppliers.resolve_provider", lambda supplier: provider)
        return provider

    return _install


def _sync(client, supplier, auth_header, **params):
    return client.post(
        f"/api/suppliers/{supplier.id}/sync",
        headers=auth_header(),
        params=params,
    )


class TestGuards:
    def test_unauthenticated_is_refused(self, client, seeded_db, feed_key):
        resp = client.post(f"/api/suppliers/{seeded_db['supplier1'].id}/sync")
        assert resp.status_code == 401

    def test_missing_key_404s_before_anything_else_runs(
        self, client, seeded_db, auth_header, monkeypatch
    ):
        """Feature-off posture (same as Stripe): the route simply isn't there.

        `resolve_provider` must not be reached — MouserProvider's constructor
        raises without a key, which would surface as a 500 instead of a 404.
        """
        monkeypatch.delenv("MOUSER_API_KEY", raising=False)

        def _boom(supplier):
            raise AssertionError("resolve_provider ran before the key check")

        monkeypatch.setattr("app.routes.suppliers.resolve_provider", _boom)

        resp = _sync(client, seeded_db["supplier1"], auth_header)

        assert resp.status_code == 404
        assert resp.json()["detail"] == "sync_unavailable"

    def test_bad_uuid_is_404(self, client, seeded_db, auth_header, feed_key):
        resp = client.post("/api/suppliers/not-a-uuid/sync", headers=auth_header())
        assert resp.status_code == 404

    def test_unknown_supplier_is_404(self, client, seeded_db, auth_header, feed_key):
        resp = client.post(f"/api/suppliers/{uuid.uuid4()}/sync", headers=auth_header())
        assert resp.status_code == 404

    def test_supplier_with_no_matching_feed_is_409(self, client, seeded_db, auth_header, feed_key):
        """Avnet is a real distributor with no provider in the registry — that
        is a conflict with the supplier row, not a missing endpoint."""
        resp = _sync(client, seeded_db["supplier1"], auth_header)

        assert resp.status_code == 409
        assert resp.json()["detail"] == "no_feed_for_supplier"

    def test_demo_account_cannot_start_a_sync(self, client, db, seeded_db, feed_key):
        """The demo session is handed to any anonymous visitor; a sync spends
        real API quota and writes to the real catalog."""
        db.add(
            User(
                id=uuid.uuid4(),
                username="demo",
                password_hash=bcrypt.hashpw(b"demo", bcrypt.gensalt()).decode(),
                role="admin",
                email=DEMO_EMAIL,
            )
        )
        db.commit()
        token = client.post("/api/auth/demo").json()["token"]

        resp = client.post(
            f"/api/suppliers/{seeded_db['supplier1'].id}/sync",
            headers={"Authorization": f"Bearer {token}"},
        )

        assert resp.status_code == 403
        assert resp.json()["detail"] == "demo_account_read_only"


class TestStream:
    def test_happy_path_streams_ndjson_and_records_the_run(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        supplier, part1 = seeded_db["supplier1"], seeded_db["part1"]
        # Media already present, so this run refreshes the LISTING alone — the
        # plain `updated` action, kept separate from the media_filled case.
        part1.image_url = "https://img.example/p.jpg"
        part1.datasheet_url = "https://docs.example/d.pdf"
        db.commit()
        use_fake_provider(_FakeProvider(by_mpn={part1.sku: _feed_part(part1.sku)}))

        resp = _sync(client, supplier, auth_header)

        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/x-ndjson")
        # nginx buffers a proxied response by default, which would hold the
        # whole run back and deliver it as one lump at the end.
        assert resp.headers["x-accel-buffering"] == "no"
        assert resp.headers["cache-control"] == "no-cache"

        events = _events(resp)
        assert [e["kind"] for e in events] == ["sync_started", "part_synced", "sync_finished"]
        assert events[1]["action"] == "updated"
        assert events[1]["title"] == f"{part1.sku} — Feed Mfr"
        assert events[-1]["counts"] == {
            "synced": 1,
            "media_filled": 0,
            "not_found": 0,
            "no_data": 0,
        }

        rows = db.query(ActivityEvent).order_by(ActivityEvent.kind).all()
        assert [r.kind for r in rows] == ["part_synced", "sync_finished", "sync_started"]
        part_row = next(r for r in rows if r.kind == "part_synced")
        assert part_row.title == f"{part1.sku} — Feed Mfr"
        assert part_row.detail == "Clock and Timing"
        assert part_row.image_url == "https://img.example/p.jpg"
        assert str(part_row.supplier_id) == str(supplier.id)

    def test_not_found_parts_stream_but_are_never_recorded(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        """The dashboard renders a part_synced row as "Synced X into Y". A part
        the feed could not resolve synced nothing, so a row for it would read as
        a sync that happened."""
        use_fake_provider(_FakeProvider())  # resolves nothing

        resp = _sync(client, seeded_db["supplier1"], auth_header)

        actions = [e["action"] for e in _events(resp) if e["kind"] == "part_synced"]
        assert actions == ["not_found"]
        assert [r.kind for r in db.query(ActivityEvent).all()] == ["sync_started", "sync_finished"]

    def test_no_data_parts_stream_but_are_never_recorded(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        """Found, priced nothing, media already present — a real event on the
        wire and nothing worth claiming in the feed."""
        part1 = seeded_db["part1"]
        part1.image_url = "https://cdn.example/original.jpg"
        part1.datasheet_url = "https://cdn.example/original.pdf"
        db.commit()
        use_fake_provider(_FakeProvider(by_mpn={part1.sku: _feed_part(part1.sku, breaks=False)}))

        resp = _sync(client, seeded_db["supplier1"], auth_header)

        actions = [e["action"] for e in _events(resp) if e["kind"] == "part_synced"]
        assert actions == ["no_data"]
        assert [r.kind for r in db.query(ActivityEvent).all()] == ["sync_started", "sync_finished"]

    def test_media_filled_parts_are_recorded(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        part1 = seeded_db["part1"]
        use_fake_provider(_FakeProvider(by_mpn={part1.sku: _feed_part(part1.sku, breaks=False)}))

        resp = _sync(client, seeded_db["supplier1"], auth_header)

        assert [e["action"] for e in _events(resp) if e["kind"] == "part_synced"] == [
            "media_filled"
        ]
        assert db.query(ActivityEvent).filter(ActivityEvent.kind == "part_synced").count() == 1

    def test_a_long_part_title_is_clamped_to_its_column(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        """`title` is sku + manufacturer, and the manufacturer comes from the
        FEED — nothing bounds it. Postgres raises StringDataRightTruncation
        past 255 (SQLite silently accepts it, so only this assert catches it)."""
        part1 = seeded_db["part1"]
        use_fake_provider(
            _FakeProvider(by_mpn={part1.sku: _feed_part(part1.sku, manufacturer="M" * 400)})
        )

        resp = _sync(client, seeded_db["supplier1"], auth_header)

        wire = next(e for e in _events(resp) if e["kind"] == "part_synced")
        assert len(wire["title"]) > 255  # the stream is not truncated
        row = db.query(ActivityEvent).filter(ActivityEvent.kind == "part_synced").one()
        assert len(row.title) == 255
        assert row.title == wire["title"][:255]

    def test_a_long_detail_is_clamped_to_its_column(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider, monkeypatch
    ):
        supplier = seeded_db["supplier1"]
        use_fake_provider(_FakeProvider())

        def _fake_stream(db_, provider, supplier_, limit=25):
            yield {
                "kind": "part_synced",
                "supplier_id": str(supplier_.id),
                "title": "T" * 300,
                "detail": "D" * 600,
                "image_url": None,
                "action": "updated",
            }

        monkeypatch.setattr("app.routes.suppliers.sync_supplier_listings", _fake_stream)

        _sync(client, supplier, auth_header)

        row = db.query(ActivityEvent).one()
        assert len(row.title) == 255
        assert len(row.detail) == 500

    def test_a_provider_error_ends_the_stream_instead_of_truncating_it(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        """`sync_supplier_listings` handles FeedFatalError itself; anything else
        (a 500 from the provider, a bug) would raise mid-body and cut the
        NDJSON off with no ending event."""
        use_fake_provider(_ExplodingProvider())

        resp = _sync(client, seeded_db["supplier1"], auth_header)

        assert resp.status_code == 200
        events = _events(resp)  # every line still parses
        assert [e["kind"] for e in events] == ["sync_started", "sync_error", "sync_finished"]
        assert events[1]["title"] == "Sync failed"
        assert events[1]["detail"] == "Mouser API HTTP 500 on /search/partnumber"
        assert events[-1]["detail"] == "sync aborted"
        assert events[-1]["counts"] == {
            "synced": 0,
            "media_filled": 0,
            "not_found": 0,
            "no_data": 0,
        }
        kinds = [r.kind for r in db.query(ActivityEvent).all()]
        assert kinds == ["sync_started", "sync_error", "sync_finished"]

    def test_the_suppliers_logo_never_becomes_an_event_image(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        """`Supplier.logo_url` is Text and routinely holds a 64KB data URL;
        ActivityEvent.image_url is String(500). The event's own image_url (a
        feed part image, already bounded) is the only source."""
        supplier, part1 = seeded_db["supplier1"], seeded_db["part1"]
        supplier.logo_url = "data:image/png;base64," + ("A" * 5000)
        db.commit()
        use_fake_provider(_FakeProvider(by_mpn={part1.sku: _feed_part(part1.sku, image=None)}))

        _sync(client, supplier, auth_header)

        for row in db.query(ActivityEvent).all():
            assert row.image_url is None

    def test_limit_is_clamped_to_a_sane_window(
        self, client, seeded_db, auth_header, feed_key, use_fake_provider, monkeypatch
    ):
        """A negative LIMIT is a Postgres error and a huge one is an unbounded
        run against a rate-limited API — neither may reach the query."""
        use_fake_provider(_FakeProvider())
        seen = []

        def _record(db_, provider, supplier_, limit=25):
            seen.append(limit)
            return iter(())

        monkeypatch.setattr("app.routes.suppliers.sync_supplier_listings", _record)

        supplier = seeded_db["supplier1"]
        _sync(client, supplier, auth_header)
        _sync(client, supplier, auth_header, limit=0)
        _sync(client, supplier, auth_header, limit=-5)
        _sync(client, supplier, auth_header, limit=999)
        _sync(client, supplier, auth_header, limit=10)

        assert seen == [25, 1, 1, 50, 10]


class TestProviderRegistry:
    def test_a_mouser_supplier_resolves_to_the_mouser_provider(self, feed_key):
        from app.services.part_feed.mouser import MouserProvider

        supplier = Supplier(id=uuid.uuid4(), name="Mouser", website="mouser.com")
        assert isinstance(resolve_provider(supplier), MouserProvider)

    def test_matching_tolerates_scheme_case_and_subdomain(self, feed_key):
        for website in ("https://WWW.Mouser.com/", "eu.mouser.com", "MOUSER.COM"):
            supplier = Supplier(id=uuid.uuid4(), name="Mouser", website=website)
            assert resolve_provider(supplier) is not None, website

    def test_unknown_or_missing_website_resolves_to_nothing(self, feed_key):
        for website in ("avnet.com", "", None):
            supplier = Supplier(id=uuid.uuid4(), name="Other", website=website)
            assert resolve_provider(supplier) is None, website

    def test_the_provider_is_built_lazily_so_the_key_check_comes_first(self, monkeypatch):
        """Construction is what demands the key. That is exactly why the route
        checks the environment BEFORE it resolves — see TestGuards."""
        monkeypatch.delenv("MOUSER_API_KEY", raising=False)
        supplier = Supplier(id=uuid.uuid4(), name="Mouser", website="mouser.com")

        with pytest.raises(RuntimeError):
            resolve_provider(supplier)
