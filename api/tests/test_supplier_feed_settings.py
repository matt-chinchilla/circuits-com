"""Per-supplier feed settings — the `supplier_feeds` row and its two endpoints.

`GET/PATCH /api/suppliers/{id}/feed-settings` is what the admin's "Nightly
auto-import" switch reads and writes, and what the nightly job's selection query
will later read. Five contracts are pinned here because nothing else would
notice them break:

1. **Enabling requires a feed that could actually run.** A supplier with no
   provider match, or a provider with no key anywhere, gets **409
   `feed_not_configured`** — a switch that turns on a job which can never do
   anything is a lie told to the operator every night. DISABLING is always
   allowed: an off switch must work even after the key it depended on is gone.
2. **No secret is ever in a response.** The table carries `api_key` and
   `feed_url` (schema-only this phase — the partner-feed work uses them), and
   `key_configured` describes the PROVIDER key from Settings/env, never this
   column. Both assertions run against `resp.text`, not the parsed body, so a
   leak through an unexpected field or an error detail would still fail.
3. **Auth.** Admin session on both verbs; the demo account keeps its READ (the
   card has to render for a prospect, and the payload has nothing to withhold)
   and is refused the PATCH by the global demo read-only gate.
4. **Deleting a supplier removes its feed row.** This is the 8th cascade
   surface. Settings are dependents, not history — unlike ActivityEvent, which
   the same route NULLs — and the FK carries no ON DELETE CASCADE, so a
   forgotten step is a foreign-key violation (the suite runs SQLite with
   `PRAGMA foreign_keys=ON`), i.e. a 500 on a route that used to work.
5. **The migration matches the model.** The suite builds tables with
   `Base.metadata.create_all` and never runs alembic, so a column added to the
   model and forgotten in 032 passes everything else here and is then missing in
   production. Reading 032's SQL is what makes that drift visible — same reason
   `test_activity_events.py` reads 030.

Length contracts are asserted on METADATA rather than by inserting oversized
data: SQLite ignores `String(N)` entirely (CLAUDE.md).
"""

import re
import uuid
from pathlib import Path

import bcrypt
import pytest
from sqlalchemy import JSON, Text

from app.config import settings
from app.models import ProviderCredential, Supplier, SupplierFeed, User

MIGRATION = (
    Path(__file__).resolve().parents[1] / "alembic" / "versions" / "032_supplier_feeds.py"
).read_text()
MIGRATION_033 = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "033_supplier_feed_import_cursor.py"
).read_text()

# What 032 CREATEs. Columns added by a later migration go in ADDED_COLUMNS —
# the two together are asserted to be the whole model, so a column added to
# the model and forgotten in every migration fails here rather than in prod.
COLUMNS = {
    "supplier_id",
    "feed_url",
    "api_key",
    "auto_import_enabled",
    "last_synced_at",
    "updated_at",
}
ADDED_COLUMNS = {"import_cursor"}  # 033

# Fake credentials — nothing here ever reaches Mouser. Distinctive strings so a
# leak assertion (`KEY not in resp.text`) can only fail on a real leak.
ENV_KEY = "env-feed-key-not-real-4b8e"
DB_KEY = "db-stored-feed-key-not-real-9f3a"
ROW_KEY = "supplier-row-feed-key-not-real-7c21"
DEMO_EMAIL = "demo@circuitcenter.ai"


def _path(supplier_id) -> str:
    return f"/api/suppliers/{supplier_id}/feed-settings"


@pytest.fixture
def env_key(monkeypatch):
    """The provider key is present in the environment."""
    monkeypatch.setattr(settings, "MOUSER_API_KEY", ENV_KEY)


@pytest.fixture
def no_env_key(monkeypatch):
    """No environment fallback — the DB row is the only possible source."""
    monkeypatch.setattr(settings, "MOUSER_API_KEY", None)


