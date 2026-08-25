"""The nightly catalog import — `app.jobs.feed_import_daily`.

Nobody watches this run. There is no socket, no console, no 200 to read: an
operator flips a switch on a supplier and then only ever sees the ROWS the job
left behind. So the contracts pinned here are the ones whose failure would be
silent for weeks.

1. **The toggle stores INTENT; capability is re-derived every night.** Enabled
   is necessary and not sufficient — a supplier whose website no longer matches
   a provider, or whose key has been rotated away, is skipped with a log line
   and its switch is left alone. `routes/suppliers.update_feed_settings` refuses
   to ENABLE without a key but always allows disabling for the same reason:
   capability changes after the click.
2. **One budget for the night, split evenly, capped globally.** Spend is read
   off the provider's own counter after each supplier, so a run that overshoots
   its slice cannot borrow the next supplier's, and the tail that the budget
   cannot pay for is skipped OUT LOUD (`stopped_early`) rather than quietly.
3. **A quota wall ends the night; anything else ends one supplier.** The quota
   belongs to the KEY, which is account-wide. `grow_catalog` converts
   FeedFatalError into a `sync_error` EVENT and returns normally, so the event
   is the wall's only signal on that path — a job that only watched for the
   exception would keep spending refused calls against every other supplier.
4. **The run is filed under the IMPORT labels.** `import_started` /
   `import_finished`, never `sync_*`: these rows are the only place a nightly
   run is visible, and the dashboard has nothing else to tell the two jobs
   apart (`activity_events` has no mode column).
5. **The schedule is a clock BOUNDARY.** `seconds_until_hour` is pure and
   tested directly, because the loop that consumes it cannot be — and a job
   that slept a fixed 24h would walk its run time across the day with every
   redeploy, eventually competing with the operator's own clicks for one quota.
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy.exc import ProgrammingError

from app.config import settings
from app.jobs import feed_import_daily as job
from app.models import ActivityEvent, Category, Part, ProviderCredential, SupplierFeed
from app.services.part_feed.mouser import FeedFatalError
from tests.feed_helpers import FakeProvider
from tests.feed_helpers import feed_part as _feed_part

ENV_KEY = "nightly-feed-key-not-real-8d21"  # never a real credential
NOW = datetime(2026, 8, 18, 6, 0, 0, tzinfo=UTC)


# ── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def env_key(monkeypatch):
    """The provider key is present. Nothing here ever calls Mouser."""
    monkeypatch.setattr(settings, "MOUSER_API_KEY", ENV_KEY)


@pytest.fixture
def no_env_key(monkeypatch):
    """No environment fallback — and no stored row either, in these tests."""
    monkeypatch.setattr(settings, "MOUSER_API_KEY", None)


@pytest.fixture
def budget(monkeypatch):
    """Set the night's call budget for one test."""

    def _set(calls: int):
        monkeypatch.setattr(settings, "FEED_IMPORT_CALL_BUDGET", calls)

    return _set


@pytest.fixture
def enable(db):
    """Switch the nightly import ON for a supplier (what the admin toggle does).

    Writes the row DIRECTLY rather than through the route: half these tests are
    about a supplier whose feed stopped being runnable AFTER the switch was
    flipped, which the route would refuse to set up.
    """

    def _enable(supplier, enabled: bool = True):
        row = db.query(SupplierFeed).filter(SupplierFeed.supplier_id == supplier.id).first()
        if row is None:
            row = SupplierFeed(supplier_id=supplier.id)
            db.add(row)
        row.auto_import_enabled = enabled
        db.commit()
        return row

    return _enable


@pytest.fixture
def mouser_supplier(db, seeded_db, enable):
    """Avnet's row, pointed at a website the registry actually covers."""
    supplier = seeded_db["supplier1"]
    supplier.website = "https://www.mouser.com/"
    db.commit()
    enable(supplier)
    return supplier


