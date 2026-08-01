"""P3 credential push-sync — site side, mail-box side, and the contract between.

One password opens the website and the mailbox
(``docs/superpowers/specs/2026-07-31-mail-server-and-auth-design.md``, P3). The
site derives a SHA512-crypt hash from the plaintext it already holds and POSTs
it to a small authenticated receiver on the mail box.

What is pinned here, and why each one is worth a test:

1. **The hash is right.** A wrong SHA512-crypt implementation locks five people
   out of their mail with a hash that *looks* fine. Checked against the
   published spec vectors AND, where the stdlib still ships ``crypt``, against
   that independent oracle — never against itself.
2. **Every password-set path syncs.** ``/auth/change-password`` and
   ``/auth/reset-password`` both push. A recovery flow that quietly skipped the
   sync would leave the mailbox on the old password — precisely the drift this
   channel exists to prevent.
3. **A sync failure never fails the password change.** The site is the source
   of truth: the new password works on the site, the row is marked
   ``mail_sync_pending``, and the next successful login retries it.
4. **The receiver refuses everything it should.** Bad token, unknown address,
   and — the load-bearing one — anything that is not a ``$6$…`` hash, which is
   what makes "plaintext never leaves the web box" verifiable at the far end
   instead of merely promised at this one.
"""

import importlib.util
import re
import shutil
import subprocess
import threading
import warnings
from pathlib import Path

import bcrypt
import httpx
import pytest

from app.config import Settings, settings
from app.models import User
from app.services import mail_sync
from app.services.auth_service import create_reset_token
from app.services.sha512_crypt import (
    SHA512_CRYPT_RE,
    generate_salt,
    is_sha512_crypt,
    sha512_crypt,
)

ROOT = Path(__file__).resolve().parents[2]
RECEIVER_PATH = ROOT / "mail" / "sync-receiver" / "mail_sync_receiver.py"
DEV_COMPOSE = ROOT / "docker-compose.yml"
PROD_COMPOSE = ROOT / "docker-compose.prod.yml"

ADMIN_EMAIL = "admin@test.example"
ADMIN_PASSWORD = "testpass123"
# Satisfies the password policy: 8-24 chars, uppercase, digit, symbol.
GOOD_PASSWORD = "Newpass99!"
SECRET = "test-secret-token-that-is-long-enough-to-pass"


@pytest.fixture(autouse=True)
def _clear_retry_state():
    """The failure cooldown lives in PROCESS memory (like the rate limiter), so
    the per-test DB teardown does nothing for it. Autouse so no test has to
    know it exists."""
    mail_sync.reset_retry_state()
    yield
    mail_sync.reset_retry_state()


@pytest.fixture
def enabled(monkeypatch):
    """Arm the channel for the seeded admin address."""
    monkeypatch.setattr(settings, "MAIL_SYNC_URL", "https://mail.test.invalid:8825")
    monkeypatch.setattr(settings, "MAIL_SYNC_SECRET", SECRET)
    monkeypatch.setattr(settings, "MAIL_SYNC_MAILBOXES", [ADMIN_EMAIL])


class Recorder:
    """A stand-in mail box. Records what the site actually sent."""

    def __init__(self, status_code=200, raise_exc=None):
        self.status_code = status_code
        self.raise_exc = raise_exc
        self.requests = []

    def handler(self, request):
        self.requests.append(request)
        if self.raise_exc is not None:
            raise self.raise_exc
        return httpx.Response(self.status_code, json={"status": "ok"})

    @property
    def called(self):
        return bool(self.requests)

    @property
    def last_json(self):
        import json

        return json.loads(self.requests[-1].content.decode())


@pytest.fixture
def mailbox(monkeypatch):
    """Substitute the transport, NOT the push function: the URL, headers and
    body this test asserts on are built by the real code path."""

    def _make(status_code=200, raise_exc=None):
        recorder = Recorder(status_code=status_code, raise_exc=raise_exc)
        monkeypatch.setattr(
            mail_sync,
            "_client",
            lambda: httpx.Client(transport=httpx.MockTransport(recorder.handler)),
        )
        return recorder

    return _make