@pytest.fixture
def feed_supplier(db, seeded_db):
    """A supplier the registry actually covers.

    Matching is keyed on the WEBSITE fragment, so a full URL is used here on
    purpose — it is what an admin pastes, and it must resolve the same as a bare
    domain.
    """
    supplier = seeded_db["supplier1"]
    supplier.website = "https://www.mouser.com/"
    db.commit()
    return supplier


@pytest.fixture
def plain_supplier(seeded_db):
    """Kennedy Electronics — a real catalog row that no provider covers, which
    is the ordinary case (most suppliers have no API at all)."""
    return seeded_db["supplier2"]


@pytest.fixture
def demo_header(client, db):
    """A demo session, minted the way the public button does (no password)."""
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
    return {"Authorization": f"Bearer {token}"}


class TestModelShape:
    def test_the_table_has_exactly_the_designed_columns(self):
        """032's CREATE plus everything a later migration ADDs. The two sets
        together are the model, so a column that exists on the model (and so in
        the `create_all` every test builds from) but in no migration fails here
        rather than in production."""
        assert set(SupplierFeed.__table__.c.keys()) == COLUMNS | ADDED_COLUMNS

    def test_table_name(self):
        assert SupplierFeed.__tablename__ == "supplier_feeds"

    def test_supplier_id_is_the_primary_key(self):
        """One feed configuration per supplier. A surrogate id would only make
        room for two rows to disagree about whether the nightly job runs."""
        assert [c.name for c in SupplierFeed.__table__.primary_key] == ["supplier_id"]

    def test_supplier_id_points_at_suppliers(self):
        fk = next(iter(SupplierFeed.__table__.c.supplier_id.foreign_keys))
        assert fk.target_fullname == "suppliers.id"

    @pytest.mark.parametrize(
        "column,nullable",
        [
            ("supplier_id", False),
            ("feed_url", True),
            ("api_key", True),
            ("auto_import_enabled", False),
            ("last_synced_at", True),
            ("updated_at", False),
        ],
    )
    def test_nullability(self, column, nullable):
        assert SupplierFeed.__table__.c[column].nullable is nullable

    def test_feed_url_holds_a_real_url(self):
        assert SupplierFeed.__table__.c.feed_url.type.length >= 500

    def test_api_key_is_uncapped_text(self):
        """Key formats belong to other companies; a length cap here would reject
        a valid credential for no benefit."""
        assert isinstance(SupplierFeed.__table__.c.api_key.type, Text)

    def test_auto_import_defaults_off(self, db, seeded_db):
        """A row written with nothing but a supplier id must not enable a
        nightly job by accident."""
        db.add(SupplierFeed(supplier_id=seeded_db["supplier1"].id))
        db.commit()

        row = db.query(SupplierFeed).filter_by(supplier_id=seeded_db["supplier1"].id).one()
        assert row.auto_import_enabled is False


class TestGetGuards:
    def test_unauthenticated_is_refused(self, client, seeded_db):
        assert client.get(_path(seeded_db["supplier1"].id)).status_code == 401

    def test_unknown_supplier_is_404(self, client, seeded_db, auth_header):
        resp = client.get(_path(uuid.uuid4()), headers=auth_header())
        assert resp.status_code == 404

    def test_bad_uuid_is_404(self, client, seeded_db, auth_header):
        resp = client.get(_path("not-a-uuid"), headers=auth_header())
        assert resp.status_code == 404


