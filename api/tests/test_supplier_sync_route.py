"""The two live NDJSON feed streams — POST /api/suppliers/{id}/{sync,import}.

The admin clicks "Sync inventory" (refresh what this supplier already lists) or
"Import new parts" (discover inventory the catalog does not have yet) and
watches the parts go by. Both routes are the thin part: each decides WHETHER a
run may start, then hands the socket to its generator — `sync_supplier_listings`
or `grow_catalog`, which own the actual import — and writes an ActivityEvent per
event on the way past.

Four contracts are pinned here because nothing else would notice them break:

1. **Order of refusal, IDENTICAL on both routes.** Matching runs first — it is
   what separates 409 `no_feed_for_supplier` from a missing key — but the
   provider is never CONSTRUCTED until its OWN key is in hand. The Mouser
   provider's constructor raises without one, so building first would turn
   "the feed is not configured" into a 500 instead of a 404. `TestGuards` is
   parametrized over both paths precisely so the newer route cannot drift.
2. **What gets persisted, and under which kind.** The wire stream carries every
   event; the activity_events table only takes the ones that describe a real
   change. `not_found` / `no_data` part events are honest on the wire and would
   be lies in the dashboard. An `updated` / `media_filled` action is stored as
   `part_synced`; a `created` action is stored as **`part_imported`**, because
   ActivityEvent has no action column and "Synced X into Y" would describe a
   brand-new part as a refresh of something that already existed.
3. **The stream never truncates.** A raise inside the response body cuts the
   NDJSON mid-line and the client sees a half-written run with no ending. Any
   non-fatal exception is turned into `sync_error` + `sync_finished` instead,
   carrying the run's REAL tally (including `created`, which is the one counter
   an import exists to produce).
4. **The numbers a run may be asked for are clamped**, never 422'd: `limit` and
   `calls` are batch sizes, not requests a caller can get wrong.
"""

import json
import uuid
from decimal import Decimal

import bcrypt
import pytest

from app.config import settings
from app.models import (
    ActivityEvent,
    Category,
    Part,
    PartListing,
    ProviderCredential,
    Supplier,
    SupplierFeed,
    User,
)
from app.services.activity import IMPORT_EVENT_KINDS, record_stream_event
from app.services.part_feed import importer
from app.services.part_feed.importer import sync_event
from app.services.part_feed.registry import feed_configured, get_feed_key, match_provider
from tests.feed_helpers import FakeProvider as _FakeProvider
from tests.feed_helpers import feed_part as _feed_part

FAKE_KEY = "test-key-not-real"  # never a real credential; the route only checks truthiness
DB_KEY = "stored-key-not-real"  # the same, stored in provider_credentials
OTHER_KEY = "second-feed-key-not-real"  # a SECOND provider's stored key
DEMO_EMAIL = "demo@circuitcenter.ai"


class _ExplodingProvider(_FakeProvider):
    """Answers `explode_after` lookups normally, then blows up.

    The default (0) explodes on the very first part. A non-zero value is how a
    test gets REAL work committed before the failure — which is the only way to
    assert the abort path reports a non-zero tally.
    """

    def __init__(self, by_mpn=None, explode_after=0):
        super().__init__(by_mpn=by_mpn)
        self.explode_after = explode_after
        self.calls = 0

    def lookup_mpn(self, mpn):
        self.calls += 1
        if self.calls > self.explode_after:
            raise RuntimeError("Mouser API HTTP 500 on /search/partnumber")
        return super().lookup_mpn(mpn)


def _events(resp):
    """The NDJSON body as event dicts — every line must be valid JSON."""
    return [json.loads(line) for line in resp.text.splitlines() if line.strip()]


@pytest.fixture(autouse=True)
def feed_run_uses_the_test_session(db, monkeypatch):
    """Point the run's worker thread at the test database, and start clean.

    A run is server-owned now: the click starts a worker thread that opens its
    OWN session, because `get_db` closes the request's session at request
    teardown and the work outlives the request. Under test there is exactly
    ONE in-memory SQLite database and it lives on the `db` fixture's
    connection, so the worker is pointed at that same session — with `close()`
    neutered, since the fixture owns its lifetime. Without this the worker
    would open `sqlite:///./test.db` and write every row somewhere no
    assertion can see.

    Also clears the module-level run registry around every test: a run left
    behind by one test would make the next test's click a 409.
    """
    monkeypatch.setattr(db, "close", lambda: None)
    monkeypatch.setattr("app.services.part_feed.importer.SessionLocal", lambda: db)
    importer.reset_feed_runs()
    yield
    importer.reset_feed_runs()


@pytest.fixture
def feed_key(monkeypatch):
    """The feature is ON. The value is a placeholder: nothing calls Mouser here."""
    monkeypatch.setattr(settings, "MOUSER_API_KEY", FAKE_KEY)