@pytest.fixture
def second_mouser_supplier(db, seeded_db, enable):
    supplier = seeded_db["supplier2"]
    supplier.website = "mouser.com"
    db.commit()
    enable(supplier)
    return supplier


@pytest.fixture
def empty_subcategory(db, seeded_db):
    """An EMPTY shelf, which is where a thin-first sweep starts."""
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


class _Providers:
    """Hands each supplier its own scripted provider, and records the traffic.

    `match_provider` returns a (slug, CLASS) pair and the job builds it with the
    key resolved for THAT slug, so the stand-in has to hand back a class — a
    fake returning an instance would pass here while the real job unpacked a
    tuple. `seen_keys` records what each constructor was given (how the tests
    check a key was actually resolved rather than None shipped), and `closed`
    records the release, which nothing else can observe.
    """

    def __init__(self, monkeypatch):
        self.by_supplier: dict[str, FakeProvider] = {}
        self.seen_keys: list[str | None] = []
        self.closed: list[str] = []
        monkeypatch.setattr(job, "match_provider", self._match)

    def __call__(self, supplier, provider, slug: str = "mouser"):
        name = supplier.name
        self.by_supplier[name] = (provider, slug)
        provider.close = lambda name=name: self.closed.append(name)
        return provider

    def _match(self, supplier):
        entry = self.by_supplier.get(supplier.name)
        if entry is None:
            return None
        target, slug = entry
        recorder = self.seen_keys

        class _Scripted:
            @classmethod
            def from_credential(cls, key):
                return cls(api_key=key)

            def __new__(cls, api_key=None):
                recorder.append(api_key)
                return target

        return slug, _Scripted


@pytest.fixture
def providers(monkeypatch):
    return _Providers(monkeypatch)


def _kinds(db):
    """Every activity row, in the order it was written.

    NOT ordered by `created_at`: it is a `server_default=func.now()` column and
    SQLite's CURRENT_TIMESTAMP has one-second resolution, so a whole run shares
    one value and an ORDER BY would shuffle it. Insertion order is what SQLite
    returns unordered, and it is the order under test.
    """
    return [row.kind for row in db.query(ActivityEvent).all()]


# ── The schedule (pure) ─────────────────────────────────────────────────────


class TestHourBoundary:
    """`seconds_until_hour` is the entire schedule, and the only part of the
    loop a test can reach."""

    def test_sleeps_until_this_morning_when_the_hour_is_still_ahead(self):
        now = datetime(2026, 8, 18, 3, 0, 0, tzinfo=UTC)
        assert job.seconds_until_hour(6, now) == 3 * 3600

    def test_sleeps_until_tomorrow_once_the_hour_has_passed(self):
        now = datetime(2026, 8, 18, 7, 30, 0, tzinfo=UTC)
        assert job.seconds_until_hour(6, now) == 22.5 * 3600

    def test_landing_exactly_on_the_boundary_waits_a_full_day(self):
        """Otherwise a pass that finished inside its own minute would start a
        second one — two nightly imports, one night, one quota."""
        assert job.seconds_until_hour(6, datetime(2026, 8, 18, 6, 0, 0, tzinfo=UTC)) == 24 * 3600

    def test_partial_minutes_are_carried(self):
        now = datetime(2026, 8, 18, 5, 59, 30, tzinfo=UTC)
        assert job.seconds_until_hour(6, now) == 30

    @pytest.mark.parametrize("hour,expected_hour", [(-5, 0), (99, 23), (0, 0), (23, 23)])
    def test_an_out_of_range_hour_clamps_instead_of_crashing(self, hour, expected_hour):
        """A typo in the .env must not make the container crash-loop — it is
        the one config value nobody validates before the job reads it."""
        now = datetime(2026, 8, 18, 12, 0, 0, tzinfo=UTC)
        seconds = job.seconds_until_hour(hour, now)
        landed = now.timestamp() + seconds
        assert datetime.fromtimestamp(landed, UTC).hour == expected_hour


