"""The demo account is gone. Registration replaced it.

These assertions are the difference between "removed" and "hidden": a route
that still exists but is undocumented is still a door.
"""
import pathlib

from app.services import auth_service

REPO = pathlib.Path(__file__).resolve().parents[2]


def test_the_demo_endpoint_is_gone(client):
    assert client.post("/api/auth/demo").status_code == 404


def test_the_seed_no_longer_creates_a_demo_account():
    import pathlib as _p

    seed = (_p.Path(__file__).resolve().parents[1] / "app/db/seed.py").read_text()
    assert '("demo", "demo"' not in seed


def test_the_demo_helpers_are_gone():
    for name in ("is_demo_user", "demo_login_email", "DEMO_READ_ONLY_DETAIL",
                 "DEMO_WRITE_EXEMPT_PATHS"):
        assert not hasattr(auth_service, name), f"{name} still exists"


def test_the_public_demo_password_does_not_authenticate(client, seeded_db):
    """The regression this feature could most easily have introduced.

    The demo row was seeded with the literal password "demo", role 'admin' and
    must_change_password false. The ONLY thing that stopped those public
    credentials working at /api/auth/login was a deliberate refusal in
    _find_login_user. Removing the demo endpoint while leaving the row would
    have promoted a documented public password to a live administrator login —
    strictly worse than before the demo existed. Alembic 044 deletes the row;
    this asserts the door is shut.
    """
    resp = client.post("/api/auth/login",
                       json={"email": "demo@circuitcenter.ai", "password": "demo"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid credentials"


def test_migration_044_deletes_the_demo_row():
    import pathlib as _p

    src = (_p.Path(__file__).resolve().parents[1]
           / "alembic/versions/044_retire_demo_account.py").read_text()
    assert "DELETE FROM users" in src
    assert "demo@circuitcenter.ai" in src


def test_no_demo_user_is_seeded(db, seeded_db):
    # seeded_db returns a dict of fixtures; `db` is the session.
    from app.models import User

    assert db.query(User).filter(
        User.email == "demo@circuitcenter.ai").count() == 0


def test_the_synthetic_inbox_module_is_deleted():
    assert not (REPO / "api/app/services/demo_messages.py").exists()


def test_the_unrelated_demos_survive():
    # DEMO DATA mode is an admin display toggle, and the wizard's markers are
    # what make real catalog data undeletable. Neither is the demo ACCOUNT.
    assert (REPO / "frontend/src/admin/contexts/DemoContext.tsx").exists()
    assert (REPO / "frontend/src/admin/wizard/demoMarkers.ts").exists()
    seed = (REPO / "api/app/db/seed.py").read_text()
    assert "SEED_DEMO_CATALOG" in seed
