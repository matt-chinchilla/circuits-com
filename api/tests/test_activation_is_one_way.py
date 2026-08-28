"""Activation is a one-way door, and the email rides on that.

The activation email used to be guarded by `if user.activated_at is None`,
which correctly refused to re-send while an account was ALREADY active — but
Deactivate set that column back to NULL, so the next Activate was a genuinely
fresh edge and mailed again. Measured before the fix: one off/on cycle sent a
second email, two cycles sent a third.

Making activation one-way removes the cycle rather than papering over it, so
the existing NULL check becomes sufficient on its own and no extra
"email already sent" column is needed. These tests pin both halves: the door
only opens, and the mail only goes once.
"""
from datetime import UTC, datetime
from unittest.mock import patch

from app.models import User

ONE_WAY_DETAIL = "activation_is_one_way"


def _customer(db, email="oneway@test.example"):
    u = User(
        username=email,
        email=email,
        password_hash="x",
        role="user",
        first_name="One",
        last_name="Way",
        email_verified_at=datetime.now(UTC),
    )
    db.add(u)
    db.commit()
    return u


class TestTheDoorOnlyOpens:
    def test_activation_stamps(self, client, db, seeded_db, auth_header):
        u = _customer(db)
        r = client.patch(
            f"/api/admin/users/{u.id}", json={"activated": True}, headers=auth_header()
        )
        assert r.status_code == 200
        assert r.json()["activated_at"] is not None

    def test_deactivation_is_refused(self, client, db, seeded_db, auth_header):
        u = _customer(db)
        h = auth_header()
        client.patch(f"/api/admin/users/{u.id}", json={"activated": True}, headers=h)
        r = client.patch(f"/api/admin/users/{u.id}", json={"activated": False}, headers=h)
        assert r.status_code == 409
        assert r.json()["detail"] == ONE_WAY_DETAIL

    def test_a_refused_deactivation_leaves_the_account_active(
        self, client, db, seeded_db, auth_header
    ):
        """The 409 must not half-apply. An account that was active stays active."""
        u = _customer(db)
        h = auth_header()
        client.patch(f"/api/admin/users/{u.id}", json={"activated": True}, headers=h)
        client.patch(f"/api/admin/users/{u.id}", json={"activated": False}, headers=h)
        db.expire_all()
        assert db.query(User).filter(User.id == u.id).first().activated_at is not None

    def test_deactivating_a_never_activated_account_is_also_refused(
        self, client, db, seeded_db, auth_header
    ):
        """`activated: false` is not a valid instruction in either state.

        Accepting it as a no-op on an inactive account would leave the API
        claiming a capability the UI does not offer and the model does not
        support.
        """
        u = _customer(db)
        r = client.patch(
            f"/api/admin/users/{u.id}", json={"activated": False}, headers=auth_header()
        )
        assert r.status_code == 409

    def test_a_refused_deactivation_does_not_apply_the_links_alongside_it(
        self, client, db, seeded_db, auth_header
    ):
        """The request either happens or it does not — no partial writes.

        The refused body must try to CHANGE something real: an earlier version
        sent `manufacturer_id: None` at an account whose link was already NULL
        and asserted an untouched column — a no-op that stayed green even if
        the route applied links before raising the 409. So: link a real
        supplier first, have the refused body try to clear it, and assert the
        link survived.
        """
        u = _customer(db)
        h = auth_header()
        client.patch(f"/api/admin/users/{u.id}", json={"activated": True}, headers=h)
        supplier_id = str(seeded_db["supplier2"].id)
        r = client.patch(
            f"/api/admin/users/{u.id}", json={"supplier_id": supplier_id}, headers=h
        )
        assert r.status_code == 200
        refused = client.patch(
            f"/api/admin/users/{u.id}",
            json={"activated": False, "supplier_id": None},
            headers=h,
        )
        assert refused.status_code == 409
        db.expire_all()
        assert str(db.query(User).filter(User.id == u.id).first().supplier_id) == supplier_id


class TestTheMailGoesOnce:
    def test_one_email_no_matter_how_many_times_you_press_it(
        self, client, db, seeded_db, auth_header
    ):
        u = _customer(db)
        h = auth_header()
        with patch("app.routes.admin_users.email_service.send_activation_email") as send:
            for _ in range(5):
                client.patch(
                    f"/api/admin/users/{u.id}", json={"activated": True}, headers=h
                )
            # And the sequence that used to defeat the old guard.
            for _ in range(3):
                client.patch(
                    f"/api/admin/users/{u.id}", json={"activated": False}, headers=h
                )
                client.patch(
                    f"/api/admin/users/{u.id}", json={"activated": True}, headers=h
                )
        assert send.call_count == 1, (
            f"expected exactly one activation email, got {send.call_count} — the "
            "off/on cycle is what used to re-send"
        )

    def test_an_unrelated_patch_does_not_mail(self, client, db, seeded_db, auth_header):
        u = _customer(db)
        h = auth_header()
        with patch("app.routes.admin_users.email_service.send_activation_email") as send:
            client.patch(f"/api/admin/users/{u.id}", json={"activated": True}, headers=h)
            client.patch(
                f"/api/admin/users/{u.id}", json={"manufacturer_id": None}, headers=h
            )
        assert send.call_count == 1