# ── Selection ───────────────────────────────────────────────────────────────


class TestSelection:
    def test_only_enabled_suppliers_run(
        self, db, seeded_db, env_key, providers, mouser_supplier, second_mouser_supplier, enable
    ):
        """The second supplier matches a provider and has the same key — the
        ONLY thing keeping it out of the night is its switch."""
        enable(second_mouser_supplier, False)
        providers(mouser_supplier, FakeProvider())

        stats = job.run_once(db, NOW)

        assert stats["suppliers"] == 1
        started = db.query(ActivityEvent).filter(ActivityEvent.kind == "import_started").all()
        assert [str(row.supplier_id) for row in started] == [str(mouser_supplier.id)]

    def test_a_supplier_with_no_feed_row_is_never_run(self, db, seeded_db, env_key, providers):
        """`supplier_feeds` is opt-in: no row means no nightly import, and the
        seeded catalog is nothing but rows without one."""
        assert job.run_once(db, NOW)["suppliers"] == 0
        assert db.query(ActivityEvent).count() == 0

    def test_a_supplier_whose_provider_no_longer_matches_is_skipped(
        self, db, seeded_db, enable, env_key
    ):
        """The run-time re-check. The switch was legitimately enabled once;
        someone then edited the website. Skipped, not crashed — and the switch
        is NOT flipped off behind the operator's back.
        """
        supplier = seeded_db["supplier1"]
        supplier.website = "https://kennedy-electronics.example/"
        db.commit()
        row = enable(supplier)

        stats = job.run_once(db, NOW)

        assert stats["suppliers"] == 0
        assert db.query(ActivityEvent).count() == 0
        db.refresh(row)
        assert row.auto_import_enabled is True
        assert row.last_synced_at is None

    def test_a_supplier_whose_key_vanished_is_skipped(
        self, db, seeded_db, mouser_supplier, no_env_key
    ):
        """Enabling required a key; nothing keeps one present afterwards. A
        rotated-away credential is an operator's decision, not an error."""
        stats = job.run_once(db, NOW)

        assert stats["suppliers"] == 0
        assert db.query(ActivityEvent).count() == 0

    def test_a_stored_credential_is_enough_without_any_environment_key(
        self, db, seeded_db, mouser_supplier, no_env_key, providers, empty_subcategory
    ):
        """Key precedence is `get_feed_key`'s, not this job's: the Admin →
        Settings row answers first and the environment is only a fallback, so a
        box configured entirely through the admin card still runs at night."""
        db.add(ProviderCredential(provider="mouser", api_key="stored-key-not-real-4a19"))
        db.commit()
        providers(mouser_supplier, FakeProvider())

        assert job.run_once(db, NOW)["suppliers"] == 1
        assert providers.seen_keys == ["stored-key-not-real-4a19"]

    def test_the_resolved_key_is_what_the_provider_is_built_with(
        self, db, seeded_db, mouser_supplier, env_key, providers
    ):
        providers(mouser_supplier, FakeProvider())
        job.run_once(db, NOW)
        assert providers.seen_keys == [ENV_KEY]


# ── Budget ──────────────────────────────────────────────────────────────────


class _Recorder:
    """Stands in for `grow_catalog`: records the budget it was handed and
    charges the provider for it, without importing anything."""

    def __init__(self, spend_per_supplier: int = 0):
        self.budgets: list[int] = []
        # Whether each call asked for a CONTINUOUS run. Recorded because the
        # nightly must never ask for one — see `TestNightlyIsNeverContinuous`.
        self.continuous: list[bool] = []
        self.spend = spend_per_supplier

    def __call__(self, db, provider, supplier, call_budget, per_category=50, continuous=False):
        self.budgets.append(call_budget)
        self.continuous.append(continuous)
        provider.calls_made += self.spend
        return iter(())