def _stdlib_crypt():
    """The stdlib ``crypt`` module, or None where it no longer exists."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            import crypt
    except ImportError:
        return None
    return crypt


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


def _login(client, email=ADMIN_EMAIL, password=ADMIN_PASSWORD):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def _change(client, token, current=ADMIN_PASSWORD, new=GOOD_PASSWORD):
    return client.post(
        "/api/auth/change-password",
        json={"current_password": current, "new_password": new},
        headers=_bearer(token),
    )


def _admin(db):
    return db.query(User).filter(User.email == ADMIN_EMAIL).first()


# ── 1. The hash itself ──────────────────────────────────────────────────────


class TestSha512Crypt:
    """Checked against outside oracles. A hash that is merely self-consistent
    is a hash nobody else can verify — i.e. a mailbox nobody can log into."""

    # Ulrich Drepper's published SHA-crypt test vectors (the same spec glibc,
    # Dovecot and `doveadm pw -s SHA512-CRYPT` implement).
    VECTORS = [
        (
            "Hello world!",
            "saltstring",
            5000,
            "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJue"
            "sI68u4OTLiBFdcbYEdFCoEOfaS35inz1",
        ),
        (
            "Hello world!",
            "saltstringsaltstring",
            10000,
            "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHb"
            "bMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.",
        ),
        (
            "a very much longer text to encrypt.  This one even stretches over morethan one line.",
            "anotherlongsaltstring",
            1400,
            "$6$rounds=1400$anotherlongsalts$POfYwTEok97VWcjxIiSOjiykti.o/pQs.wPvM"
            "xQ6Fm7I6IoYN3CmLs66x9t0oSwbtEW7o7UmJEiDwGqd8p4ur1",
        ),
    ]

    @pytest.mark.parametrize("password,salt,rounds,expected", VECTORS)
    def test_published_spec_vectors(self, password, salt, rounds, expected):
        assert sha512_crypt(password, salt, rounds) == expected

    def test_matches_the_stdlib_crypt_module(self):
        """Cross-check against an independent implementation.

        ``crypt`` is deprecated in 3.11 and REMOVED in 3.13 — which is exactly
        why the app ships its own — so this skips rather than fails once the
        base image moves past it. The spec vectors above never skip.

        Imported by hand rather than with ``pytest.importorskip``: that helper
        turns warnings into errors during the import, so on 3.12 (the api image
        today) it would SKIP on the DeprecationWarning and this cross-check
        would silently never run on the very version that can still do it.
        """
        crypt = _stdlib_crypt()
        if crypt is None:
            pytest.skip("stdlib crypt removed in Python 3.13")
        cases = [
            ("Newpass99!", "abcdefghijklmnop"),
            ("", "shortsalt"),
            ("pässwörd-ünicode", "0123456789./ABcd"),
            ("x" * 200, "LongPasswordSalt"),
        ]
        for password, salt in cases:
            assert sha512_crypt(password, salt) == crypt.crypt(password, f"$6${salt}")

    def test_matches_openssl_passwd(self):
        """A SECOND live oracle, and the one that survives Python 3.13.

        ``openssl passwd -6`` implements the same crypt(3) format Dovecot
        stores, so this keeps a real cross-check running on a runner where the
        stdlib ``crypt`` test above can only skip. Skips if openssl is absent.
        """
        openssl = shutil.which("openssl")
        if openssl is None:
            pytest.skip("openssl not installed")
        salt = "Abcdefgh12345678"
        for password in ("Newpass99!", "p@ss word", "0"):
            completed = subprocess.run(
                [openssl, "passwd", "-6", "-salt", salt, password],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if completed.returncode != 0:
                pytest.skip(f"openssl passwd -6 unavailable: {completed.stderr.strip()}")
            assert sha512_crypt(password, salt) == completed.stdout.strip()

    def test_salt_is_random_per_call(self):
        first = sha512_crypt("Newpass99!")
        second = sha512_crypt("Newpass99!")
        assert first != second, "a fixed salt would make every mailbox hash comparable"
        assert is_sha512_crypt(first) and is_sha512_crypt(second)

    def test_generated_salt_uses_the_crypt_alphabet(self):
        assert re.fullmatch(r"[./A-Za-z0-9]{16}", generate_salt())

    def test_format_gate_rejects_a_plaintext_password(self):
        """The regex IS the no-plaintext contract — both ends share it."""
        for not_a_hash in ("Newpass99!", "", "$1$abc$xyz", "{SHA512-CRYPT}$6$abc$xyz", "$6$"):
            assert not is_sha512_crypt(not_a_hash)
        assert SHA512_CRYPT_RE.match(sha512_crypt("Newpass99!"))


# ── 2. The service ──────────────────────────────────────────────────────────


class TestServiceGating:
    def test_disabled_by_default_and_never_raises(self, db, seeded_db):
        """A missing URL is the state of every dev box and this whole suite. It
        must be a no-op, not an exception — losing the ability to change a
        password because no mail box is configured would be absurd."""
        assert settings.MAIL_SYNC_URL is None
        assert mail_sync.is_configured() is False
        user = _admin(db)
        assert mail_sync.sync_user_password(db, user, "whatever") is None
        assert bool(user.mail_sync_pending) is False

    def test_half_configured_is_still_disabled(self, monkeypatch):
        """A URL with no secret would POST a credential unauthenticated."""
        monkeypatch.setattr(settings, "MAIL_SYNC_URL", "https://mail.test.invalid")
        monkeypatch.setattr(settings, "MAIL_SYNC_SECRET", None)
        assert mail_sync.is_configured() is False
        monkeypatch.setattr(settings, "MAIL_SYNC_SECRET", SECRET)
        assert mail_sync.is_configured() is True

    def test_only_real_mailboxes_are_synced(self, monkeypatch):
        """``demo@`` is a login identity with NO mailbox (design, P2)."""
        monkeypatch.setattr(
            settings, "MAIL_SYNC_MAILBOXES", ["matthew@circuitcenter.ai", "no-reply@x.test"]
        )
        assert mail_sync.has_mailbox("matthew@circuitcenter.ai")
        assert mail_sync.has_mailbox("  MATTHEW@CircuitCenter.ai ")
        assert not mail_sync.has_mailbox("demo@circuitcenter.ai")
        assert not mail_sync.has_mailbox(None)

    def test_shipped_mailbox_default_is_the_five_and_excludes_demo(self):
        default = Settings.model_fields["MAIL_SYNC_MAILBOXES"].default
        assert default == [
            "anthony@circuitcenter.ai",
            "daniel@circuitcenter.ai",
            "matthew@circuitcenter.ai",
            "ronald@circuitcenter.ai",
            "no-reply@circuitcenter.ai",
        ]
        assert not any("demo@" in address for address in default)


class TestPush:
    def test_posts_the_hash_never_the_plaintext(self, enabled, mailbox):
        recorder = mailbox()
        assert mail_sync.push_password(ADMIN_EMAIL, "Newpass99!") is True

        request = recorder.requests[-1]
        assert str(request.url) == "https://mail.test.invalid:8825/sync-password"
        assert request.headers["Authorization"] == f"Bearer {SECRET}"
        body = recorder.last_json
        assert body["email"] == ADMIN_EMAIL
        assert is_sha512_crypt(body["hash"])
        # THE property of the whole design.
        assert "Newpass99!" not in request.content.decode()
        assert "password" not in body

    def test_a_non_200_is_a_failure_not_an_exception(self, enabled, mailbox):
        mailbox(status_code=500)
        assert mail_sync.push_password(ADMIN_EMAIL, "Newpass99!") is False

    def test_a_transport_error_is_a_failure_not_an_exception(self, enabled, mailbox):
        mailbox(raise_exc=httpx.ConnectError("mail box is down"))
        assert mail_sync.push_password(ADMIN_EMAIL, "Newpass99!") is False


# ── 3. Every password-set path ──────────────────────────────────────────────


class TestChangePasswordSyncs:
    def test_change_password_pushes_to_the_mail_box(self, client, db, seeded_db, enabled, mailbox):
        recorder = mailbox()
        token = _login(client).json()["token"]
        assert _change(client, token).status_code == 200
        assert recorder.called, "/auth/change-password must sync the mailbox"
        assert recorder.last_json["email"] == ADMIN_EMAIL
        db.refresh(_admin(db))
        assert bool(_admin(db).mail_sync_pending) is False

    def test_a_failed_sync_leaves_the_password_changed_and_marks_the_row(
        self, client, db, seeded_db, enabled, mailbox
    ):
        """The single most important behaviour in this file."""
        mailbox(raise_exc=httpx.ConnectError("mail box is down"))
        token = _login(client).json()["token"]
        assert _change(client, token).status_code == 200

        user = _admin(db)
        db.refresh(user)
        assert bool(user.mail_sync_pending) is True, "drift must be recorded, never silent"
        # The site password really did change: the new one works, the old
        # one does not.
        assert _login(client, password=GOOD_PASSWORD).status_code == 200
        assert _login(client, password=ADMIN_PASSWORD).status_code == 401

    def test_an_account_with_no_mailbox_is_never_marked_pending(
        self, client, db, seeded_db, enabled, mailbox, monkeypatch
    ):
        """A stuck flag on an account that can never sync would cry wolf
        forever — and would be un-clearable, since there is nothing to push to."""
        monkeypatch.setattr(settings, "MAIL_SYNC_MAILBOXES", ["someone-else@circuitcenter.ai"])
        recorder = mailbox(status_code=500)
        token = _login(client).json()["token"]
        assert _change(client, token).status_code == 200
        assert not recorder.called
        db.refresh(_admin(db))
        assert bool(_admin(db).mail_sync_pending) is False


class TestResetPasswordSyncs:
    def _reset(self, client, db, new=GOOD_PASSWORD):
        user = _admin(db)
        token = create_reset_token(str(user.id), user.password_hash)
        return client.post("/api/auth/reset-password", json={"token": token, "new_password": new})

    def test_reset_password_pushes_to_the_mail_box(self, client, db, seeded_db, enabled, mailbox):
        recorder = mailbox()
        assert self._reset(client, db).status_code == 200
        assert recorder.called, "recovery must sync too, or the mailbox keeps the old password"
        assert is_sha512_crypt(recorder.last_json["hash"])

    def test_a_failed_sync_still_completes_the_reset(self, client, db, seeded_db, enabled, mailbox):
        mailbox(status_code=502)
        assert self._reset(client, db).status_code == 200
        db.refresh(_admin(db))
        assert bool(_admin(db).mail_sync_pending) is True
        assert _login(client, password=GOOD_PASSWORD).status_code == 200


class TestLoginRetry:
    def test_a_pending_row_retries_on_the_next_successful_login(
        self, client, db, seeded_db, enabled, mailbox
    ):
        user = _admin(db)
        user.mail_sync_pending = True
        db.commit()

        recorder = mailbox()
        assert _login(client).status_code == 200
        assert recorder.called, "login is where drift self-heals"
        assert is_sha512_crypt(recorder.last_json["hash"])
        db.refresh(user)
        assert bool(user.mail_sync_pending) is False

    def test_a_clean_row_does_not_push_on_login(self, client, db, seeded_db, enabled, mailbox):
        recorder = mailbox()
        assert _login(client).status_code == 200
        assert not recorder.called, "an unflagged login must not talk to the mail box at all"

    def test_a_failed_login_never_pushes(self, client, db, seeded_db, enabled, mailbox):
        user = _admin(db)
        user.mail_sync_pending = True
        db.commit()
        recorder = mailbox()
        assert _login(client, password="wrong-password").status_code == 401
        assert not recorder.called, "a wrong password must never be pushed anywhere"

    def test_a_second_login_is_skipped_by_the_failure_cooldown(
        self, client, db, seeded_db, enabled, mailbox
    ):
        """A mail box that is down must not add the HTTP timeout to every
        sign-in — the retry backs off per address."""
        user = _admin(db)
        user.mail_sync_pending = True
        db.commit()
        recorder = mailbox(status_code=503)

        assert _login(client).status_code == 200
        assert len(recorder.requests) == 1
        assert _login(client).status_code == 200
        assert len(recorder.requests) == 1, "the cooldown should have suppressed the retry"

        mail_sync.reset_retry_state()
        assert _login(client).status_code == 200
        assert len(recorder.requests) == 2


class TestDriftIsVisible:
    def test_auth_me_reports_the_pending_flag(self, client, db, seeded_db):
        token = _login(client).json()["token"]
        assert client.get("/api/auth/me", headers=_bearer(token)).json()["mail_sync_pending"] is (
            False
        )
        user = _admin(db)
        user.mail_sync_pending = True
        db.commit()
        body = client.get("/api/auth/me", headers=_bearer(token)).json()
        assert body["mail_sync_pending"] is True


class TestModelColumn:
    def test_column_is_not_null_and_defaults_false(self, db):
        column = User.__table__.c.mail_sync_pending
        assert column.nullable is False
        user = User(
            username="fresh",
            email="fresh@test.example",
            password_hash=bcrypt.hashpw(b"x", bcrypt.gensalt()).decode(),
            role="admin",
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        assert bool(user.mail_sync_pending) is False


# ── 4. The receiver (mail box side) ─────────────────────────────────────────


def _load_receiver():
    """Import the mail-box script by path — it lives outside the api package on
    purpose (stdlib-only, no pip on a credential path) but its refusals are
    load-bearing enough to belong in the one suite that runs on every commit."""
    spec = importlib.util.spec_from_file_location("mail_sync_receiver", RECEIVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


receiver = _load_receiver()

ACCOUNTS_FIXTURE = (
    "# docker-mailserver accounts\n"
    "anthony@circuitcenter.ai|{SHA512-CRYPT}$6$oldsaltoldsalt00$" + "A" * 86 + "\n"
    "matthew@circuitcenter.ai|{SHA512-CRYPT}$6$oldsaltoldsalt11$" + "B" * 86 + "\n"
    "no-reply@circuitcenter.ai|{SHA512-CRYPT}$6$oldsaltoldsalt22$" + "C" * 86 + "\n"
)

RECEIVER_ACCOUNTS = [
    "anthony@circuitcenter.ai",
    "matthew@circuitcenter.ai",
    "no-reply@circuitcenter.ai",
    # Allowlisted but deliberately absent from the file above.
    "daniel@circuitcenter.ai",
]


@pytest.fixture
def accounts_file(tmp_path):
    path = tmp_path / "postfix-accounts.cf"
    path.write_text(ACCOUNTS_FIXTURE)
    return path


@pytest.fixture
def receiver_url(accounts_file):
    config = receiver.Config(
        secret=SECRET,
        accounts_file=str(accounts_file),
        allowed_accounts=RECEIVER_ACCOUNTS,
        bind="127.0.0.1",
        port=0,
    )
    server = receiver.SyncServer(config)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _post(url, payload, token=SECRET):
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    # trust_env=False: a proxy env var must not intercept a loopback call.
    with httpx.Client(trust_env=False, timeout=10) as client:
        return client.post(f"{url}/sync-password", json=payload, headers=headers)


class TestReceiverRefusals:
    def test_rejects_a_bad_token(self, receiver_url, accounts_file):
        before = accounts_file.read_text()
        response = _post(
            receiver_url,
            {"email": "matthew@circuitcenter.ai", "hash": sha512_crypt("Newpass99!")},
            token="wrong-secret",
        )
        assert response.status_code == 401
        assert accounts_file.read_text() == before

    def test_rejects_a_missing_token(self, receiver_url):
        response = _post(
            receiver_url,
            {"email": "matthew@circuitcenter.ai", "hash": sha512_crypt("Newpass99!")},
            token=None,
        )
        assert response.status_code == 401

    def test_rejects_an_unknown_email(self, receiver_url, accounts_file):
        before = accounts_file.read_text()
        response = _post(
            receiver_url,
            {"email": "attacker@evil.test", "hash": sha512_crypt("Newpass99!")},
        )
        assert response.status_code == 404
        assert accounts_file.read_text() == before

    def test_rejects_a_plaintext_password(self, receiver_url, accounts_file):
        """The refusal that makes the design's central claim checkable."""
        before = accounts_file.read_text()
        response = _post(receiver_url, {"email": "matthew@circuitcenter.ai", "hash": "Newpass99!"})
        assert response.status_code == 400
        assert "SHA512-crypt" in response.json()["detail"]
        assert accounts_file.read_text() == before

    def test_rejects_a_bcrypt_hash(self, receiver_url):
        response = _post(
            receiver_url,
            {
                "email": "matthew@circuitcenter.ai",
                "hash": bcrypt.hashpw(b"Newpass99!", bcrypt.gensalt()).decode(),
            },
        )
        assert response.status_code == 400

    def test_allowlisted_but_unprovisioned_address_is_a_404(self, receiver_url):
        """Syncing must never CREATE an account — it would have no maildir,
        no quota and no alias. Provisioning is a separate, deliberate step."""
        response = _post(
            receiver_url,
            {"email": "daniel@circuitcenter.ai", "hash": sha512_crypt("Newpass99!")},
        )
        assert response.status_code == 404

    def test_unknown_route_and_method(self, receiver_url):
        with httpx.Client(trust_env=False, timeout=10) as client:
            assert client.get(f"{receiver_url}/healthz").json() == {"status": "ok"}
            assert client.get(f"{receiver_url}/sync-password").status_code == 404
            assert (
                client.post(
                    f"{receiver_url}/anything",
                    json={},
                    headers={"Authorization": f"Bearer {SECRET}"},
                ).status_code
                == 404
            )


