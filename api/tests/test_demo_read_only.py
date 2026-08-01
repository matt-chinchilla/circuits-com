"""The demo account is READ-ONLY and always sees demo data (Task 8, P1 auth).

`POST /api/auth/demo` hands a real admin session to any anonymous visitor who
clicks "See Demo", so the account behind that button must not be able to change
anything on the live site. Two server-side contracts live here — a client-side
guard would be decoration:

1. **Every write is refused.** `auth_service.get_current_user` — the ONE
   dependency every admin route already takes — answers
   403 ``demo_account_read_only`` to POST/PUT/PATCH/DELETE from the demo
   account. GET stays fully open so the console renders normally. Because the
   gate lives in the shared dependency rather than per-route, an endpoint added
   next month is covered without anyone remembering to cover it.
2. **DEMO DATA mode is forced on.** The session payload (and `/auth/me`) carry
   a server-signalled ``is_demo`` flag; the console reads that, not a guess
   from the username, so a prospect never sees real revenue, customer names or
   sponsor contacts.

A real admin must be untouched by both.
"""

import bcrypt
import pytest

from app.config import settings
from app.services import auth_service as svc

ADMIN_EMAIL = "admin@test.example"
ADMIN_PASSWORD = "testpass123"
DEMO_EMAIL = "demo@circuitcenter.ai"


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def demo_token(client, db, seeded_db):
    """A live demo session — minted the only way a visitor can get one."""
    from app.models import User

    db.add(
        User(
            username="demo",
            password_hash=bcrypt.hashpw(b"demo", bcrypt.gensalt()).decode(),
            # role stays "admin" on purpose: the demo must SEE the whole
            # console (admin-only sidebar sections included) to be worth
            # showing a prospect. The read-only gate, not the role, is what
            # makes that safe.
            role="admin",
            email=DEMO_EMAIL,
        )
    )
    db.commit()
    resp = client.post("/api/auth/demo")
    assert resp.status_code == 200, resp.text
    return resp.json()["token"]


@pytest.fixture
def admin_token(client, seeded_db):
    resp = client.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    return resp.json()["token"]


def _writes(seeded_db):
    """(label, method, url, json) for one write against each admin surface."""
    supplier = seeded_db["supplier1"]
    parent = seeded_db["parent"]
    part = seeded_db["part1"]
    return [
        (
            "sponsor-create",
            "post",
            "/api/admin/sponsors/",
            {
                "supplier_id": str(supplier.id),
                "category_id": str(parent.id),
                "tier": "Platinum",
                "amount": "750.00",
                "status": "Active",
            },
        ),
        (
            "sponsor-update",
            "patch",
            f"/api/admin/sponsors/{seeded_db['sponsor'].id}",
            {"amount": "1.00"},
        ),
        ("sponsor-delete", "delete", f"/api/admin/sponsors/{seeded_db['sponsor'].id}", None),
        (
            "part-create",
            "post",
            "/api/parts/",
            {"sku": "DEMO-WRITE-1", "manufacturer_name": "Acme"},
        ),
        ("part-update", "put", f"/api/parts/{part.id}", {"description": "edited"}),
        ("part-delete", "delete", f"/api/parts/{part.id}", None),
        (
            "supplier-create",
            "post",
            "/api/suppliers/",
            {"name": "Demo Written Supplier"},
        ),
        ("supplier-update", "put", f"/api/suppliers/{supplier.id}", {"name": "Renamed"}),
        ("supplier-delete", "delete", f"/api/suppliers/{supplier.id}", None),
        (
            "expense-create",
            "post",
            "/api/admin/expenses/",
            {
                "category": "infrastructure",
                "vendor": "Amazon Web Services",
                "amount": "21.23",
                "period_start": "2026-07-01",
                "period_end": "2026-07-31",
            },
        ),
    ]


def _send(client, method, url, body, token):
    return getattr(client, method)(
        url, **({"json": body} if body is not None else {}), headers=_bearer(token)
    )


READS = [
    "/api/admin/sponsors/",
    "/api/parts/",
    "/api/suppliers/",
    "/api/admin/expenses/",
    "/api/dashboard/stats",
]


