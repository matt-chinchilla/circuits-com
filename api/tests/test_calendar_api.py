"""/api/calendar/* — CRUD, the window filter, auth, and the meeting_url guard.

The two contracts that are not merely "the CRUD works":

* **The demo account is refused on READS as well as writes.** ``POST
  /api/auth/demo`` hands a real session to any anonymous visitor, so an open
  read here would publish the company's meeting schedule — titles, times, join
  links — to anyone who clicks "See Demo". ``get_current_user``'s existing
  read-only gate covers mutations only, which is why this module has its own.
* **``meeting_url`` is validated at the write boundary.** It becomes an
  ``href`` in the Roundcube plugin, and a stored ``javascript:`` in a field
  that becomes an href is the exact stored-XSS shape this repo has already
  shipped once.
"""

import uuid
from datetime import UTC, datetime, timedelta

import bcrypt
import pytest

from app.config import settings
from app.models import CalendarEvent, CalendarReminderSend
from app.routes.calendar import CALENDAR_SECRET_HEADER, DEMO_CALENDAR_FORBIDDEN_DETAIL

BASE = "/api/calendar/events"
DEMO_EMAIL = "demo@circuitcenter.ai"
SECRET = "calendar-shared-secret-value-32-chars-long"

NOW = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


def _payload(**overrides):
    body = {
        "title": "Weekly sync",
        "starts_at": "2026-08-11T14:00:00Z",
        "ends_at": "2026-08-11T15:00:00Z",
    }
    body.update(overrides)
    return body


@pytest.fixture
def admin_headers(client, seeded_db, auth_header):
    return auth_header()


@pytest.fixture
def demo_headers(client, db, seeded_db):
    from app.models import User

    db.add(
        User(
            username="demo",
            password_hash=bcrypt.hashpw(b"demo", bcrypt.gensalt()).decode(),
            role="admin",
            email=DEMO_EMAIL,
        )
    )
    db.commit()
    resp = client.post("/api/auth/demo")
    assert resp.status_code == 200, resp.text
    return _bearer(resp.json()["token"])


def _make_event(db, **overrides):
    fields = {
        "id": uuid.uuid4(),
        "title": "Seeded event",
        "starts_at": NOW + timedelta(days=1),
        "ends_at": NOW + timedelta(days=1, hours=1),
    }
    fields.update(overrides)
    event = CalendarEvent(**fields)
    db.add(event)
    db.commit()
    return event


# ── CRUD ────────────────────────────────────────────────────────────────────