class TestBudget:
    def test_the_night_is_split_evenly_across_eligible_suppliers(
        self,
        db,
        seeded_db,
        env_key,
        budget,
        providers,
        mouser_supplier,
        second_mouser_supplier,
        monkeypatch,
    ):
        budget(850)
        providers(mouser_supplier, FakeProvider())
        providers(second_mouser_supplier, FakeProvider())
        recorder = _Recorder()
        monkeypatch.setattr(job, "grow_catalog", recorder)

        job.run_once(db, NOW)

        assert recorder.budgets == [425, 425]

    def test_one_supplier_gets_the_whole_budget(
        self, db, seeded_db, env_key, budget, providers, mouser_supplier, monkeypatch
    ):
        budget(850)
        providers(mouser_supplier, FakeProvider())
        recorder = _Recorder()
        monkeypatch.setattr(job, "grow_catalog", recorder)

        job.run_once(db, NOW)

        assert recorder.budgets == [850]

    def test_the_tail_is_skipped_out_loud_when_the_budget_runs_out(
        self,
        db,
        seeded_db,
        env_key,
        budget,
        providers,
        mouser_supplier,
        second_mouser_supplier,
        monkeypatch,
    ):
        """Two suppliers, ONE call between them, and each run spends its whole
        slice. The second must not run on borrowed quota — and the summary has
        to say the night was cut short, or a half-covered catalog looks like a
        complete one.
        """
        budget(1)
        providers(mouser_supplier, FakeProvider())
        providers(second_mouser_supplier, FakeProvider())
        recorder = _Recorder(spend_per_supplier=1)
        monkeypatch.setattr(job, "grow_catalog", recorder)

        stats = job.run_once(db, NOW)

        assert recorder.budgets == [1]
        assert stats["suppliers"] == 1
        assert stats["stopped_early"] is True

    def test_spend_is_measured_on_the_provider_not_on_the_slice(
        self,
        db,
        seeded_db,
        env_key,
        budget,
        providers,
        mouser_supplier,
        second_mouser_supplier,
        monkeypatch,
    ):
        """A run that costs less than its slice leaves the change on the table
        for the next supplier — the cap is the TOTAL, not the sum of slices."""
        budget(10)
        providers(mouser_supplier, FakeProvider())
        providers(second_mouser_supplier, FakeProvider())
        recorder = _Recorder(spend_per_supplier=1)
        monkeypatch.setattr(job, "grow_catalog", recorder)

        stats = job.run_once(db, NOW)

        assert recorder.budgets == [5, 5]
        assert stats["calls"] == 2
        assert stats["stopped_early"] is False


# ── What a run leaves behind ────────────────────────────────────────────────