class TestReceiverWrite:
    def test_updates_only_the_targeted_line(self, receiver_url, accounts_file):
        hashed = sha512_crypt("Newpass99!")
        response = _post(receiver_url, {"email": "matthew@circuitcenter.ai", "hash": hashed})
        assert response.status_code == 200
        assert response.json()["changed"] is True

        lines = accounts_file.read_text().split("\n")
        assert lines[0] == "# docker-mailserver accounts"
        assert lines[1].endswith("A" * 86), "another account's line must not move"
        assert lines[2] == f"matthew@circuitcenter.ai|{{SHA512-CRYPT}}{hashed}"
        assert lines[3].endswith("C" * 86)

    def test_accepts_the_scheme_prefixed_form(self, receiver_url, accounts_file):
        hashed = sha512_crypt("Newpass99!")
        response = _post(
            receiver_url,
            {"email": "matthew@circuitcenter.ai", "hash": f"{{SHA512-CRYPT}}{hashed}"},
        )
        assert response.status_code == 200
        assert f"matthew@circuitcenter.ai|{{SHA512-CRYPT}}{hashed}" in accounts_file.read_text()

    def test_replaying_the_same_hash_is_a_no_op_200(self, receiver_url, accounts_file):
        """Idempotency is what makes the site's retry-on-login safe to run as
        often as it likes."""
        hashed = sha512_crypt("Newpass99!")
        payload = {"email": "matthew@circuitcenter.ai", "hash": hashed}
        assert _post(receiver_url, payload).json()["changed"] is True
        after_first = accounts_file.read_text()
        second = _post(receiver_url, payload)
        assert second.status_code == 200
        assert second.json()["changed"] is False
        assert accounts_file.read_text() == after_first

    def test_address_matching_is_case_insensitive(self, receiver_url, accounts_file):
        hashed = sha512_crypt("Newpass99!")
        response = _post(receiver_url, {"email": "MATTHEW@circuitcenter.ai", "hash": hashed})
        assert response.status_code == 200
        assert f"matthew@circuitcenter.ai|{{SHA512-CRYPT}}{hashed}" in accounts_file.read_text()