class TestCrud:
    def test_create_read_update_delete_round_trip(self, client, db, admin_headers):
        created = client.post(BASE, json=_payload(), headers=admin_headers)
        assert created.status_code == 201, created.text
        event_id = created.json()["id"]
        assert created.json()["title"] == "Weekly sync"

        listed = client.get(BASE, headers=admin_headers).json()
        assert [row["id"] for row in listed] == [event_id]

        patched = client.patch(
            f"{BASE}/{event_id}", json={"location": "Room 2"}, headers=admin_headers
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["location"] == "Room 2"
        # An untouched field stays untouched (exclude_unset).
        assert patched.json()["title"] == "Weekly sync"

        assert client.delete(f"{BASE}/{event_id}", headers=admin_headers).status_code == 204
        assert client.get(BASE, headers=admin_headers).json() == []

    def test_defaults_match_the_design(self, client, admin_headers):
        body = client.post(BASE, json=_payload(), headers=admin_headers).json()
        assert body["remind_day_before"] is True
        assert body["remind_hour_before"] is True
        assert body["notify_email"] is True
        assert body["notify_sms"] is False
        assert body["all_day"] is False

    def test_the_creator_is_recorded(self, client, seeded_db, admin_headers):
        body = client.post(BASE, json=_payload(), headers=admin_headers).json()
        assert body["created_by_id"] == str(seeded_db["admin_user"].id)

    def test_times_come_back_as_utc_even_though_sqlite_stores_them_naive(
        self, client, admin_headers
    ):
        """Without the re-stamp a PHP client would parse `...T14:00:00` in
        server-local time and draw the meeting in the wrong hour."""
        body = client.post(BASE, json=_payload(), headers=admin_headers).json()
        assert body["starts_at"].endswith("Z") or body["starts_at"].endswith("+00:00")

    def test_a_non_utc_offset_is_normalized_rather_than_truncated(self, client, db, admin_headers):
        """SQLAlchemy's SQLite DATETIME binding DROPS a tzinfo offset instead of
        converting it, so an un-normalized `+02:00` would land two hours late."""
        body = client.post(
            BASE,
            json=_payload(
                starts_at="2026-08-11T16:00:00+02:00", ends_at="2026-08-11T17:00:00+02:00"
            ),
            headers=admin_headers,
        ).json()
        stored = db.query(CalendarEvent).filter(CalendarEvent.id == uuid.UUID(body["id"])).one()
        # 16:00+02:00 is 14:00 UTC.
        assert stored.starts_at.hour == 14

    def test_ends_before_starts_is_a_422(self, client, admin_headers):
        resp = client.post(
            BASE,
            json=_payload(starts_at="2026-08-11T15:00:00Z", ends_at="2026-08-11T14:00:00Z"),
            headers=admin_headers,
        )
        assert resp.status_code == 422

    def test_a_partial_patch_cannot_invert_the_event(self, client, db, admin_headers):
        event = _make_event(db)
        resp = client.patch(
            f"{BASE}/{event.id}",
            json={"ends_at": (NOW - timedelta(days=5)).isoformat()},
            headers=admin_headers,
        )
        assert resp.status_code == 422

    def test_explicit_null_on_a_not_null_column_is_a_422_not_a_500(self, client, db, admin_headers):
        event = _make_event(db)
        resp = client.patch(f"{BASE}/{event.id}", json={"title": None}, headers=admin_headers)
        assert resp.status_code == 422

    def test_nullable_fields_can_be_cleared(self, client, db, admin_headers):
        event = _make_event(db, location="Room 1", notes="agenda")
        body = client.patch(
            f"{BASE}/{event.id}", json={"location": None, "notes": None}, headers=admin_headers
        ).json()
        assert body["location"] is None
        assert body["notes"] is None

    def test_a_malformed_id_is_a_404_not_a_500(self, client, admin_headers):
        assert client.get(BASE, headers=admin_headers).status_code == 200
        assert (
            client.patch(
                f"{BASE}/not-a-uuid", json={"title": "x"}, headers=admin_headers
            ).status_code
            == 404
        )
        assert client.delete(f"{BASE}/not-a-uuid", headers=admin_headers).status_code == 404

    def test_deleting_an_event_takes_its_ledger_rows_with_it(self, client, db, admin_headers):
        event = _make_event(db)
        db.add(
            CalendarReminderSend(
                id=uuid.uuid4(), event_id=event.id, kind="day_before", channel="email"
            )
        )
        db.commit()
        assert client.delete(f"{BASE}/{event.id}", headers=admin_headers).status_code == 204
        db.expire_all()
        assert db.query(CalendarReminderSend).count() == 0


# ── Window filtering ────────────────────────────────────────────────────────


class TestWindow:
    def test_it_returns_events_overlapping_the_window(self, client, db, admin_headers):
        _make_event(db, title="inside", starts_at=NOW, ends_at=NOW + timedelta(hours=1))
        _make_event(
            db,
            title="before",
            starts_at=NOW - timedelta(days=10),
            ends_at=NOW - timedelta(days=10) + timedelta(hours=1),
        )
        _make_event(
            db,
            title="after",
            starts_at=NOW + timedelta(days=10),
            ends_at=NOW + timedelta(days=10, hours=1),
        )
        resp = client.get(
            BASE,
            params={
                "from": (NOW - timedelta(days=1)).isoformat(),
                "to": (NOW + timedelta(days=1)).isoformat(),
            },
            headers=admin_headers,
        )
        titles = {row["title"] for row in resp.json()}
        assert titles == {"inside"}

    def test_a_straddling_event_is_included(self, client, db, admin_headers):
        """Overlap, not containment: a Mon-Fri event must appear when the grid
        asks for the week it straddles."""
        _make_event(
            db,
            title="straddles",
            starts_at=NOW - timedelta(days=3),
            ends_at=NOW + timedelta(days=3),
        )
        resp = client.get(
            BASE,
            params={"from": NOW.isoformat(), "to": (NOW + timedelta(hours=1)).isoformat()},
            headers=admin_headers,
        )
        assert [row["title"] for row in resp.json()] == ["straddles"]

    def test_omitting_the_bounds_returns_everything_sorted(self, client, db, admin_headers):
        _make_event(db, title="second", starts_at=NOW + timedelta(days=2))
        _make_event(db, title="first", starts_at=NOW + timedelta(days=1))
        assert [r["title"] for r in client.get(BASE, headers=admin_headers).json()] == [
            "first",
            "second",
        ]

    def test_only_one_bound_is_allowed(self, client, db, admin_headers):
        _make_event(
            db,
            title="past",
            starts_at=NOW - timedelta(days=5),
            ends_at=NOW - timedelta(days=5) + timedelta(hours=1),
        )
        _make_event(
            db,
            title="future",
            starts_at=NOW + timedelta(days=5),
            ends_at=NOW + timedelta(days=5, hours=1),
        )
        resp = client.get(BASE, params={"from": NOW.isoformat()}, headers=admin_headers)
        assert [r["title"] for r in resp.json()] == ["future"]


# ── Rescheduling clears the ledger ──────────────────────────────────────────


class TestRescheduleClearsTheLedger:
    def _ledger(self, db, event_id):
        return (
            db.query(CalendarReminderSend).filter(CalendarReminderSend.event_id == event_id).count()
        )

    def _seed_ledger(self, db, event):
        for kind in ("day_before", "hour_before"):
            db.add(
                CalendarReminderSend(id=uuid.uuid4(), event_id=event.id, kind=kind, channel="email")
            )
        db.commit()

    def test_moving_starts_at_clears_every_row(self, client, db, admin_headers):
        """Otherwise the old rows silently swallow both reminders against the
        new time — and nothing errors, the mail simply never arrives."""
        event = _make_event(db)
        self._seed_ledger(db, event)
        assert self._ledger(db, event.id) == 2

        resp = client.patch(
            f"{BASE}/{event.id}",
            json={
                "starts_at": (NOW + timedelta(days=4)).isoformat(),
                "ends_at": (NOW + timedelta(days=4, hours=1)).isoformat(),
            },
            headers=admin_headers,
        )
        assert resp.status_code == 200, resp.text
        db.expire_all()
        assert self._ledger(db, event.id) == 0

    def test_an_unrelated_edit_leaves_the_ledger_alone(self, client, db, admin_headers):
        """Renaming a meeting must not re-send reminders that already went out."""
        event = _make_event(db)
        self._seed_ledger(db, event)
        client.patch(f"{BASE}/{event.id}", json={"title": "Renamed"}, headers=admin_headers)
        db.expire_all()
        assert self._ledger(db, event.id) == 2

    def test_re_sending_the_same_starts_at_is_not_a_reschedule(self, client, db, admin_headers):
        event = _make_event(db)
        self._seed_ledger(db, event)
        client.patch(
            f"{BASE}/{event.id}",
            json={"starts_at": event.starts_at.replace(tzinfo=UTC).isoformat(), "title": "Same"},
            headers=admin_headers,
        )
        db.expire_all()
        assert self._ledger(db, event.id) == 2


# ── meeting_url ─────────────────────────────────────────────────────────────


class TestMeetingUrlValidation:
    HOSTILE = [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "  javascript:alert(1)  ",
        "data:text/html;base64,PHNjcmlwdD4=",
        "data:image/png;base64,iVBORw0KGgo=",
        "vbscript:msgbox(1)",
        "file:///etc/passwd",
        "http:evil-without-a-host",
    ]
    SAFE = [
        "https://teams.microsoft.com/l/meetup-join/abc?p=123",
        "http://meet.example.test/room",
    ]

    @pytest.mark.parametrize("value", HOSTILE)
    def test_hostile_schemes_are_rejected_on_create(self, client, admin_headers, value):
        resp = client.post(BASE, json=_payload(meeting_url=value), headers=admin_headers)
        assert resp.status_code == 422, f"{value!r} was accepted"

    @pytest.mark.parametrize("value", HOSTILE)
    def test_hostile_schemes_are_rejected_on_patch_too(self, client, db, admin_headers, value):
        """The PATCH boundary is the one that gets forgotten."""
        event = _make_event(db)
        resp = client.patch(
            f"{BASE}/{event.id}", json={"meeting_url": value}, headers=admin_headers
        )
        assert resp.status_code == 422, f"{value!r} was accepted"

    @pytest.mark.parametrize("value", SAFE)
    def test_http_and_https_are_accepted(self, client, admin_headers, value):
        resp = client.post(BASE, json=_payload(meeting_url=value), headers=admin_headers)
        assert resp.status_code == 201, resp.text
        assert resp.json()["meeting_url"] == value

    def test_null_and_empty_both_mean_no_link(self, client, admin_headers):
        assert (
            client.post(BASE, json=_payload(meeting_url=None), headers=admin_headers).json()[
                "meeting_url"
            ]
            is None
        )
        assert (
            client.post(BASE, json=_payload(meeting_url="   "), headers=admin_headers).json()[
                "meeting_url"
            ]
            is None
        )

    def test_an_absurdly_long_url_is_rejected(self, client, admin_headers):
        resp = client.post(
            BASE,
            json=_payload(meeting_url="https://example.test/" + "a" * 5000),
            headers=admin_headers,
        )
        assert resp.status_code == 422

    def test_a_hostile_value_already_in_the_database_never_renders(self, db):
        """Read-side twin: rows written before the validator existed (or by
        hand in psql) must not be able to smuggle a payload into a link."""
        from app.models.calendar_event import safe_meeting_url

        assert safe_meeting_url("javascript:alert(1)") is None
        assert safe_meeting_url("https://ok.example.test") == "https://ok.example.test"


# ── Auth ────────────────────────────────────────────────────────────────────


ROUTES = [
    ("get", BASE, None),
    ("post", BASE, _payload()),
    ("patch", f"{BASE}/{uuid.uuid4()}", {"title": "x"}),
    ("delete", f"{BASE}/{uuid.uuid4()}", None),
]


def _send(client, method, url, body, headers):
    return getattr(client, method)(
        url, **({"json": body} if body is not None else {}), headers=headers
    )


class TestAuth:
    @pytest.mark.parametrize("method,url,body", ROUTES)
    def test_unauthenticated_is_401(self, client, seeded_db, method, url, body):
        resp = _send(client, method, url, body, {})
        assert resp.status_code == 401, resp.text

    @pytest.mark.parametrize("method,url,body", ROUTES)
    def test_a_garbage_token_is_401(self, client, seeded_db, method, url, body):
        resp = _send(client, method, url, body, _bearer("not.a.jwt"))
        assert resp.status_code == 401

    def test_a_flagged_user_still_hits_the_forced_password_gate(
        self, client, db, seeded_db, auth_header
    ):
        """The calendar gate defers to get_current_user rather than copying it,
        so the platform's must_change_password 403 keeps working here."""
        headers = auth_header()
        seeded_db["admin_user"].must_change_password = True
        db.commit()
        resp = client.get(BASE, headers=headers)
        assert resp.status_code == 403
        assert resp.json()["detail"] == "password_change_required"


class TestDemoIsRefusedOnReadsToo:
    @pytest.mark.parametrize("method,url,body", ROUTES)
    def test_every_calendar_route_refuses_the_demo(
        self, client, seeded_db, demo_headers, method, url, body
    ):
        resp = _send(client, method, url, body, demo_headers)
        assert resp.status_code == 403, f"{method} {url}: {resp.status_code} {resp.text}"
        assert resp.json()["detail"] == DEMO_CALENDAR_FORBIDDEN_DETAIL

    def test_the_read_refusal_leaks_no_event_data(self, client, db, seeded_db, demo_headers):
        _make_event(db, title="Board meeting with the investor")
        resp = client.get(BASE, headers=demo_headers)
        assert resp.status_code == 403
        assert "investor" not in resp.text

    def test_the_demo_token_is_otherwise_still_valid(self, client, seeded_db, demo_headers):
        """Proves the 403 is the calendar gate refusing a WORKING session, not
        a broken token that would have 401'd anywhere."""
        assert client.get("/api/auth/me", headers=demo_headers).status_code == 200
        assert client.get("/api/admin/sponsors/", headers=demo_headers).status_code == 200


class TestPluginSecret:
    def test_the_secret_opens_the_door_without_a_user(self, client, seeded_db, monkeypatch):
        monkeypatch.setattr(settings, "CALENDAR_API_SECRET", SECRET)
        resp = client.post(BASE, json=_payload(), headers={CALENDAR_SECRET_HEADER: SECRET})
        assert resp.status_code == 201, resp.text
        # No user to attribute it to — the plugin is a service principal.
        assert resp.json()["created_by_id"] is None

    def test_the_bearer_form_works_too(self, client, seeded_db, monkeypatch):
        """Mirrors the existing MAIL_SYNC_SECRET channel between these boxes."""
        monkeypatch.setattr(settings, "CALENDAR_API_SECRET", SECRET)
        assert client.get(BASE, headers=_bearer(SECRET)).status_code == 200

    def test_a_wrong_secret_is_401_not_a_silent_pass(self, client, seeded_db, monkeypatch):
        monkeypatch.setattr(settings, "CALENDAR_API_SECRET", SECRET)
        resp = client.get(BASE, headers={CALENDAR_SECRET_HEADER: "wrong"})
        assert resp.status_code == 401

    def test_an_unconfigured_secret_never_matches_anything(self, client, seeded_db, monkeypatch):
        """Fail-CLOSED. An empty configured secret matching an empty header
        would turn "not set up yet" into "the calendar is public"."""
        for configured in (None, "", "   "):
            monkeypatch.setattr(settings, "CALENDAR_API_SECRET", configured)
            assert client.get(BASE, headers={CALENDAR_SECRET_HEADER: ""}).status_code == 401
            assert client.get(BASE, headers={CALENDAR_SECRET_HEADER: "anything"}).status_code == 401
            assert client.get(BASE).status_code == 401

    def test_the_demo_cannot_borrow_the_plugin_door(
        self, client, seeded_db, demo_headers, monkeypatch
    ):
        monkeypatch.setattr(settings, "CALENDAR_API_SECRET", SECRET)
        resp = client.get(BASE, headers=demo_headers)
        assert resp.status_code == 403