class TestRecordedRun:
    def test_a_nightly_import_files_itself_under_the_import_labels(
        self, db, seeded_db, env_key, budget, providers, mouser_supplier, empty_subcategory
    ):
        """The whole point of the label override. These rows are the ONLY trace
        of a run nobody watched, and `activity_events` has no mode column — a
        `sync_finished` row here would tell the dashboard a nightly import was
        an inventory refresh.
        """
        budget(2)
        providers(
            mouser_supplier, FakeProvider(results_by_keyword={"Sensors": [_feed_part("NEW-1")]})
        )

        stats = job.run_once(db, NOW)

        assert _kinds(db) == ["import_started", "part_imported", "import_finished"]
        assert "sync_started" not in _kinds(db)
        assert "sync_finished" not in _kinds(db)
        assert stats["created"] == 1
        # The catalog really grew, on the emptiest shelf.
        assert db.query(Part).filter(Part.sku == "NEW-1").one().category_id == empty_subcategory.id

    def test_the_finish_line_carries_the_counts_sentence(
        self, db, seeded_db, env_key, budget, providers, mouser_supplier, empty_subcategory
    ):
        """`import_finished.detail` is what the dashboard renders as
        "Inventory import — …"; blank it and the strip says nothing."""
        budget(2)
        providers(
            mouser_supplier, FakeProvider(results_by_keyword={"Sensors": [_feed_part("NEW-1")]})
        )

        job.run_once(db, NOW)

        finished = db.query(ActivityEvent).filter(ActivityEvent.kind == "import_finished").one()
        assert finished.detail.startswith("1 created · 0 listings added")
        assert str(finished.supplier_id) == str(mouser_supplier.id)

    def test_last_synced_at_is_stamped_with_the_passed_clock(
        self, db, seeded_db, env_key, budget, providers, mouser_supplier, empty_subcategory
    ):
        budget(2)
        providers(mouser_supplier, FakeProvider())

        job.run_once(db, NOW)

        row = db.query(SupplierFeed).filter(SupplierFeed.supplier_id == mouser_supplier.id).one()
        stamped = row.last_synced_at
        # SQLite hands back a naive datetime for TIMESTAMPTZ.
        assert stamped.replace(tzinfo=UTC) == NOW

    def test_a_supplier_that_was_skipped_is_never_stamped(
        self, db, seeded_db, mouser_supplier, no_env_key
    ):
        """`last_synced_at` answers "when did we last spend calls here". A
        supplier the night never reached spent none."""
        job.run_once(db, NOW)
        row = db.query(SupplierFeed).filter(SupplierFeed.supplier_id == mouser_supplier.id).one()
        assert row.last_synced_at is None

    def test_the_provider_is_released_after_each_supplier(
        self, db, seeded_db, env_key, budget, providers, mouser_supplier
    ):
        """One provider (and one HTTP pool) per supplier — an unclosed pool per
        night is a socket leak in a container that never restarts."""
        budget(2)
        providers(mouser_supplier, FakeProvider())
        job.run_once(db, NOW)
        assert providers.closed == [mouser_supplier.name]


# ── Failure ─────────────────────────────────────────────────────────────────


class _FatalProvider(FakeProvider):
    """Hits the quota wall on its first search — the way a spent free tier
    answers every caller for the rest of the day."""

    def search(self, keyword, limit=50, start_at=0):
        self.calls_made += 1
        raise FeedFatalError("Mouser API HTTP 429 on /search/keyword")


class _BrokenProvider(FakeProvider):
    """A NON-fatal failure: one bad response, one supplier's problem."""

    def search(self, keyword, limit=50, start_at=0):
        self.calls_made += 1
        raise RuntimeError("Mouser API HTTP 500 on /search/keyword")