class TestReceiverFailureModes:
    """A failure must answer with a STATUS, not a dropped connection: the site
    logs "HTTP 500" (diagnosable) instead of a transport error that looks
    exactly like the mail box being unreachable."""

    def test_a_missing_accounts_file_is_a_500(self, receiver_url, accounts_file):
        accounts_file.unlink()
        response = _post(
            receiver_url,
            {"email": "matthew@circuitcenter.ai", "hash": sha512_crypt("Newpass99!")},
        )
        assert response.status_code == 500

    def test_an_unexpected_error_is_a_500_not_a_dropped_connection(self, receiver_url, monkeypatch):
        def boom(*args, **kwargs):
            raise RuntimeError("something nobody predicted")

        monkeypatch.setattr(receiver, "apply_password", boom)
        response = _post(
            receiver_url,
            {"email": "matthew@circuitcenter.ai", "hash": sha512_crypt("Newpass99!")},
        )
        assert response.status_code == 500


class TestReceiverUnits:
    def test_token_comparison_is_exact(self):
        assert receiver.token_matches(f"Bearer {SECRET}", SECRET)
        assert not receiver.token_matches(f"Bearer {SECRET}x", SECRET)
        assert not receiver.token_matches(SECRET, SECRET)
        assert not receiver.token_matches(None, SECRET)
        assert not receiver.token_matches("Bearer ", "")

    def test_normalize_hash(self):
        hashed = sha512_crypt("Newpass99!")
        assert receiver.normalize_hash(hashed) == hashed
        assert receiver.normalize_hash(f"{{SHA512-CRYPT}}{hashed}") == hashed
        # Includes non-string JSON shapes: the body is attacker-controlled, so
        # the regex must be the one gate rather than a type error.
        for bad in (None, "", "Newpass99!", "$1$abc$xyz", "$6$" + "z" * 200, 42, ["$6$a$b"], {}):
            assert receiver.normalize_hash(bad) is None

    def test_rewrite_preserves_unrelated_lines_byte_for_byte(self):
        text = "# comment\n\na@x.test|{SHA512-CRYPT}$6$aa$bb\nb@x.test|{SHA512-CRYPT}$6$cc$dd\n"
        new_text, found = receiver.rewrite_accounts(text, "b@x.test", "$6$new$hash")
        assert found is True
        assert new_text.split("\n")[:3] == text.split("\n")[:3]
        assert new_text.split("\n")[3] == "b@x.test|{SHA512-CRYPT}$6$new$hash"

    def test_rewrite_reports_a_missing_account(self):
        new_text, found = receiver.rewrite_accounts("a@x.test|hash\n", "z@x.test", "$6$n$h")
        assert found is False
        assert new_text == "a@x.test|hash\n"

    def test_refuses_to_start_without_a_strong_secret(self, monkeypatch):
        """Fail-CLOSED: a credential endpoint that starts unauthenticated is a
        silent hole; systemd restart-looping with a journal line is not."""
        for value in ("", "short"):
            monkeypatch.setenv("MAIL_SYNC_SECRET", value)
            with pytest.raises(SystemExit):
                receiver.config_from_env()
        monkeypatch.setenv("MAIL_SYNC_SECRET", SECRET)
        assert receiver.config_from_env().secret == SECRET


