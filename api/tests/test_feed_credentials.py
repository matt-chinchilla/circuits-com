"""/api/admin/feed-credentials — distributor feed keys, managed from Settings.

The sync feature needs a Mouser key. Before this router the only way to give it
one was an environment variable and a container recreate; now an admin can
paste it into Admin → Settings and the DB row wins over the environment.

The contract these tests pin, in the order it matters:

1. **The stored value never comes back out.** Every response is asserted
   against the raw key STRING, not just the parsed body — a leak through a
   validation message, an error detail or an unexpected field would still be in
   `resp.text`. The status shape exposes only configured/source/last4/updated_at,
   and `last4` is shown ONLY for a database key: deriving it from the
   environment value would publish four characters of a secret this UI never
   accepted and cannot rotate.
2. **Auth.** Admin session on all three verbs. The demo account keeps its READ
   (the Settings card must render for a prospect) and is refused both writes by
   the global demo read-only gate.
3. **Source transitions.** database → environment → none, so the card can say
   which one is answering. Deleting a DB row while the env key is set is not
   "removed", it is "back to the environment", and the response says so.
"""

import uuid

import bcrypt
import pytest

from app.config import settings
from app.models import ProviderCredential, User

# Fake credentials — nothing here ever reaches Mouser. Distinctive strings so a
# leak assertion (`KEY not in resp.text`) can only fail on a real leak.
STORED_KEY = "db-stored-feed-key-9f3a2c71"
ENV_KEY = "env-fallback-feed-key-4b8e"
DEMO_EMAIL = "demo@circuitcenter.ai"

BASE = "/api/admin/feed-credentials"
MOUSER = f"{BASE}/mouser"


@pytest.fixture
def env_key(monkeypatch):
    """The environment fallback is present."""
    monkeypatch.setattr(settings, "MOUSER_API_KEY", ENV_KEY)


@pytest.fixture
def no_env_key(monkeypatch):
    """No environment fallback — the DB is the only possible source."""
    monkeypatch.setattr(settings, "MOUSER_API_KEY", None)


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


def _mouser(resp):
    """The mouser row out of a GET/PUT/DELETE status payload."""
    providers = resp.json()["providers"]
    return next(p for p in providers if p["provider"] == "mouser")


class TestGuards:
    def test_get_requires_a_session(self, client, seeded_db):
        assert client.get(f"{BASE}/").status_code == 401

    def test_put_requires_a_session(self, client, seeded_db):
        assert client.put(MOUSER, json={"api_key": STORED_KEY}).status_code == 401

    def test_delete_requires_a_session(self, client, seeded_db):
        assert client.delete(MOUSER).status_code == 401

    def test_demo_may_read_the_card(self, client, seeded_db, demo_header, env_key):
        """The demo console renders exactly like the real one; the status shape
        carries no secret, so there is nothing to withhold."""
        resp = client.get(f"{BASE}/", headers=demo_header)

        assert resp.status_code == 200
        assert _mouser(resp)["source"] == "environment"
        assert ENV_KEY not in resp.text

    def test_demo_cannot_store_a_key(self, client, seeded_db, demo_header):
        resp = client.put(MOUSER, headers=demo_header, json={"api_key": STORED_KEY})

        assert resp.status_code == 403
        assert resp.json()["detail"] == "demo_account_read_only"

    def test_demo_cannot_remove_a_key(self, client, seeded_db, demo_header):
        resp = client.delete(MOUSER, headers=demo_header)

        assert resp.status_code == 403
        assert resp.json()["detail"] == "demo_account_read_only"


class TestStatus:
    def test_nothing_configured_anywhere(self, client, seeded_db, auth_header, no_env_key):
        resp = client.get(f"{BASE}/", headers=auth_header())

        assert resp.status_code == 200
        row = _mouser(resp)
        assert row == {
            "provider": "mouser",
            "label": "Mouser Electronics",
            "configured": False,
            "source": None,
            "last4": None,
            "updated_at": None,
        }

    def test_an_environment_key_counts_as_configured_but_shows_no_last4(
        self, client, seeded_db, auth_header, env_key
    ):
        """`last4` is for a key this UI accepted and can replace. Four
        characters of the server's own environment secret is a leak with no
        purpose — the admin cannot rotate it from here anyway."""
        resp = client.get(f"{BASE}/", headers=auth_header())

        row = _mouser(resp)
        assert row["configured"] is True
        assert row["source"] == "environment"
        assert row["last4"] is None
        assert ENV_KEY not in resp.text