class TestFailure:
    def test_a_quota_wall_stops_the_whole_night(
        self, db, seeded_db, env_key, budget, providers, mouser_supplier, second_mouser_supplier
    ):
        """The quota belongs to the KEY, so the second supplier would spend
        real requests to be refused identically.

        Note WHERE the wall shows up: `grow_catalog` catches FeedFatalError and
        turns it into a `sync_error` event, returning normally — a job watching
        only for the exception would sail past it and keep going.
        """
        budget(10)
        providers(mouser_supplier, _FatalProvider())
        providers(second_mouser_supplier, FakeProvider())

        stats = job.run_once(db, NOW)

        assert stats["suppliers"] == 1
        assert stats["stopped_early"] is True
        assert stats["errors"] == 1
        assert _kinds(db) == ["import_started", "sync_error", "import_finished"]
        # The one supplier that ran is stamped; the one that never started is not.
        stamps = {str(row.supplier_id): row.last_synced_at for row in db.query(SupplierFeed).all()}
        assert stamps[str(mouser_supplier.id)] is not None
        assert stamps[str(second_mouser_supplier.id)] is None

    def test_any_other_error_costs_one_supplier_and_the_night_continues(
        self,
        db,
        seeded_db,
        env_key,
        budget,
        providers,
        mouser_supplier,
        second_mouser_supplier,
        empty_subcategory,
    ):
        """A job that dies on the third of eight suppliers stops importing for
        the other five, and says nothing about it until someone notices the
        catalog stopped growing."""
        budget(10)
        providers(mouser_supplier, _BrokenProvider())
        providers(
            second_mouser_supplier,
            FakeProvider(results_by_keyword={"Sensors": [_feed_part("NEW-1")]}),
        )

        stats = job.run_once(db, NOW)

        assert stats["suppliers"] == 2
        assert stats["errors"] == 1
        assert stats["created"] == 1
        assert stats["stopped_early"] is False
        # The healthy supplier's run is intact — the broken one's rollback did
        # not take the other's rows with it.
        assert db.query(ActivityEvent).filter(ActivityEvent.kind == "part_imported").count() == 1
        assert db.query(Part).filter(Part.sku == "NEW-1").count() == 1

    def test_an_unmigrated_schema_is_one_warning_and_a_skipped_pass(
        self, db, seeded_db, monkeypatch, caplog
    ):
        """`alembic upgrade head` runs in the api container's entrypoint and
        nothing orders this loop after it. A traceback on a nightly timer is
        how a container's logs become noise nobody reads."""

        def _boom(_db):
            raise ProgrammingError(
                "SELECT ...", {}, Exception('relation "supplier_feeds" does not exist')
            )

        monkeypatch.setattr(job, "_eligible", _boom)

        stats = job.run_once(db, NOW)

        assert stats["suppliers"] == 0
        assert "not migrated" in caplog.text

    def test_an_unrelated_programming_error_still_raises(self, db, seeded_db, monkeypatch):
        """Only the missing-table case is tolerated. Swallowing every
        ProgrammingError would hide a genuine query bug forever — the job has
        no other reader."""

        def _boom(_db):
            raise ProgrammingError("SELECT ...", {}, Exception("syntax error at or near"))

        monkeypatch.setattr(job, "_eligible", _boom)

        with pytest.raises(ProgrammingError):
            job.run_once(db, NOW)


class TestNightlyIsNeverContinuous:
    """The interactive Import click on an auto-import supplier runs CONTINUOUS
    — sweep after sweep until the feed is exhausted or its quota walls it. The
    nightly job must not, and this is the drift guard for that decision.

    `auto_import_enabled` means "run until the well is dry", and the nightly's
    even slice of `FEED_IMPORT_CALL_BUDGET` is that meaning's unattended
    FAIRNESS cap: the budget is one shared account-wide daily quota split
    across every enabled supplier, and letting the alphabetically-first one run
    until the well is dry would starve every supplier after it — and the
    operator's own clicks the next day.
    """

    def test_the_night_asks_for_a_bounded_slice_and_never_continuous(
        self,
        db,
        seeded_db,
        env_key,
        budget,
        providers,
        mouser_supplier,
        second_mouser_supplier,
        monkeypatch,
    ):
        budget(850)
        providers(mouser_supplier, FakeProvider())
        providers(second_mouser_supplier, FakeProvider())
        recorder = _Recorder()
        monkeypatch.setattr(job, "grow_catalog", recorder)

        job.run_once(db, NOW)

        assert recorder.budgets == [425, 425]
        assert recorder.continuous == [False, False]

    def test_the_switch_being_on_is_what_SELECTS_a_supplier_here_nothing_more(
        self, db, seeded_db, env_key, budget, providers, mouser_supplier, monkeypatch
    ):
        """Every supplier the night runs has the switch ON by definition (it is
        the selection query). That must still not turn into a continuous run —
        otherwise one enabled supplier could spend the whole night's quota."""
        budget(850)
        providers(mouser_supplier, FakeProvider())
        recorder = _Recorder()
        monkeypatch.setattr(job, "grow_catalog", recorder)

        job.run_once(db, NOW)

        assert recorder.continuous == [False]
        assert recorder.budgets == [850]
        assert all(b <= 850 for b in recorder.budgets)