# ── 5. The two hosts agree ──────────────────────────────────────────────────


class TestCrossHostContract:
    """Both ends carry their own copy of two lists — the mailbox allowlist and
    the hash format. Copies drift, and drift here means "that one account
    silently stopped syncing", so the copies are asserted equal."""

    def test_receiver_default_accounts_match_the_site_default(self):
        assert (
            list(receiver.DEFAULT_ACCOUNTS) == Settings.model_fields["MAIL_SYNC_MAILBOXES"].default
        )

    def test_both_ends_share_one_hash_format(self):
        assert receiver.SHA512_CRYPT_RE.pattern == SHA512_CRYPT_RE.pattern
        hashed = sha512_crypt("Newpass99!")
        assert receiver.normalize_hash(hashed) == hashed

    def test_the_receiver_path_matches_what_the_site_posts(self):
        assert mail_sync.SYNC_PATH == receiver.SYNC_PATH


def _api_service_block(path):
    text = path.read_text()
    match = re.search(r"^  api:\n(.*?)(?=^  \S|\Z)", text, re.M | re.S)
    assert match, f"no `api:` service found in {path.name}"
    return match.group(1)


class TestComposePassthrough:
    """`Settings` declares no env_file and the api container has NO volume
    mount, so a setting absent from the compose `environment:` block is
    unreachable from /opt/circuits-com/.env no matter what that file says —
    the same trap DEMO_LOGIN_ENABLED fell into (test_compose_env_passthrough)."""

    @pytest.mark.parametrize("path", [DEV_COMPOSE, PROD_COMPOSE])
    def test_url_and_secret_reach_the_container(self, path):
        api = _api_service_block(path)
        for key in ("MAIL_SYNC_URL", "MAIL_SYNC_SECRET"):
            assert re.search(rf"^\s*{key}:\s*\$\{{{key}", api, re.M), (
                f"{path.name}: the api service must pass {key} through, or the "
                "push-sync channel can never be armed from the host .env."
            )

    @pytest.mark.parametrize("path", [DEV_COMPOSE, PROD_COMPOSE])
    def test_the_compose_mailbox_default_matches_the_code_default(self, path):
        """An EMPTY MAIL_SYNC_MAILBOXES would disable syncing for every account
        rather than for none, so the compose fallback must spell out the same
        five addresses the code defaults to."""
        api = _api_service_block(path)
        match = re.search(
            r"^\s*MAIL_SYNC_MAILBOXES:\s*\$\{MAIL_SYNC_MAILBOXES:-([^}]*)\}", api, re.M
        )
        assert match, f"{path.name}: MAIL_SYNC_MAILBOXES passthrough missing"
        assert [a.strip() for a in match.group(1).split(",")] == Settings.model_fields[
            "MAIL_SYNC_MAILBOXES"
        ].default

    def test_no_secret_is_committed(self):
        """Placeholders only — the real token lives in /opt/circuits-com/.env on
        both hosts and nowhere else."""
        for path in (DEV_COMPOSE, PROD_COMPOSE):
            api = _api_service_block(path)
            assert "MAIL_SYNC_SECRET: ${MAIL_SYNC_SECRET:-}" in api
        env_example = (ROOT / "mail" / "sync-receiver" / "mail-sync.env.example").read_text()
        assert "MAIL_SYNC_SECRET=replace-me" in env_example