class TestGetShape:
    def test_supplier_with_no_provider(
        self, client, seeded_db, auth_header, plain_supplier, env_key
    ):
        """Most of the catalog. A key being configured for Mouser says nothing
        about a company Mouser does not supply."""
        resp = client.get(_path(plain_supplier.id), headers=auth_header())

        assert resp.status_code == 200
        assert resp.json() == {
            "provider": None,
            "key_configured": False,
            "auto_import_enabled": False,
        }

    def test_provider_matched_with_an_environment_key(
        self, client, seeded_db, auth_header, feed_supplier, env_key
    ):
        resp = client.get(_path(feed_supplier.id), headers=auth_header())

        assert resp.status_code == 200
        assert resp.json() == {
            "provider": "mouser",
            "key_configured": True,
            "auto_import_enabled": False,
        }
        assert ENV_KEY not in resp.text

    def test_provider_matched_with_no_key_anywhere(
        self, client, seeded_db, auth_header, feed_supplier, no_env_key
    ):
        """The switch has to render greyed rather than absent: the supplier HAS
        a feed, it just has no credential to run it with yet."""
        body = client.get(_path(feed_supplier.id), headers=auth_header()).json()

        assert body["provider"] == "mouser"
        assert body["key_configured"] is False

    def test_a_stored_admin_key_counts_as_configured(
        self, client, db, seeded_db, auth_header, feed_supplier, no_env_key
    ):
        """`key_configured` is `registry.get_feed_key` — the Admin → Settings
        row wins over the environment, and this endpoint must agree with what a
        run would actually use."""
        db.add(ProviderCredential(provider="mouser", api_key=DB_KEY))
        db.commit()

        resp = client.get(_path(feed_supplier.id), headers=auth_header())

        assert resp.json()["key_configured"] is True
        assert DB_KEY not in resp.text

    def test_it_reports_the_stored_toggle(
        self, client, db, seeded_db, auth_header, feed_supplier, env_key
    ):
        db.add(SupplierFeed(supplier_id=feed_supplier.id, auto_import_enabled=True))
        db.commit()

        assert client.get(_path(feed_supplier.id), headers=auth_header()).json() == {
            "provider": "mouser",
            "key_configured": True,
            "auto_import_enabled": True,
        }


class TestPatchGuards:
    def test_unauthenticated_is_refused(self, client, seeded_db):
        resp = client.patch(_path(seeded_db["supplier1"].id), json={"auto_import_enabled": True})
        assert resp.status_code == 401

    def test_unknown_supplier_is_404(self, client, seeded_db, auth_header, env_key):
        resp = client.patch(
            _path(uuid.uuid4()), headers=auth_header(), json={"auto_import_enabled": False}
        )
        assert resp.status_code == 404

    def test_bad_uuid_is_404(self, client, seeded_db, auth_header, env_key):
        resp = client.patch(
            _path("not-a-uuid"), headers=auth_header(), json={"auto_import_enabled": False}
        )
        assert resp.status_code == 404

    def test_a_missing_flag_is_422(self, client, seeded_db, auth_header, feed_supplier, env_key):
        resp = client.patch(_path(feed_supplier.id), headers=auth_header(), json={})
        assert resp.status_code == 422


class TestEnableRequiresARunnableFeed:
    def test_no_provider_is_409(self, client, db, seeded_db, auth_header, plain_supplier, env_key):
        resp = client.patch(
            _path(plain_supplier.id), headers=auth_header(), json={"auto_import_enabled": True}
        )

        assert resp.status_code == 409
        assert resp.json()["detail"] == "feed_not_configured"
        assert db.query(SupplierFeed).filter_by(supplier_id=plain_supplier.id).first() is None

    def test_no_key_is_409(self, client, db, seeded_db, auth_header, feed_supplier, no_env_key):
        resp = client.patch(
            _path(feed_supplier.id), headers=auth_header(), json={"auto_import_enabled": True}
        )

        assert resp.status_code == 409
        assert resp.json()["detail"] == "feed_not_configured"
        assert db.query(SupplierFeed).filter_by(supplier_id=feed_supplier.id).first() is None

    def test_a_blanked_out_stored_key_is_not_a_key(
        self, client, db, seeded_db, auth_header, feed_supplier, no_env_key
    ):
        """`get_feed_key` treats a whitespace-only row as absent; so must this,
        or the switch enables a job whose every call fails on an empty
        credential."""
        db.add(ProviderCredential(provider="mouser", api_key="   "))
        db.commit()

        resp = client.patch(
            _path(feed_supplier.id), headers=auth_header(), json={"auto_import_enabled": True}
        )

        assert resp.status_code == 409

    def test_enable_with_an_environment_key(
        self, client, db, seeded_db, auth_header, feed_supplier, env_key
    ):
        resp = client.patch(
            _path(feed_supplier.id), headers=auth_header(), json={"auto_import_enabled": True}
        )

        assert resp.status_code == 200
        assert resp.json() == {
            "provider": "mouser",
            "key_configured": True,
            "auto_import_enabled": True,
        }
        row = db.query(SupplierFeed).filter_by(supplier_id=feed_supplier.id).one()
        assert row.auto_import_enabled is True

    def test_enable_with_a_stored_admin_key(
        self, client, db, seeded_db, auth_header, feed_supplier, no_env_key
    ):
        db.add(ProviderCredential(provider="mouser", api_key=DB_KEY))
        db.commit()

        resp = client.patch(
            _path(feed_supplier.id), headers=auth_header(), json={"auto_import_enabled": True}
        )

        assert resp.status_code == 200
        assert resp.json()["auto_import_enabled"] is True
        assert DB_KEY not in resp.text