class TestStoreAndRemove:
    def test_put_then_get_then_delete_walks_the_sources(
        self, client, db, seeded_db, auth_header, env_key
    ):
        stored = client.put(MOUSER, headers=auth_header(), json={"api_key": STORED_KEY})
        assert stored.status_code == 200
        row = _mouser(stored)
        assert row["configured"] is True
        assert row["source"] == "database"
        assert row["last4"] == STORED_KEY[-4:]
        assert row["updated_at"]

        # The row really is in the table, whole and unmangled.
        saved = db.query(ProviderCredential).filter_by(provider="mouser").one()
        assert saved.api_key == STORED_KEY

        fetched = _mouser(client.get(f"{BASE}/", headers=auth_header()))
        assert fetched["source"] == "database"
        assert fetched["last4"] == STORED_KEY[-4:]

        removed = client.delete(MOUSER, headers=auth_header())
        assert removed.status_code == 200
        # Removing the DB row does not turn the feature off — the environment
        # is still answering, and the card must say which source that is.
        after = _mouser(removed)
        assert after["configured"] is True
        assert after["source"] == "environment"
        assert after["last4"] is None
        assert db.query(ProviderCredential).count() == 0

    def test_delete_with_no_environment_fallback_leaves_it_unconfigured(
        self, client, seeded_db, auth_header, no_env_key
    ):
        client.put(MOUSER, headers=auth_header(), json={"api_key": STORED_KEY})

        after = _mouser(client.delete(MOUSER, headers=auth_header()))

        assert after["configured"] is False
        assert after["source"] is None
        assert after["last4"] is None
        assert after["updated_at"] is None

    def test_delete_is_idempotent(self, client, seeded_db, auth_header, no_env_key):
        """Two admins on the same card, or a double-click: removing a key that
        is already gone is the state the caller asked for, not an error."""
        first = client.delete(MOUSER, headers=auth_header())
        second = client.delete(MOUSER, headers=auth_header())

        assert first.status_code == 200
        assert second.status_code == 200
        assert _mouser(second)["configured"] is False

    def test_put_replaces_the_previous_key(self, client, db, seeded_db, auth_header, no_env_key):
        client.put(MOUSER, headers=auth_header(), json={"api_key": STORED_KEY})
        replacement = "second-feed-key-0d5e77"

        resp = client.put(MOUSER, headers=auth_header(), json={"api_key": replacement})

        assert _mouser(resp)["last4"] == replacement[-4:]
        rows = db.query(ProviderCredential).all()
        assert len(rows) == 1
        assert rows[0].api_key == replacement

    def test_surrounding_whitespace_is_trimmed_before_storage(
        self, client, db, seeded_db, auth_header, no_env_key
    ):
        """A pasted key routinely arrives with a trailing newline; stored raw it
        would travel into the Authorization-style header of every feed call."""
        client.put(MOUSER, headers=auth_header(), json={"api_key": f"  {STORED_KEY}\n"})

        assert db.query(ProviderCredential).one().api_key == STORED_KEY


class TestTheValueNeverComesBack:
    def test_no_response_in_the_cycle_contains_the_key(
        self, client, seeded_db, auth_header, env_key
    ):
        """The one rule this whole router exists to keep. Asserted on raw text,
        not the parsed body: a leak through an error detail or a field nobody
        expected is still a leak."""
        responses = [
            client.put(MOUSER, headers=auth_header(), json={"api_key": STORED_KEY}),
            client.get(f"{BASE}/", headers=auth_header()),
            client.delete(MOUSER, headers=auth_header()),
            client.get(f"{BASE}/", headers=auth_header()),
        ]

        for resp in responses:
            assert STORED_KEY not in resp.text
            assert ENV_KEY not in resp.text

    def test_a_rejected_key_is_not_echoed_in_the_422(self, client, seeded_db, auth_header):
        """Validation failures are the classic leak: the value that failed is
        exactly what a helpful error message wants to quote back."""
        rejected = "x" * 400

        resp = client.put(MOUSER, headers=auth_header(), json={"api_key": rejected})

        assert resp.status_code == 422
        assert rejected not in resp.text


class TestValidation:
    @pytest.mark.parametrize(
        "bad",
        [
            "",  # empty
            "   ",  # whitespace only
            "short7",  # under 8 characters
            "x" * 129,  # over 128
            "has\nnewline-key",  # control character
            "hås-a-non-ascii-key",  # non-ASCII
        ],
    )
    def test_unusable_keys_are_refused(self, client, db, seeded_db, auth_header, bad):
        resp = client.put(MOUSER, headers=auth_header(), json={"api_key": bad})

        assert resp.status_code == 422, bad
        assert resp.json()["detail"] == "invalid_api_key"
        assert db.query(ProviderCredential).count() == 0

    def test_a_key_at_each_boundary_is_accepted(self, client, seeded_db, auth_header):
        for key in ("k" * 8, "k" * 128):
            resp = client.put(MOUSER, headers=auth_header(), json={"api_key": key})
            assert resp.status_code == 200, len(key)

    def test_an_unknown_provider_is_404(self, client, db, seeded_db, auth_header):
        """The slug set comes from the provider registry, so adding Digi-Key is
        one row there and no edit here."""
        put = client.put(f"{BASE}/digikey", headers=auth_header(), json={"api_key": STORED_KEY})
        delete = client.delete(f"{BASE}/digikey", headers=auth_header())

        assert put.status_code == 404
        assert delete.status_code == 404
        assert db.query(ProviderCredential).count() == 0