class TestOneProvidersWallDoesNotCancelAnothersNight:
    """A quota wall retires ONE provider, not the whole night.

    `if result["fatal"]: break` was correct when every supplier shared one key —
    the comment still says "the quota belongs to the KEY". Per-provider budgets
    made it wrong, and the ordering makes it bite every time: `_eligible` sorts
    by `Supplier.name`, so "Digi-Key Electronics" always runs before "Mouser
    Electronics", and Digi-Key's wall silently cancels Mouser's pass.

    Digi-Key's 1,000/day is shared between the 850 nightly budget, the BOM
    resolve path (which reaches it FIRST — `pick_feed_source` also orders by
    name) and interactive admin clicks, so hitting the wall is ordinary rather
    than exceptional. A rotated or expired secret makes it permanent: the token
    mint 401s, every night, and Mouser is starved indefinitely while
    `_eligible` sees a key PRESENT and reports nothing wrong.

    The failure is silent by construction — no error, just a night that did not
    happen. Which is the property that makes it worth a test rather than a
    comment.
    """

    def test_the_second_providers_supplier_still_runs(
        self, db, seeded_db, env_key, budget, providers, monkeypatch, enable
    ):
        from app.models import Supplier

        budget(850)
        monkeypatch.setattr(job.settings, "DIGIKEY_CLIENT_ID", "id", raising=False)
        monkeypatch.setattr(job.settings, "DIGIKEY_CLIENT_SECRET", "secret", raising=False)

        # Named so Digi-Key sorts FIRST, which is the real ordering.
        dk = Supplier(id=uuid.uuid4(), name="Digi-Key Electronics", website="digikey.com")
        mo = Supplier(id=uuid.uuid4(), name="Mouser Electronics 2", website="mouser.com")
        db.add_all([dk, mo])
        db.commit()
        enable(dk)
        enable(mo)
        providers(dk, FakeProvider(), slug="digikey")
        providers(mo, FakeProvider(), slug="mouser")

        ran: list[str] = []

        def _walls_for_digikey(db_, provider, supplier, call_budget, **kw):
            ran.append(supplier.name)
            if supplier.name.startswith("Digi-Key"):
                raise FeedFatalError("quota exceeded")
            return iter(())

        monkeypatch.setattr(job, "grow_catalog", _walls_for_digikey)

        stats = job.run_once(db, NOW)

        assert "Mouser Electronics 2" in ran, (
            "Digi-Key's quota wall cancelled Mouser's night — one provider's "
            f"budget is not the other's. Suppliers reached: {ran}"
        )
        assert stats["suppliers"] >= 1

    def test_the_walled_providers_own_other_suppliers_are_still_retired(
        self, db, seeded_db, env_key, budget, providers, monkeypatch, enable
    ):
        """The half worth keeping from the old `break`: once a provider has
        walled, its REMAINING suppliers must not each spend a call to be
        refused identically."""
        from app.models import Supplier

        budget(850)
        a = Supplier(id=uuid.uuid4(), name="Aaa Mouser Shop", website="mouser.com")
        b = Supplier(id=uuid.uuid4(), name="Bbb Mouser Shop", website="mouser.com")
        db.add_all([a, b])
        db.commit()
        enable(a)
        enable(b)
        providers(a, FakeProvider(), slug="mouser")
        providers(b, FakeProvider(), slug="mouser")

        ran: list[str] = []

        def _always_walls(db_, provider, supplier, call_budget, **kw):
            ran.append(supplier.name)
            raise FeedFatalError("quota exceeded")

        monkeypatch.setattr(job, "grow_catalog", _always_walls)
        job.run_once(db, NOW)

        assert ran == ["Aaa Mouser Shop"], (
            "after one supplier hit the wall on this provider's key, another on "
            f"the SAME provider still spent a call to be refused: {ran}"
        )