class TestDemoCannotWrite:
    def test_every_admin_write_is_refused(self, client, seeded_db, demo_token):
        for label, method, url, body in _writes(seeded_db):
            resp = _send(client, method, url, body, demo_token)
            assert resp.status_code == 403, f"{label}: {resp.status_code} {resp.text}"
            assert resp.json()["detail"] == svc.DEMO_READ_ONLY_DETAIL, label

    def test_the_refusal_actually_leaves_the_data_alone(self, client, db, seeded_db, demo_token):
        from app.models import Part

        before = db.query(Part).count()
        assert (
            client.delete(
                f"/api/parts/{seeded_db['part1'].id}", headers=_bearer(demo_token)
            ).status_code
            == 403
        )
        db.expire_all()
        assert db.query(Part).count() == before

    def test_the_batch_import_endpoint_is_covered_too(self, client, seeded_db, demo_token):
        # The bulk write is the most damaging one — it must not be the one that
        # slipped through because it lives on a different router.
        resp = client.post(
            "/api/parts/batch",
            json={"supplier_id": str(seeded_db["supplier1"].id), "parts": []},
            headers=_bearer(demo_token),
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == svc.DEMO_READ_ONLY_DETAIL

    def test_a_message_patch_is_refused(self, client, seeded_db, demo_token):
        import uuid as uuid_mod

        resp = client.patch(
            f"/api/admin/messages/{uuid_mod.uuid4()}",
            json={"status": "read"},
            headers=_bearer(demo_token),
        )
        # 403 from the gate, NOT the 404 the route would give for a missing row:
        # the gate has to run before the handler ever does.
        assert resp.status_code == 403
        assert resp.json()["detail"] == svc.DEMO_READ_ONLY_DETAIL

    def test_the_demo_cannot_rotate_its_own_password(self, client, seeded_db, demo_token):
        """Not a security hole — a griefing one. The demo password is public,
        so any visitor could rotate it and, by stamping password_changed_at,
        sign out every other prospect's live session."""
        resp = client.post(
            "/api/auth/change-password",
            json={"current_password": "demo", "new_password": "Newpass99!"},
            headers=_bearer(demo_token),
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == svc.DEMO_READ_ONLY_DETAIL


class TestDemoCanStillRead:
    def test_every_listing_renders(self, client, seeded_db, demo_token):
        for url in READS:
            resp = client.get(url, headers=_bearer(demo_token))
            assert resp.status_code == 200, f"{url}: {resp.status_code} {resp.text}"

    def test_detail_reads_work(self, client, seeded_db, demo_token):
        part = seeded_db["part1"]
        supplier = seeded_db["supplier1"]
        assert client.get(f"/api/parts/{part.id}", headers=_bearer(demo_token)).status_code == 200
        assert (
            client.get(f"/api/suppliers/{supplier.id}", headers=_bearer(demo_token)).status_code
            == 200
        )

    def test_me_and_logout_still_work(self, client, seeded_db, demo_token):
        assert client.get("/api/auth/me", headers=_bearer(demo_token)).status_code == 200
        assert client.post("/api/auth/logout", headers=_bearer(demo_token)).status_code == 200

    def test_the_presence_heartbeat_is_exempt(self, client, seeded_db, demo_token):
        """The one allowed write: it stamps the caller's own last_seen_at, no
        business data, and it polls every 15s — blocking it would machine-gun
        the console's read-only notice."""
        resp = client.post("/api/admin/presence/ping", headers=_bearer(demo_token))
        assert resp.status_code == 200


class TestDemoNeverSeesRealPeople:
    """The inbox is real public form submissions — names, emails, phone
    numbers. An anonymous visitor one click from that table is the exposure the
    See Demo button creates, so a demo session gets a synthetic roster."""

    def _seed_real_message(self, db):
        import uuid as uuid_mod

        from app.models import Message

        msg = Message(
            # Message.id is a String(36), not a UUID column.
            id=str(uuid_mod.uuid4()),
            type="contact",
            status="new",
            seq=1,
            payload={
                "name": "Real Person",
                "email": "real.person@customer.example",
                "subject": "Real subject",
                "message": "Real message body",
            },
        )
        db.add(msg)
        db.commit()
        return msg

    def test_the_list_is_substituted_wholesale(self, client, db, seeded_db, demo_token):
        real = self._seed_real_message(db)
        body = client.get("/api/admin/messages/", headers=_bearer(demo_token)).json()
        assert body, "the demo inbox must not be empty — the page has to render"
        ids = {row["id"] for row in body}
        assert str(real.id) not in ids
        serialized = str(body)
        assert "Real Person" not in serialized
        assert "real.person@customer.example" not in serialized

    def test_a_real_message_id_is_a_404_for_the_demo(self, client, db, seeded_db, demo_token):
        real = self._seed_real_message(db)
        resp = client.get(f"/api/admin/messages/{real.id}", headers=_bearer(demo_token))
        assert resp.status_code == 404

    def test_the_synthetic_detail_page_resolves(self, client, seeded_db, demo_token):
        listed = client.get("/api/admin/messages/", headers=_bearer(demo_token)).json()
        first = listed[0]["id"]
        resp = client.get(f"/api/admin/messages/{first}", headers=_bearer(demo_token))
        assert resp.status_code == 200
        assert resp.json()["id"] == first

    def test_a_real_admin_still_sees_the_real_inbox(self, client, db, seeded_db, admin_token):
        real = self._seed_real_message(db)
        body = client.get("/api/admin/messages/", headers=_bearer(admin_token)).json()
        assert str(real.id) in {row["id"] for row in body}
        assert (
            client.get(f"/api/admin/messages/{real.id}", headers=_bearer(admin_token)).json()[
                "payload"
            ]["name"]
            == "Real Person"
        )


class TestRealAdminIsUnaffected:
    def test_the_same_writes_all_succeed(self, client, seeded_db, admin_token):
        for label, method, url, body in _writes(seeded_db):
            resp = _send(client, method, url, body, admin_token)
            assert resp.status_code < 400, f"{label}: {resp.status_code} {resp.text}"

    def test_the_admin_session_is_not_flagged_as_demo(self, client, seeded_db, admin_token):
        assert client.get("/api/auth/me", headers=_bearer(admin_token)).json()["is_demo"] is False

    def test_an_admin_whose_email_merely_resembles_the_demo_can_write(
        self, client, db, seeded_db, monkeypatch
    ):
        # Identity is an exact (case-insensitive) address match — no prefix or
        # substring matching that could lock a real "demo-team@" admin out.
        monkeypatch.setattr(settings, "DEMO_LOGIN_EMAIL", "demo@circuitcenter.ai")
        user = seeded_db["admin_user"]
        user.email = "demo@circuitcenter.ai.attacker.example"
        db.commit()
        token = client.post(
            "/api/auth/login",
            json={"email": user.email, "password": ADMIN_PASSWORD},
        ).json()["token"]
        resp = client.post(
            "/api/suppliers/", json={"name": "Still Allowed"}, headers=_bearer(token)
        )
        assert resp.status_code < 400, resp.text


class TestDemoSessionSignalsDemoData:
    def test_the_login_payload_carries_the_flag(self, client, db, seeded_db, demo_token):
        # demo_token already asserted the 200; re-post to read the body.
        body = client.post("/api/auth/demo").json()
        assert body["user"]["is_demo"] is True
        assert body["must_change_password"] is False

    def test_me_carries_it_too_so_a_reloaded_tab_rediscovers_it(
        self, client, seeded_db, demo_token
    ):
        assert client.get("/api/auth/me", headers=_bearer(demo_token)).json()["is_demo"] is True

    def test_the_demo_token_still_authenticates(self, client, seeded_db, demo_token):
        assert client.get("/api/admin/sponsors/", headers=_bearer(demo_token)).status_code == 200


class TestIdentityAndAllowlist:
    def test_is_demo_user_matches_the_configured_address_case_insensitively(
        self, db, seeded_db, monkeypatch
    ):
        user = seeded_db["admin_user"]
        monkeypatch.setattr(settings, "DEMO_LOGIN_EMAIL", "Admin@Test.EXAMPLE")
        assert svc.is_demo_user(user) is True
        monkeypatch.setattr(settings, "DEMO_LOGIN_EMAIL", "someone-else@test.example")
        assert svc.is_demo_user(user) is False

    def test_a_blank_configured_address_marks_nobody_as_demo(self, seeded_db, monkeypatch):
        # Otherwise every user with an empty email would inherit the demo's
        # restrictions the moment the setting was cleared.
        monkeypatch.setattr(settings, "DEMO_LOGIN_EMAIL", "")
        assert svc.is_demo_user(seeded_db["admin_user"]) is False
        assert svc.is_demo_user(None) is False

    def test_the_gate_ignores_the_enabled_switch(self, client, seeded_db, demo_token, monkeypatch):
        """Turning the demo door off must not un-restrict sessions already
        minted through it — they live for 24h."""
        monkeypatch.setattr(settings, "DEMO_LOGIN_ENABLED", False)
        resp = client.post("/api/suppliers/", json={"name": "Sneaky"}, headers=_bearer(demo_token))
        assert resp.status_code == 403
        assert resp.json()["detail"] == svc.DEMO_READ_ONLY_DETAIL

    def test_the_write_exemption_list_is_exactly_one_endpoint(self):
        """A security allowlist that grows quietly is the failure mode. Pinning
        the whole set forces any addition through a reviewed test edit."""
        assert svc.DEMO_WRITE_EXEMPT_PATHS == frozenset({"/api/admin/presence/ping"})

    def test_only_state_changing_verbs_are_gated(self):
        assert svc.MUTATING_METHODS == frozenset({"POST", "PUT", "PATCH", "DELETE"})
        assert "GET" not in svc.MUTATING_METHODS