@pytest.fixture
def use_fake_provider(monkeypatch):
    """Swap the registry lookup the ROUTE uses for a scripted provider.

    `match_provider` returns a (slug, CLASS) pair and the route builds it with
    the key it resolved for THAT slug, so the stand-in has to hand back a class
    — a fake returning an instance would pass here while the real route
    unpacked a tuple. `__new__` yields the pre-built scripted provider so the
    test keeps its handle on it, and `seen_keys` records what the constructor
    was given, which is how the key-precedence tests below check that the DB key
    is the one actually used.
    """
    seen_keys: list[str | None] = []

    def _install(provider, slug="mouser"):
        class _Scripted:
            def __new__(cls, api_key=None):
                seen_keys.append(api_key)
                return provider

        monkeypatch.setattr(
            "app.routes.suppliers.match_provider", lambda supplier: (slug, _Scripted)
        )
        provider.seen_keys = seen_keys
        return provider

    return _install


def _run(client, supplier, auth_header, path="sync", **params):
    return client.post(
        f"/api/suppliers/{supplier.id}/{path}",
        headers=auth_header(),
        params=params,
    )


def _sync(client, supplier, auth_header, **params):
    return _run(client, supplier, auth_header, "sync", **params)


def _import(client, supplier, auth_header, **params):
    return _run(client, supplier, auth_header, "import", **params)