class TestDisableAlwaysWorks:
    def test_disable_without_a_provider_or_a_key(
        self, client, db, seeded_db, auth_header, plain_supplier, no_env_key
    ):
        """An off switch must work even for a feed that could never run —
        otherwise a key rotation traps the toggle in whatever state it was in."""
        resp = client.patch(
            _path(plain_supplier.id), headers=auth_header(), json={"auto_import_enabled": False}
        )

        assert resp.status_code == 200
        assert resp.json()["auto_import_enabled"] is False

    def test_a_supplier_can_be_turned_off_after_its_key_is_removed(
        self, client, db, seeded_db, auth_header, feed_supplier, monkeypatch
    ):
        monkeypatch.setattr(settings, "MOUSER_API_KEY", ENV_KEY)
        client.patch(
            _path(feed_supplier.id), headers=auth_header(), json={"auto_import_enabled": True}
        )
        monkeypatch.setattr(settings, "MOUSER_API_KEY", None)

        resp = client.patch(
            _path(feed_supplier.id), headers=auth_header(), json={"auto_import_enabled": False}
        )

        assert resp.status_code == 200
        assert resp.json() == {
            "provider": "mouser",
            "key_configured": False,
            "auto_import_enabled": False,
        }
        db.expire_all()
        row = db.query(SupplierFeed).filter_by(supplier_id=feed_supplier.id).one()
        assert row.auto_import_enabled is False


class TestUpsert:
    def test_flipping_twice_keeps_one_row(
        self, client, db, seeded_db, auth_header, feed_supplier, env_key
    ):
        for flag in (True, False, True):
            resp = client.patch(
                _path(feed_supplier.id),
                headers=auth_header(),
                json={"auto_import_enabled": flag},
            )
            assert resp.status_code == 200
            assert resp.json()["auto_import_enabled"] is flag

        db.expire_all()
        rows = db.query(SupplierFeed).filter_by(supplier_id=feed_supplier.id).all()
        assert len(rows) == 1
        assert rows[0].auto_import_enabled is True

    def test_get_reads_back_what_patch_wrote(
        self, client, seeded_db, auth_header, feed_supplier, env_key
    ):
        client.patch(
            _path(feed_supplier.id), headers=auth_header(), json={"auto_import_enabled": True}
        )

        assert (
            client.get(_path(feed_supplier.id), headers=auth_header()).json()["auto_import_enabled"]
            is True
        )

    def test_one_suppliers_toggle_does_not_touch_another(
        self, client, db, seeded_db, auth_header, feed_supplier, plain_supplier, env_key
    ):
        client.patch(
            _path(feed_supplier.id), headers=auth_header(), json={"auto_import_enabled": True}
        )

        other = client.get(_path(plain_supplier.id), headers=auth_header()).json()
        assert other["auto_import_enabled"] is False


