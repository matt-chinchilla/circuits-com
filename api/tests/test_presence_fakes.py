"""Fake-presence lever (presence_fakes singleton + circuits --fakeuser).

The route unions FAKE_PRESENCE_ROSTER[:count] into every ping response.
Contract under test: missing row => no fakes; count is clamped to the roster
size; fake ids are "fake-N" (never collide with real UUIDs, never filtered by
the frontend's self-match); real presence is unaffected.
"""

from app.models.presence_fake import PresenceFake
from app.routes.admin_presence import FAKE_PRESENCE_ROSTER


def _set_count(db, count):
    row = db.get(PresenceFake, 1)
    if row is None:
        row = PresenceFake(id=1, count=count)
        db.add(row)
    else:
        row.count = count
    db.commit()


def test_no_row_means_no_fakes(client, seeded_db, auth_header):
    resp = client.post("/api/admin/presence/ping", headers=auth_header())
    assert [u["username"] for u in resp.json()] == ["admin"]


def test_count_appends_fakes_after_real_users(client, db, seeded_db, auth_header):
    _set_count(db, 3)
    resp = client.post("/api/admin/presence/ping", headers=auth_header())
    body = resp.json()
    assert body[0]["username"] == "admin"  # real users first, stable order
    fakes = body[1:]
    assert [u["username"] for u in fakes] == [u for u, _ in FAKE_PRESENCE_ROSTER[:3]]
    assert [u["user_id"] for u in fakes] == ["fake-1", "fake-2", "fake-3"]
    assert all(u["role"] == "admin" for u in fakes)
    # Display names ride the `name` field the UI already falls back through.
    assert fakes[0]["name"] == FAKE_PRESENCE_ROSTER[0][1]


def test_count_max_shows_full_roster(client, db, seeded_db, auth_header):
    _set_count(db, 10)  # 10 is the DB-enforced ceiling (CHECK holds on BOTH engines)
    resp = client.post("/api/admin/presence/ping", headers=auth_header())
    assert len(resp.json()) == 1 + len(FAKE_PRESENCE_ROSTER)


def test_range_check_enforced_by_db(db):
    import pytest as _pytest
    from sqlalchemy.exc import IntegrityError

    db.add(PresenceFake(id=1, count=99))
    with _pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_zero_and_downgrade_to_zero(client, db, seeded_db, auth_header):
    _set_count(db, 2)
    assert len(client.post("/api/admin/presence/ping", headers=auth_header()).json()) == 3
    _set_count(db, 0)
    assert [u["username"] for u in client.post(
        "/api/admin/presence/ping", headers=auth_header()
    ).json()] == ["admin"]


def test_roster_is_ten_unique_fictional_slots():
    assert len(FAKE_PRESENCE_ROSTER) == 10
    usernames = [u for u, _ in FAKE_PRESENCE_ROSTER]
    assert len(set(usernames)) == 10
    # Never a real seeded staff account — fakes must not shadow real presence.
    assert not set(usernames) & {"matthew", "anthony", "daniel", "ronald", "demo", "admin"}