@pytest.mark.parametrize("path", ("sync", "import"))
class TestGuards:
    """Both streams refuse in the SAME order, for the same reasons.

    Parametrized rather than duplicated: the import route was added second and
    the only thing stopping it from resolving a key before matching a provider
    (or from 500ing where sync 404s) is that these run against both.
    """

    def test_unauthenticated_is_refused(self, client, seeded_db, feed_key, path):
        resp = client.post(f"/api/suppliers/{seeded_db['supplier1'].id}/{path}")
        assert resp.status_code == 401

    def test_missing_key_404s_before_the_provider_is_built(
        self, client, db, seeded_db, auth_header, monkeypatch, path
    ):
        """Feature-off posture (same as Stripe): the route simply isn't there.

        Matching is allowed to run — it is what separates 409
        `no_feed_for_supplier` from this 404 — but CONSTRUCTION must not be
        reached: MouserProvider's constructor raises without a key, which would
        surface as a 500.
        """
        monkeypatch.setattr(settings, "MOUSER_API_KEY", None)

        class _Boom(_FakeProvider):
            def __init__(self, api_key=None):
                raise AssertionError("provider was built before the key check")

        monkeypatch.setattr("app.services.part_feed.registry._PROVIDERS", (("mouser", _Boom),))
        # supplier1 is Avnet, which matches no provider at all — that is the 409
        # below. This contract is the other one: a provider WAS matched and has
        # no key, so give the row a website the registry covers.
        supplier = seeded_db["supplier1"]
        supplier.website = "mouser.com"
        db.commit()

        resp = _run(client, supplier, auth_header, path)

        assert resp.status_code == 404
        assert resp.json()["detail"] == "sync_unavailable"

    def test_bad_uuid_is_404(self, client, seeded_db, auth_header, feed_key, path):
        resp = client.post(f"/api/suppliers/not-a-uuid/{path}", headers=auth_header())
        assert resp.status_code == 404

    def test_unknown_supplier_is_404(self, client, seeded_db, auth_header, feed_key, path):
        resp = client.post(f"/api/suppliers/{uuid.uuid4()}/{path}", headers=auth_header())
        assert resp.status_code == 404

    def test_supplier_with_no_matching_feed_is_409(
        self, client, seeded_db, auth_header, feed_key, path
    ):
        """Avnet is a real distributor with no provider in the registry — that
        is a conflict with the supplier row, not a missing endpoint."""
        resp = _run(client, seeded_db["supplier1"], auth_header, path)

        assert resp.status_code == 409
        assert resp.json()["detail"] == "no_feed_for_supplier"

    def test_demo_account_cannot_start_a_run(self, client, db, seeded_db, feed_key, path):
        """The demo session is handed to any anonymous visitor; a run spends
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
            f"/api/suppliers/{seeded_db['supplier1'].id}/{path}",
            headers={"Authorization": f"Bearer {token}"},
        )

        assert resp.status_code == 403
        assert resp.json()["detail"] == "demo_account_read_only"


class TestKeyPrecedence:
    """A key stored from Admin → Settings beats the environment, and the key the
    route resolved is the one the provider is built with.

    The second half is the part that could silently rot: gating on one key and
    then constructing the provider with another would still 200 in every
    environment that has both, and would call the distributor with the key the
    admin thought they had replaced.
    """

    def test_a_stored_key_runs_the_sync_with_no_environment_key(
        self, client, db, seeded_db, auth_header, use_fake_provider, monkeypatch
    ):
        monkeypatch.setattr(settings, "MOUSER_API_KEY", None)
        db.add(ProviderCredential(provider="mouser", api_key=DB_KEY))
        db.commit()
        use_fake_provider(_FakeProvider())

        resp = _sync(client, seeded_db["supplier1"], auth_header)

        assert resp.status_code == 200
        assert [e["kind"] for e in _events(resp)][0] == "sync_started"

    def test_the_stored_key_is_the_one_the_provider_is_built_with(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        """Both sources present — the DB row wins, all the way through."""
        db.add(ProviderCredential(provider="mouser", api_key=DB_KEY))
        db.commit()
        provider = use_fake_provider(_FakeProvider())

        _sync(client, seeded_db["supplier1"], auth_header)

        assert provider.seen_keys == [DB_KEY]

    def test_the_environment_key_is_used_when_nothing_is_stored(
        self, client, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        provider = use_fake_provider(_FakeProvider())

        _sync(client, seeded_db["supplier1"], auth_header)

        assert provider.seen_keys == [FAKE_KEY]

    def test_a_blanked_stored_key_falls_back_instead_of_syncing_with_nothing(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        """A row someone emptied is not a key. Treating it as one would call the
        distributor with an empty credential and fail every part."""
        db.add(ProviderCredential(provider="mouser", api_key="   "))
        db.commit()
        provider = use_fake_provider(_FakeProvider())

        _sync(client, seeded_db["supplier1"], auth_header)

        assert provider.seen_keys == [FAKE_KEY]

    def test_each_provider_is_called_with_ITS_OWN_key(
        self, client, db, seeded_db, auth_header, feed_key, monkeypatch
    ):
        """The registry says adding a distributor is one row and no route change.
        That only holds if the route resolves the key for the provider it
        MATCHED — resolving "mouser" unconditionally would post Mouser's
        credential to Digi-Key's API the day a second row lands.
        """

        class _Recorder(_FakeProvider):
            keys: list[str | None] = []

            def __init__(self, api_key=None):
                super().__init__()
                type(self).keys.append(api_key)

        class _MouserLike(_Recorder):
            keys: list[str | None] = []

        class _DigiKeyLike(_Recorder):
            keys: list[str | None] = []

        monkeypatch.setattr(
            "app.services.part_feed.registry._PROVIDERS",
            (("mouser", _MouserLike), ("digikey", _DigiKeyLike)),
        )
        db.add(ProviderCredential(provider="mouser", api_key=DB_KEY))
        db.add(ProviderCredential(provider="digikey", api_key=OTHER_KEY))
        supplier = seeded_db["supplier1"]
        supplier.website = "https://www.digikey.com/"
        db.commit()

        resp = _sync(client, supplier, auth_header)

        assert resp.status_code == 200
        assert _DigiKeyLike.keys == [OTHER_KEY]
        assert _MouserLike.keys == []

    def test_a_provider_with_no_key_of_its_own_is_404_even_with_mousers_set(
        self, client, db, seeded_db, auth_header, feed_key, monkeypatch
    ):
        """The same crossing, seen from the gate: Mouser being configured must
        not make a second distributor look configured."""

        class _DigiKeyLike(_FakeProvider):
            def __init__(self, api_key=None):
                super().__init__()
                raise AssertionError("constructed without a key of its own")

        monkeypatch.setattr(
            "app.services.part_feed.registry._PROVIDERS",
            (("mouser", _FakeProvider), ("digikey", _DigiKeyLike)),
        )
        supplier = seeded_db["supplier1"]
        supplier.website = "digikey.com"
        db.commit()

        resp = _sync(client, supplier, auth_header)

        assert resp.status_code == 404
        assert resp.json()["detail"] == "sync_unavailable"

    def test_404_needs_both_sources_empty(
        self, client, db, seeded_db, auth_header, use_fake_provider, monkeypatch
    ):
        monkeypatch.setattr(settings, "MOUSER_API_KEY", None)
        db.add(ProviderCredential(provider="mouser", api_key="   "))
        db.commit()
        use_fake_provider(_FakeProvider())

        resp = _sync(client, seeded_db["supplier1"], auth_header)

        assert resp.status_code == 404
        assert resp.json()["detail"] == "sync_unavailable"


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
        use_fake_provider(
            _FakeProvider(
                by_mpn={part1.sku: _feed_part(part1.sku, manufacturer=part1.manufacturer_name)}
            )
        )

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
        assert events[1]["title"] == f"{part1.sku} — {part1.manufacturer_name}"
        assert events[-1]["counts"] == {
            "synced": 1,
            "media_filled": 0,
            "not_found": 0,
            "no_data": 0,
            "created": 0,
            "listing_added": 0,
        }

        rows = db.query(ActivityEvent).order_by(ActivityEvent.kind).all()
        assert [r.kind for r in rows] == ["part_synced", "sync_finished", "sync_started"]
        part_row = next(r for r in rows if r.kind == "part_synced")
        assert part_row.title == f"{part1.sku} — {part1.manufacturer_name}"
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
        # The fake feed row carries lead_time_days=7 — a stampable part-level
        # fact since migration 039. Pre-store it so this run truly has nothing
        # new to write (that is what no_data means).
        part1.lead_time_days = 7
        db.commit()
        use_fake_provider(
            _FakeProvider(
                by_mpn={
                    part1.sku: _feed_part(
                        part1.sku, manufacturer=part1.manufacturer_name, breaks=False
                    )
                }
            )
        )

        resp = _sync(client, seeded_db["supplier1"], auth_header)

        actions = [e["action"] for e in _events(resp) if e["kind"] == "part_synced"]
        assert actions == ["no_data"]
        assert [r.kind for r in db.query(ActivityEvent).all()] == ["sync_started", "sync_finished"]

    def test_media_filled_parts_are_recorded(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        part1 = seeded_db["part1"]
        use_fake_provider(
            _FakeProvider(
                by_mpn={
                    part1.sku: _feed_part(
                        part1.sku, manufacturer=part1.manufacturer_name, breaks=False
                    )
                }
            )
        )

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
        NDJSON off with no ending event.

        The run syncs ONE part before the provider explodes, because the
        interesting half of the abort path is its TALLY: the generator's own
        totals die with it, so the route keeps its own — and the part it counts
        was committed before it was reported. Zeros here would blank the
        counters above rows that are still on screen.
        """
        supplier, part1, part2 = (
            seeded_db["supplier1"],
            seeded_db["part1"],
            seeded_db["part2"],
        )
        # Two listed parts, both with media already, so the sync order falls to
        # sku (LM7805CT before STM32F407VGT6) and the first part is a plain
        # `updated` rather than a media fill.
        for part in (part1, part2):
            part.image_url = "https://img.example/p.jpg"
            part.datasheet_url = "https://docs.example/d.pdf"
        db.add(
            PartListing(
                id=uuid.uuid4(),
                part_id=part2.id,
                supplier_id=supplier.id,
                sku=f"AVN-{part2.sku}",
                unit_price=Decimal("1.2500"),
            )
        )
        db.commit()
        use_fake_provider(
            _ExplodingProvider(
                by_mpn={part1.sku: _feed_part(part1.sku, manufacturer=part1.manufacturer_name)},
                explode_after=1,
            )
        )

        resp = _sync(client, supplier, auth_header)

        assert resp.status_code == 200
        events = _events(resp)  # every line still parses
        assert [e["kind"] for e in events] == [
            "sync_started",
            "part_synced",
            "sync_error",
            "sync_finished",
        ]
        assert events[1]["action"] == "updated"
        assert events[2]["title"] == "Sync failed"
        assert events[2]["detail"] == "Mouser API HTTP 500 on /search/partnumber"
        assert events[-1]["detail"] == "sync aborted"
        assert events[-1]["counts"] == {
            "synced": 1,
            "media_filled": 0,
            "not_found": 0,
            "no_data": 0,
            "created": 0,
            "listing_added": 0,
        }
        kinds = [r.kind for r in db.query(ActivityEvent).all()]
        assert kinds == ["sync_started", "part_synced", "sync_error", "sync_finished"]

    def test_an_abort_before_any_part_still_reports_zeros(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        """The other half of the same contract: a run that died on its FIRST
        lookup really did nothing, and must not invent a total."""
        use_fake_provider(_ExplodingProvider())

        resp = _sync(client, seeded_db["supplier1"], auth_header)

        events = _events(resp)
        assert [e["kind"] for e in events] == ["sync_started", "sync_error", "sync_finished"]
        assert events[-1]["counts"] == {
            "synced": 0,
            "media_filled": 0,
            "not_found": 0,
            "no_data": 0,
            "created": 0,
            "listing_added": 0,
        }

    def test_the_abort_tally_counts_created_parts_too(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider, monkeypatch
    ):
        """The tally is shared with the IMPORT stream (`grow_catalog`), whose
        events carry action `created`. Dropping it here would blank the one
        counter an import run exists to produce — and the abort path is the
        only place the route does its own arithmetic."""
        supplier = seeded_db["supplier1"]
        use_fake_provider(_FakeProvider())

        def _created_then_boom(db_, provider, supplier_, limit=25):
            yield sync_event(
                "part_synced",
                str(supplier_.id),
                "NEW-1 — Feed Mfr",
                "Clock and Timing",
                None,
                "created",
            )
            raise RuntimeError("Mouser API HTTP 500 on /search/keyword")

        monkeypatch.setattr("app.routes.suppliers.sync_supplier_listings", _created_then_boom)

        events = _events(_sync(client, supplier, auth_header))

        assert events[-1]["counts"] == {
            "synced": 0,
            "media_filled": 0,
            "not_found": 0,
            "no_data": 0,
            "created": 1,
            "listing_added": 0,
        }

    def test_the_suppliers_logo_never_becomes_an_event_image(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        """`Supplier.logo_url` is Text and routinely holds a 64KB data URL;
        ActivityEvent.image_url is String(500). The event's own image_url (a
        feed part image, already bounded) is the only source."""
        supplier, part1 = seeded_db["supplier1"], seeded_db["part1"]
        supplier.logo_url = "data:image/png;base64," + ("A" * 5000)
        db.commit()
        use_fake_provider(
            _FakeProvider(
                by_mpn={
                    part1.sku: _feed_part(
                        part1.sku, manufacturer=part1.manufacturer_name, image=None
                    )
                }
            )
        )

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


@pytest.fixture
def empty_subcategory(db, seeded_db):
    """A second, EMPTY subcategory — the shelf an import sweeps FIRST.

    `grow_catalog` walks subcategories thinnest-first, so a category with zero
    parts is what puts a known name at the head of the sweep and lets a test
    say which shelf a created part landed on (and makes the seeded parts, which
    live in the other child, the "already elsewhere" case).
    """
    cat = Category(
        id=uuid.uuid4(),
        name="Sensors",
        slug="sensors",
        icon="thermometer",
        parent_id=seeded_db["parent"].id,
        sort_order=1,
    )
    db.add(cat)
    db.commit()
    return cat


class TestImportStream:
    """POST /{id}/import — the discovery run, whose whole point is NEW rows."""

    def test_created_parts_stream_and_persist_as_part_imported(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider, empty_subcategory
    ):
        """The kind is the mapping's entire job: ActivityEvent has no action
        column, so a `created` part stored as `part_synced` would reach the
        dashboard as "Synced X into Y" — a refresh of a row that did not exist
        until this run.

        The second feed hit is an MPN that already lives in ANOTHER category:
        no hijack, no event, no row — only the finish line's tally.
        """
        supplier, part1 = seeded_db["supplier1"], seeded_db["part1"]
        use_fake_provider(
            _FakeProvider(
                results_by_keyword={
                    "Sensors": [
                        _feed_part("NEW-1"),
                        _feed_part(part1.sku, manufacturer=part1.manufacturer_name),
                    ]
                }
            )
        )

        resp = _import(client, supplier, auth_header)

        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/x-ndjson")
        assert resp.headers["x-accel-buffering"] == "no"
        assert resp.headers["cache-control"] == "no-cache"

        events = _events(resp)
        assert [e["kind"] for e in events] == ["sync_started", "part_synced", "sync_finished"]
        assert events[1]["action"] == "created"
        assert events[1]["title"] == "NEW-1 — Feed Mfr"
        assert events[1]["detail"] == "Sensors"
        assert (
            events[-1]["detail"]
            == "1 created · 0 listings added · 0 already listed · 1 already elsewhere · 2 calls used"
        )
        assert events[-1]["counts"] == {
            "synced": 0,
            "media_filled": 0,
            "not_found": 0,
            "no_data": 0,
            "created": 1,
            "listing_added": 0,
        }

        # The WIRE said sync_started/sync_finished (one shape, one parser); the
        # ROWS say import_started/import_finished, because the table is the only
        # place the two runs can be told apart afterwards.
        assert sorted(r.kind for r in db.query(ActivityEvent).all()) == [
            "import_finished",
            "import_started",
            "part_imported",
        ]
        row = db.query(ActivityEvent).filter(ActivityEvent.kind == "part_imported").one()
        assert row.title == "NEW-1 — Feed Mfr"
        assert row.detail == "Sensors"
        assert row.image_url == "https://img.example/p.jpg"
        assert str(row.supplier_id) == str(supplier.id)

        # The catalog really grew, and the skipped MPN really stayed put.
        assert db.query(Part).filter(Part.sku == "NEW-1").one().category_id == empty_subcategory.id
        assert (
            db.query(Part).filter(Part.sku == part1.sku).one().category_id == seeded_db["child"].id
        )

    def test_a_part_this_supplier_already_lists_produces_no_event_at_all(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        """Import declines sync's work, and records nothing for it.

        This test used to assert the opposite, and its docstring said why:
        "an import that refreshes a part the category already holds did exactly
        what a sync does, and says so". That WAS the behaviour, and it was the
        bug — the owner reported Import New Parts syncing old items instead of
        creating new ones. A part `supplier1` already lists is sync's, so the
        import writes nothing, streams nothing and records nothing."""
        part1 = seeded_db["part1"]
        part1.image_url = "https://img.example/p.jpg"
        part1.datasheet_url = "https://docs.example/d.pdf"
        db.commit()
        use_fake_provider(
            _FakeProvider(
                results_by_keyword={
                    "Clock and Timing": [
                        _feed_part(part1.sku, manufacturer=part1.manufacturer_name)
                    ]
                }
            )
        )

        resp = _import(client, seeded_db["supplier1"], auth_header)

        assert [e["action"] for e in _events(resp) if e["kind"] == "part_synced"] == []
        assert [r.kind for r in db.query(ActivityEvent).all() if r.kind.startswith("part_")] == []

    def test_no_data_import_events_stream_but_are_never_recorded(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider
    ):
        """Found on the shelf, priced nothing, media already there — honest on
        the wire, and nothing worth claiming in the dashboard."""
        part1 = seeded_db["part1"]
        # NOT part1: `supplier1` already lists it, so import now declines it as
        # sync's territory before the no_data rail is reached. A part this
        # supplier does NOT list still gets there, and still must not be
        # recorded.
        unlisted = Part(
            id=uuid.uuid4(),
            sku="NODATA-ROUTE-1",
            slug="nodata-route-1",
            manufacturer_name=part1.manufacturer_name,
            category_id=part1.category_id,
            sub_slug=part1.sub_slug,
            image_url="https://cdn.example/original.jpg",
            datasheet_url="https://cdn.example/original.pdf",
            lead_time_days=7,
        )
        db.add(unlisted)
        db.commit()
        use_fake_provider(
            _FakeProvider(
                results_by_keyword={
                    "Clock and Timing": [
                        _feed_part(
                            "NODATA-ROUTE-1", manufacturer=part1.manufacturer_name, breaks=False
                        )
                    ]
                }
            )
        )

        resp = _import(client, seeded_db["supplier1"], auth_header)

        assert [e["action"] for e in _events(resp) if e["kind"] == "part_synced"] == ["no_data"]
        assert [r.kind for r in db.query(ActivityEvent).all()] == [
            "import_started",
            "import_finished",
        ]

    def test_an_abort_reports_the_created_parts_it_already_committed(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider, monkeypatch
    ):
        """`grow_catalog` handles FeedFatalError itself; anything else would
        raise mid-body and cut the NDJSON off with no ending. The counters must
        survive that — a run whose only product is `created` rows would
        otherwise report zeros above parts still on screen."""
        supplier = seeded_db["supplier1"]
        use_fake_provider(_FakeProvider())

        def _created_then_boom(
            db_, provider, supplier_, call_budget=200, per_category=50, continuous=False
        ):
            yield sync_event(
                "part_synced",
                str(supplier_.id),
                "NEW-1 — Feed Mfr",
                "Sensors",
                None,
                "created",
            )
            raise RuntimeError("Mouser API HTTP 500 on /search/keyword")

        monkeypatch.setattr("app.routes.suppliers.grow_catalog", _created_then_boom)

        events = _events(_import(client, supplier, auth_header))

        assert [e["kind"] for e in events] == ["part_synced", "sync_error", "sync_finished"]
        # An import that dies says so: "Sync failed" would name a run the
        # operator never started (the two buttons are side by side).
        assert events[1]["title"] == "Import failed"
        assert events[-1]["detail"] == "import aborted"
        assert events[-1]["counts"] == {
            "synced": 0,
            "media_filled": 0,
            "not_found": 0,
            "no_data": 0,
            "created": 1,
            "listing_added": 0,
        }
        assert [r.kind for r in db.query(ActivityEvent).all()] == [
            "part_imported",
            "sync_error",
            "import_finished",
        ]

    def test_calls_is_clamped_to_a_sane_window(
        self, client, seeded_db, auth_header, feed_key, use_fake_provider, monkeypatch
    ):
        """A budget of zero would sweep nothing and a huge one is an unbounded
        run against a rate-limited API — the number is a batch size, not a
        request the caller can get wrong, so it clamps rather than 422s."""
        use_fake_provider(_FakeProvider())
        seen = []

        def _record(db_, provider, supplier_, call_budget=200, per_category=50, continuous=False):
            seen.append(call_budget)
            return iter(())

        monkeypatch.setattr("app.routes.suppliers.grow_catalog", _record)

        supplier = seeded_db["supplier1"]
        _import(client, supplier, auth_header)
        _import(client, supplier, auth_header, calls=0)
        _import(client, supplier, auth_header, calls=-5)
        _import(client, supplier, auth_header, calls=99999)
        _import(client, supplier, auth_header, calls=10)

        assert seen == [200, 1, 1, 900, 10]


class TestImportContinuity:
    """Whether one Import click is ONE batch or a run that keeps going.

    The bound used to be the category list: one pass reads at most one page per
    subcategory, so the click stopped with most of its budget unspent and every
    shelf one page deeper. The supplier's own Auto-import switch now decides —
    read SERVER-SIDE, from `supplier_feeds.auto_import_enabled`.

    The switch and not a query parameter, deliberately: a URL is durable, and
    an unbounded spend against a rate-limited daily quota must not be something
    a bookmarked link can ask for. Flipping the switch is already gated on a
    provider plus a key, which is exactly the check a continuous run needs.
    """

    @pytest.fixture
    def recorder(self, monkeypatch):
        """Captures what the route asks `grow_catalog` for, and runs nothing."""
        seen: list[dict] = []

        def _record(db_, provider, supplier_, call_budget=200, per_category=50, continuous=False):
            seen.append({"call_budget": call_budget, "continuous": continuous})
            return iter(())

        monkeypatch.setattr("app.routes.suppliers.grow_catalog", _record)
        return seen

    def _switch_on(self, db, supplier):
        db.add(SupplierFeed(supplier_id=supplier.id, auto_import_enabled=True))
        db.commit()

    def test_auto_import_off_runs_one_bounded_batch(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider, recorder
    ):
        use_fake_provider(_FakeProvider())

        _import(client, seeded_db["supplier1"], auth_header)

        assert recorder == [{"call_budget": 200, "continuous": False}]

    def test_no_feed_row_at_all_is_off(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider, recorder
    ):
        """Most suppliers have never had a `supplier_feeds` row written. Absent
        must read as OFF, not as missing configuration to be guessed at."""
        supplier = seeded_db["supplier1"]
        assert db.query(SupplierFeed).filter_by(supplier_id=supplier.id).first() is None
        use_fake_provider(_FakeProvider())

        _import(client, supplier, auth_header)

        assert recorder == [{"call_budget": 200, "continuous": False}]

    def test_auto_import_on_runs_continuous_under_the_ceiling(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider, recorder
    ):
        supplier = seeded_db["supplier1"]
        self._switch_on(db, supplier)
        use_fake_provider(_FakeProvider())

        _import(client, supplier, auth_header)

        assert recorder == [{"call_budget": importer.CONTINUOUS_CALL_CEILING, "continuous": True}]

    def test_calls_cannot_buy_a_continuous_run(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider, recorder
    ):
        """The query string is not a lever on this. A huge `calls` still clamps
        to 900 and still runs ONE batch while the switch is off."""
        use_fake_provider(_FakeProvider())

        _import(client, seeded_db["supplier1"], auth_header, calls=99999)

        assert recorder == [{"call_budget": 900, "continuous": False}]

    def test_calls_is_ignored_when_the_switch_is_on(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider, recorder
    ):
        """The client keeps sending `calls=200` (no transport change was needed
        for this feature) — it must not shrink a continuous run to 200."""
        supplier = seeded_db["supplier1"]
        self._switch_on(db, supplier)
        use_fake_provider(_FakeProvider())

        _import(client, supplier, auth_header, calls=1)

        assert recorder == [{"call_budget": importer.CONTINUOUS_CALL_CEILING, "continuous": True}]

    def test_an_unknown_continuous_parameter_changes_nothing(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider, recorder
    ):
        """There is no such query parameter, and FastAPI ignores extras — so a
        caller asking for one gets the switch's answer, which is OFF here."""
        use_fake_provider(_FakeProvider())

        _import(client, seeded_db["supplier1"], auth_header, continuous="true")

        assert recorder == [{"call_budget": 200, "continuous": False}]

    def test_a_continuous_run_really_sweeps_the_shelf_deeper(
        self, client, db, seeded_db, auth_header, feed_key, use_fake_provider, empty_subcategory
    ):
        """End to end, no stub: one click, TWO pages off one shelf (the route
        asks for the default 50 a page, so 60 rows is two), and the wire
        contract unchanged. A single-pass run stops after the first page with
        4,950 of its calls unspent — that is the bug this closes."""
        supplier = seeded_db["supplier1"]
        self._switch_on(db, supplier)
        provider = use_fake_provider(
            _FakeProvider(
                results_by_keyword={"Sensors": [_feed_part(f"NEW-{i}") for i in range(60)]}
            )
        )

        resp = _import(client, supplier, auth_header)

        assert resp.status_code == 200
        events = _events(resp)
        assert [c[2] for c in provider.search_calls if c[0] == "Sensors"] == [0, 50]
        assert [e["kind"] for e in events].count("sync_started") == 1
        assert [e["kind"] for e in events].count("sync_finished") == 1
        assert sum(1 for e in events if e.get("action") == "created") == 60
        assert events[-1]["counts"]["created"] == 60
        assert events[-1]["detail"].endswith("· 2 sweeps")
        assert db.query(Part).filter(Part.sku.like("NEW-%")).count() == 60


class TestRecorderLabels:
    """`record_stream_event`'s optional label table, at unit level.

    The routes above exercise it end to end; these pin the two properties that
    make it safe to hand the same recorder to the nightly job: it relabels only
    what it is asked to, and it never touches the event the caller is about to
    put on the wire.
    """

    def test_the_import_table_relabels_only_the_run_level_kinds(self, db, seeded_db):
        supplier = seeded_db["supplier1"]
        for kind in ("sync_started", "sync_finished", "sync_error"):
            record_stream_event(
                db, supplier.id, sync_event(kind, str(supplier.id), "Avnet"), IMPORT_EVENT_KINDS
            )

        assert [r.kind for r in db.query(ActivityEvent).all()] == [
            "import_started",
            "import_finished",
            # untouched: nothing renders it, so relabelling it would only add a
            # kind with no template behind it
            "sync_error",
        ]

    def test_part_rows_keep_their_action_derived_kinds_under_the_import_table(self, db, seeded_db):
        """The override is applied AFTER the action mapping, and the import
        table names no part kind — so `created` still lands as `part_imported`
        and a refresh still lands as `part_synced`."""
        supplier = seeded_db["supplier1"]
        for action in ("created", "updated", "not_found"):
            record_stream_event(
                db,
                supplier.id,
                sync_event("part_synced", str(supplier.id), "NEW-1 — Feed Mfr", action=action),
                IMPORT_EVENT_KINDS,
            )

        # `not_found` wrote nothing, so it is still not a row.
        assert [r.kind for r in db.query(ActivityEvent).all()] == ["part_imported", "part_synced"]

    def test_the_event_dict_is_never_mutated(self, db, seeded_db):
        """The caller serializes this same dict to NDJSON right afterwards. A
        recorder that rewrote `kind` in place would change the wire shape the
        console parses — which is the one thing the label override exists to
        avoid."""
        supplier = seeded_db["supplier1"]
        event = sync_event("sync_finished", str(supplier.id), "Avnet", "1 created")

        record_stream_event(db, supplier.id, event, IMPORT_EVENT_KINDS)

        assert event["kind"] == "sync_finished"
        assert db.query(ActivityEvent).one().kind == "import_finished"


class TestProviderRegistry:
    def test_a_mouser_supplier_matches_the_mouser_provider(self, feed_key):
        """The SLUG comes back too, not just the class: it is what the route
        resolves the key for, so a match that lost it would send this
        distributor's credential to the next one added."""
        from app.services.part_feed.mouser import MouserProvider

        supplier = Supplier(id=uuid.uuid4(), name="Mouser", website="mouser.com")
        assert match_provider(supplier) == ("mouser", MouserProvider)

    def test_matching_tolerates_scheme_case_and_subdomain(self, feed_key):
        for website in ("https://WWW.Mouser.com/", "eu.mouser.com", "MOUSER.COM"):
            supplier = Supplier(id=uuid.uuid4(), name="Mouser", website=website)
            assert match_provider(supplier) is not None, website

    def test_unknown_or_missing_website_matches_nothing(self, feed_key):
        for website in ("avnet.com", "", None):
            supplier = Supplier(id=uuid.uuid4(), name="Other", website=website)
            assert match_provider(supplier) is None, website

    def test_matching_never_constructs_so_the_key_check_can_come_first(self, monkeypatch):
        """Construction is what demands the key. Matching stays free of it, which
        is what lets the route answer 404 rather than leak the constructor's
        RuntimeError as a 500 — see TestGuards."""
        monkeypatch.setattr(settings, "MOUSER_API_KEY", None)
        supplier = Supplier(id=uuid.uuid4(), name="Mouser", website="mouser.com")

        slug, provider_cls = match_provider(supplier)

        assert slug == "mouser"
        with pytest.raises(RuntimeError):
            provider_cls()

    def test_an_explicit_key_builds_the_provider_with_no_environment_key(self, monkeypatch):
        """The admin-stored key path: nothing is in the environment and the
        provider is still constructible, because the caller brought the key."""
        from app.services.part_feed.mouser import MouserProvider

        monkeypatch.setattr(settings, "MOUSER_API_KEY", None)
        supplier = Supplier(id=uuid.uuid4(), name="Mouser", website="mouser.com")

        _slug, provider_cls = match_provider(supplier)
        provider = provider_cls(api_key=DB_KEY)

        assert isinstance(provider, MouserProvider)
        assert provider.api_key == DB_KEY

    def test_get_feed_key_prefers_the_stored_row_over_the_environment(self, db, feed_key):
        assert get_feed_key(db) == FAKE_KEY

        db.add(ProviderCredential(provider="mouser", api_key=DB_KEY))
        db.commit()

        assert get_feed_key(db) == DB_KEY

    def test_feed_configured_is_the_same_question_as_a_key_being_resolvable(self, db, monkeypatch):
        monkeypatch.setattr(settings, "MOUSER_API_KEY", None)
        assert feed_configured(db) is False

        db.add(ProviderCredential(provider="mouser", api_key=DB_KEY))
        db.commit()

        assert feed_configured(db) is True

    def test_a_provider_with_no_environment_variable_has_no_fallback(self, db, feed_key):
        """MOUSER_API_KEY is Mouser's. A second distributor gets a stored row or
        nothing — it must never inherit another company's key."""
        assert get_feed_key(db, "digikey") is None