class TestNoSecretsInAnyResponse:
    """`supplier_feeds.api_key` and `feed_url` are SCHEMA-ONLY this phase (the
    partner-feed work uses them). Nothing may read them back to a client — the
    planted values must not surface, in any field, in any error, on either
    verb."""

    @pytest.fixture
    def planted_row(self, db, feed_supplier):
        db.add(
            SupplierFeed(
                supplier_id=feed_supplier.id,
                feed_url="https://feeds.example.invalid/parts.csv",
                api_key=ROW_KEY,
                auto_import_enabled=True,
            )
        )
        db.commit()
        return feed_supplier

    def test_get_never_carries_the_row_key(
        self, client, seeded_db, auth_header, planted_row, env_key
    ):
        resp = client.get(_path(planted_row.id), headers=auth_header())

        assert set(resp.json()) == {"provider", "key_configured", "auto_import_enabled"}
        assert ROW_KEY not in resp.text
        assert "feeds.example.invalid" not in resp.text

    def test_patch_never_carries_the_row_key(
        self, client, seeded_db, auth_header, planted_row, env_key
    ):
        resp = client.patch(
            _path(planted_row.id), headers=auth_header(), json={"auto_import_enabled": False}
        )

        assert set(resp.json()) == {"provider", "key_configured", "auto_import_enabled"}
        assert ROW_KEY not in resp.text
        assert "feeds.example.invalid" not in resp.text

    def test_patch_leaves_the_other_columns_alone(
        self, client, db, seeded_db, auth_header, planted_row, env_key
    ):
        """The toggle owns ONE column. A blind upsert that rebuilt the row would
        silently drop a partner feed's URL and key."""
        client.patch(
            _path(planted_row.id), headers=auth_header(), json={"auto_import_enabled": False}
        )

        db.expire_all()
        row = db.query(SupplierFeed).filter_by(supplier_id=planted_row.id).one()
        assert row.api_key == ROW_KEY
        assert row.feed_url == "https://feeds.example.invalid/parts.csv"


class TestDemoAccount:
    def test_demo_may_read_the_card(self, client, seeded_db, demo_header, feed_supplier, env_key):
        """The demo console renders exactly like the real one; the payload
        carries no secret, so there is nothing to withhold."""
        resp = client.get(_path(feed_supplier.id), headers=demo_header)

        assert resp.status_code == 200
        assert set(resp.json()) == {"provider", "key_configured", "auto_import_enabled"}
        assert ENV_KEY not in resp.text

    def test_demo_cannot_flip_the_switch(
        self, client, db, seeded_db, demo_header, feed_supplier, env_key
    ):
        resp = client.patch(
            _path(feed_supplier.id), headers=demo_header, json={"auto_import_enabled": True}
        )

        assert resp.status_code == 403
        assert resp.json()["detail"] == "demo_account_read_only"
        assert db.query(SupplierFeed).filter_by(supplier_id=feed_supplier.id).first() is None


class TestSupplierDeleteRemovesTheFeedRow:
    """DELETE /api/suppliers/{id} deletes the feed row — the 8th cascade
    surface. Settings are dependents, not history (unlike ActivityEvent, which
    the same route NULLs): a company that is gone has no nightly import. The FK
    carries no cascade, so a forgotten step is a foreign-key violation — a 500
    on a route that used to work."""

    def test_delete_removes_the_row(self, client, db, seeded_db, auth_header, feed_supplier):
        db.add(SupplierFeed(supplier_id=feed_supplier.id, auto_import_enabled=True))
        db.commit()

        resp = client.delete(f"/api/suppliers/{feed_supplier.id}", headers=auth_header())

        assert resp.status_code == 200
        assert db.query(Supplier).filter_by(id=feed_supplier.id).first() is None
        assert db.query(SupplierFeed).filter_by(supplier_id=feed_supplier.id).first() is None

    def test_another_suppliers_row_is_untouched(
        self, client, db, seeded_db, auth_header, feed_supplier, plain_supplier
    ):
        db.add(SupplierFeed(supplier_id=plain_supplier.id, auto_import_enabled=False))
        db.commit()

        resp = client.delete(f"/api/suppliers/{feed_supplier.id}", headers=auth_header())

        assert resp.status_code == 200
        assert db.query(SupplierFeed).filter_by(supplier_id=plain_supplier.id).one()

    def test_delete_works_with_no_feed_row_at_all(
        self, client, db, seeded_db, auth_header, plain_supplier
    ):
        """The ordinary case — most suppliers never get a row."""
        resp = client.delete(f"/api/suppliers/{plain_supplier.id}", headers=auth_header())
        assert resp.status_code == 200


