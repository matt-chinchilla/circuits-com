"""POST /api/suppliers/{id}/sync — the live NDJSON sync stream.

The admin clicks "Sync inventory" on a supplier and watches the parts go by.
The route is the thin part: it decides WHETHER a sync may run, then hands the
socket to `sync_supplier_listings` (which owns the actual import) and writes an
ActivityEvent per event on the way past.

Three contracts are pinned here because nothing else would notice them break:

1. **Order of refusal.** Matching runs first — it is what separates 409
   `no_feed_for_supplier` from a missing key — but the provider is never
   CONSTRUCTED until its OWN key is in hand. The Mouser provider's constructor
   raises without one, so building first would turn "sync is not configured"
   into a 500 instead of a 404.
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
from decimal import Decimal

import bcrypt
import pytest

from app.config import settings
from app.models import ActivityEvent, PartListing, ProviderCredential, Supplier, User
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

    def test_missing_key_404s_before_the_provider_is_built(
        self, client, db, seeded_db, auth_header, monkeypatch
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

        resp = _sync(client, supplier, auth_header)

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
            "created": 0,
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
            _ExplodingProvider(by_mpn={part1.sku: _feed_part(part1.sku)}, explode_after=1)
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