class TestMigration032:
    def test_it_sits_on_the_head_that_is_actually_on_disk(self):
        assert re.search(r'^revision = "032"', MIGRATION, re.M)
        assert re.search(r'^down_revision = "031"', MIGRATION, re.M)

    def test_it_creates_the_table_idempotently(self):
        """`alembic/env.py` sets no transaction_per_migration, so a partial
        failure replays this file on the next container start — and a migration
        that dies on "relation already exists" crash-loops the api at 502."""
        assert "CREATE TABLE IF NOT EXISTS supplier_feeds" in MIGRATION

    @pytest.mark.parametrize("column", sorted(COLUMNS))
    def test_every_model_column_is_in_the_ddl(self, column):
        assert re.search(rf"^\s+{column}\s", MIGRATION, re.M), (
            f"{column} exists on the model but not in migration 032 — the test suite "
            "builds with create_all and would never notice."
        )

    def test_supplier_id_is_the_primary_key_and_the_fk(self):
        line = re.search(r"^\s+supplier_id\s+.*$", MIGRATION, re.M)
        assert line
        assert "PRIMARY KEY" in line.group(0)
        assert "REFERENCES suppliers(id)" in line.group(0)

    def test_the_supplier_fk_does_not_cascade(self):
        """The delete route owns the order (it deletes this row explicitly, as
        it does for every other dependent). A database cascade here would hide a
        forgotten route step instead of failing on it."""
        line = re.search(r"^\s+supplier_id\s+.*$", MIGRATION, re.M)
        assert line and "ON DELETE CASCADE" not in line.group(0)

    def test_the_ddl_matches_the_model_on_the_not_null_columns(self):
        for column in ("auto_import_enabled", "updated_at"):
            line = re.search(rf"^\s+{column}\s+.*$", MIGRATION, re.M)
            assert line and "NOT NULL" in line.group(0)


    def test_the_toggle_defaults_off_in_the_database_too(self):
        line = re.search(r"^\s+auto_import_enabled\s+.*$", MIGRATION, re.M)
        assert line and "DEFAULT false" in line.group(0)

    def test_updated_at_is_stamped_by_the_database(self):
        line = re.search(r"^\s+updated_at\s+.*$", MIGRATION, re.M)
        assert line and "DEFAULT now()" in line.group(0)

    def test_downgrade_drops_the_table_if_it_exists(self):
        assert "DROP TABLE IF EXISTS supplier_feeds" in MIGRATION


class TestMigration033:
    """`import_cursor` — the per-category import sweep depth."""

    def test_it_sits_on_the_head_that_is_actually_on_disk(self):
        assert re.search(r'^revision = "033"', MIGRATION_033, re.M)
        assert re.search(r'^down_revision = "032"', MIGRATION_033, re.M)

    def test_it_adds_the_column_idempotently(self):
        """Same reason as 032: a replayed migration that dies on "column
        already exists" crash-loops the api with /api/* at 502."""
        assert "ADD COLUMN IF NOT EXISTS import_cursor JSON" in MIGRATION_033
        assert "DROP COLUMN IF EXISTS import_cursor" in MIGRATION_033

    def test_the_column_is_json_on_the_model_too(self):
        """`sa.JSON` renders on Postgres AND on the SQLite the suite builds —
        a Postgres-only JSONB would leave every test blind to this column."""
        assert isinstance(SupplierFeed.__table__.c.import_cursor.type, JSON)
        assert SupplierFeed.__table__.c.import_cursor.nullable

