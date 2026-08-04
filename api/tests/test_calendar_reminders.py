"""The reminder cron — windows, idempotency, per-event toggles, inert SMS.

This is the part of the calendar most likely to be wrong, and every failure
mode here is SILENT: nothing errors, the reminder simply never arrives (or
arrives four times). So each property gets an explicit test rather than being
implied by a happy path.

The job's clock is injected (``run(db, now=...)``) instead of monkeypatched, so
these tests place events relative to a fixed instant and assert on which ones
the pass picks up.

Both delivery services are stubbed at the module boundary the job imports them
through — ``send_event_reminder`` and ``sms.send_sms`` — which is the same
surface production calls, so nothing about the claim/ledger logic is bypassed.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.config import settings
from app.jobs import send_reminders as job
from app.models import CalendarEvent, CalendarReminderSend

NOW = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)
LOOKBACK = timedelta(minutes=30)


@pytest.fixture
def sent(monkeypatch):
    """Capture every delivery attempt instead of sending one.

    ``sent["email"]`` / ``sent["sms"]`` collect the payloads; ``sent["fail"]``
    is a set of channels that should report failure.
    """
    box: dict = {"email": [], "sms": [], "fail": set()}

    async def fake_email(recipients, **event):
        box["email"].append({"to": recipients, **event})

    def fake_sms(message, *, subject=None):
        box["sms"].append({"message": message, "subject": subject})
        return "sms" not in box["fail"]

    monkeypatch.setattr(job.email_service, "send_event_reminder", fake_email)
    monkeypatch.setattr(job.sms_service, "send_sms", fake_sms)
    # Default: SMS unconfigured, exactly as the product ships.
    monkeypatch.setattr(settings, "SMS_TOPIC_ARN", None)
    # A configured relay. The transport is stubbed above, so this only gets the
    # job past its "SMTP_HOST is unset" guard — without it these tests would
    # exercise demo mode and assert on deliveries that never happen. RFC 6761
    # `.test` and no password, so the credential-lookalike guard stays happy.
    monkeypatch.setattr(settings, "SMTP_HOST", "smtp.test")
    return box


def make_event(db, *, starts_in: timedelta, **overrides):
    fields = {
        "id": uuid.uuid4(),
        "title": "Weekly sync",
        "starts_at": NOW + starts_in,
        "ends_at": NOW + starts_in + timedelta(hours=1),
    }
    fields.update(overrides)
    event = CalendarEvent(**fields)
    db.add(event)
    db.commit()
    return event


def ledger(db, event_id=None):
    q = db.query(CalendarReminderSend)
    if event_id is not None:
        q = q.filter(CalendarReminderSend.event_id == event_id)
    return q.all()


def run(db):
    return job.run(db, now=NOW, lookback=LOOKBACK)


# ── Windows ─────────────────────────────────────────────────────────────────


class TestWindows:
    def test_an_event_exactly_one_day_out_gets_the_day_before_reminder(self, db, sent):
        make_event(db, starts_in=timedelta(days=1))
        stats = run(db)
        assert stats["sent"] == 1
        assert [row.kind for row in ledger(db)] == ["day_before"]

    def test_an_event_exactly_one_hour_out_gets_the_hour_before_reminder(self, db, sent):
        make_event(db, starts_in=timedelta(hours=1))
        run(db)
        assert [row.kind for row in ledger(db)] == ["hour_before"]

    def test_a_late_tick_still_delivers(self, db, sent):
        """THE reason the window is a lookback RANGE and not an instant. The
        send moment passed 20 minutes ago (the cron was late, or a tick was
        missed entirely); a range still catches it, an equality check would
        have delivered nothing at all and said nothing about it."""
        make_event(db, starts_in=timedelta(days=1) - timedelta(minutes=20))
        run(db)
        assert [row.kind for row in ledger(db)] == ["day_before"]

    def test_a_tick_older_than_the_lookback_is_not_resurrected(self, db, sent):
        """The range has to end somewhere, or a box that was off for a week
        would blast every reminder it missed the moment it came back."""
        make_event(db, starts_in=timedelta(days=1) - timedelta(minutes=45))
        assert run(db)["sent"] == 0
        assert ledger(db) == []

    def test_an_event_further_out_than_the_lead_time_is_not_due_yet(self, db, sent):
        make_event(db, starts_in=timedelta(days=3))
        assert run(db)["sent"] == 0
        assert ledger(db) == []

    def test_an_event_that_already_started_gets_nothing(self, db, sent):
        make_event(db, starts_in=-timedelta(minutes=10))
        assert run(db)["sent"] == 0

    def test_the_hour_before_window_never_reaches_past_the_start(self, db, sent):
        """A 90-minute lookback would put the hour-before window's floor at
        `now - 30min` — i.e. firing "your meeting is in an hour" about a
        meeting that began twenty minutes ago. The clamp is what stops it."""
        assert job._lookback("hour_before", timedelta(minutes=90)) == timedelta(hours=1)
        assert job._lookback("day_before", timedelta(minutes=90)) == timedelta(minutes=90)
        make_event(db, starts_in=-timedelta(minutes=20))
        assert job.run(db, now=NOW, lookback=timedelta(minutes=90))["sent"] == 0

    def test_the_two_kinds_fire_independently_across_two_passes(self, db, sent):
        """The realistic life of one meeting: a day-before pass, then an
        hour-before pass 23 hours later. The second must not be suppressed by
        the first's ledger row, and vice versa."""
        event = make_event(db, starts_in=timedelta(days=1))
        job.run(db, now=NOW, lookback=LOOKBACK)
        job.run(db, now=NOW + timedelta(hours=23), lookback=LOOKBACK)
        assert sorted(row.kind for row in ledger(db, event.id)) == ["day_before", "hour_before"]
        assert len(sent["email"]) == 2

    def test_the_subject_says_which_lead_time_it_is(self, db, sent):
        make_event(db, starts_in=timedelta(hours=1))
        run(db)
        assert sent["email"][0]["lead_label"] == "in 1 hour"


# ── Idempotency ─────────────────────────────────────────────────────────────


class TestIdempotency:
    def test_a_second_run_in_the_same_window_sends_nothing(self, db, sent):
        make_event(db, starts_in=timedelta(days=1))
        first = run(db)
        second = run(db)
        assert first["sent"] == 1
        assert second["sent"] == 0
        assert second["skipped_duplicate"] == 1
        assert len(sent["email"]) == 1
        assert len(ledger(db)) == 1

    def test_many_runs_still_send_once(self, db, sent):
        make_event(db, starts_in=timedelta(days=1))
        for _ in range(5):
            run(db)
        assert len(sent["email"]) == 1

    def test_the_database_is_the_arbiter_not_the_job(self, db, sent):
        """A ledger row planted by SOMETHING ELSE — another process, a previous
        container, a manual insert — must suppress this job's send. That is the
        difference between a unique constraint and in-process bookkeeping, and
        it is the whole reason the table exists."""
        event = make_event(db, starts_in=timedelta(days=1))
        db.add(
            CalendarReminderSend(
                id=uuid.uuid4(), event_id=event.id, kind="day_before", channel="email"
            )
        )
        db.commit()
        assert run(db)["sent"] == 0
        assert sent["email"] == []

    def test_the_claim_is_committed_before_the_send(self, db, monkeypatch, sent):
        """A concurrent pass has to see the claim, so it cannot wait until the
        send returns. Asserted by looking at the ledger from INSIDE the send."""
        seen: list[int] = []

        async def peeking_email(recipients, **event):
            seen.append(len(ledger(db)))

        monkeypatch.setattr(job.email_service, "send_event_reminder", peeking_email)
        make_event(db, starts_in=timedelta(days=1))
        run(db)
        assert seen == [1]

    def test_a_failed_send_keeps_its_claim(self, db, sent, monkeypatch):
        """At-most-once, deliberately: releasing the claim to allow a retry
        would reopen the double-send this table exists to prevent."""
        monkeypatch.setattr(settings, "SMS_TOPIC_ARN", "arn:aws:sns:us-east-1:1:topic")
        monkeypatch.setattr(job.sms_service, "is_configured", lambda: True)
        sent["fail"].add("sms")
        make_event(db, starts_in=timedelta(days=1), notify_email=False, notify_sms=True)
        stats = run(db)
        assert stats["failed"] == 1
        assert [(r.kind, r.channel) for r in ledger(db)] == [("day_before", "sms")]
        assert run(db)["skipped_duplicate"] == 1

    def test_a_raising_send_does_not_abort_the_whole_pass(self, db, sent, monkeypatch):
        """One broken event must not cost the other four their reminders."""
        boom = make_event(db, starts_in=timedelta(days=1), title="boom")
        make_event(db, starts_in=timedelta(days=1), title="fine")

        async def selective(recipients, **event):
            if event["title"] == "boom":
                raise RuntimeError("smtp exploded")
            sent["email"].append(event)

        monkeypatch.setattr(job.email_service, "send_event_reminder", selective)
        stats = run(db)
        assert stats["failed"] == 1
        assert stats["sent"] == 1
        assert [e["title"] for e in sent["email"]] == ["fine"]
        assert boom.id in {r.event_id for r in ledger(db)}


class TestRescheduleRearmsTheReminder:
    def test_clearing_the_ledger_lets_the_new_time_fire(self, db, sent):
        """The route clears the ledger on reschedule; this proves the job then
        does the right thing with the cleared state, end to end."""
        from app.models.calendar_event import clear_reminder_ledger

        event = make_event(db, starts_in=timedelta(days=1))
        run(db)
        assert len(sent["email"]) == 1

        # Move it two days out and clear, as PATCH does.
        event.starts_at = NOW + timedelta(days=3)
        event.ends_at = NOW + timedelta(days=3, hours=1)
        clear_reminder_ledger(db, event.id)
        db.commit()

        # Not due at the old moment any more...
        assert run(db)["sent"] == 0
        # ...but due a day before the NEW time.
        assert job.run(db, now=NOW + timedelta(days=2), lookback=LOOKBACK)["sent"] == 1
        assert len(sent["email"]) == 2

    def test_without_clearing_the_ledger_the_new_time_is_silently_swallowed(self, db, sent):
        """The failure this guards against, stated as a test: nothing errors,
        the mail simply never arrives."""
        event = make_event(db, starts_in=timedelta(days=1))
        run(db)
        event.starts_at = NOW + timedelta(days=3)
        event.ends_at = NOW + timedelta(days=3, hours=1)
        db.commit()
        assert job.run(db, now=NOW + timedelta(days=2), lookback=LOOKBACK)["sent"] == 0


# ── Per-event toggles ───────────────────────────────────────────────────────


class TestToggles:
    def test_remind_day_before_false_suppresses_only_that_kind(self, db, sent):
        make_event(db, starts_in=timedelta(days=1), remind_day_before=False)
        assert run(db)["sent"] == 0
        assert ledger(db) == []

    def test_remind_hour_before_false_suppresses_only_that_kind(self, db, sent):
        event = make_event(db, starts_in=timedelta(days=1), remind_hour_before=False)
        run(db)
        assert [r.kind for r in ledger(db, event.id)] == ["day_before"]
        assert job.run(db, now=NOW + timedelta(hours=23), lookback=LOOKBACK)["sent"] == 0

    def test_both_remind_flags_off_means_no_reminder_ever(self, db, sent):
        make_event(
            db, starts_in=timedelta(days=1), remind_day_before=False, remind_hour_before=False
        )
        assert run(db)["sent"] == 0
        assert job.run(db, now=NOW + timedelta(hours=23), lookback=LOOKBACK)["sent"] == 0

    def test_notify_email_false_suppresses_the_email_channel(self, db, sent):
        make_event(db, starts_in=timedelta(days=1), notify_email=False)
        assert run(db)["sent"] == 0
        assert sent["email"] == []
        assert ledger(db) == []

    def test_notify_sms_true_adds_a_second_channel_when_configured(self, db, sent, monkeypatch):
        monkeypatch.setattr(job.sms_service, "is_configured", lambda: True)
        event = make_event(db, starts_in=timedelta(days=1), notify_sms=True)
        stats = run(db)
        assert stats["sent"] == 2
        assert sorted(r.channel for r in ledger(db, event.id)) == ["email", "sms"]
        assert len(sent["sms"]) == 1

    def test_notify_sms_false_is_the_default_and_sends_no_sms(self, db, sent, monkeypatch):
        monkeypatch.setattr(job.sms_service, "is_configured", lambda: True)
        make_event(db, starts_in=timedelta(days=1))
        run(db)
        assert sent["sms"] == []
        assert [r.channel for r in ledger(db)] == ["email"]

    def test_the_two_channels_are_independent_slots(self, db, sent, monkeypatch):
        """Email succeeding must not consume the SMS slot, or vice versa."""
        monkeypatch.setattr(job.sms_service, "is_configured", lambda: True)
        event = make_event(db, starts_in=timedelta(days=1), notify_sms=True)
        db.add(
            CalendarReminderSend(
                id=uuid.uuid4(), event_id=event.id, kind="day_before", channel="email"
            )
        )
        db.commit()
        stats = run(db)
        assert stats["sent"] == 1
        assert stats["skipped_duplicate"] == 1
        assert len(sent["sms"]) == 1
        assert sent["email"] == []


# ── SMS is inert when unconfigured ──────────────────────────────────────────


class TestSmsInertWhenUnconfigured:
    def test_no_exception_no_send_and_email_still_works(self, db, sent, monkeypatch):
        """The headline requirement: an event with notify_sms=True on a box
        with no SMS_TOPIC_ARN must deliver its email and do nothing else."""
        monkeypatch.setattr(settings, "SMS_TOPIC_ARN", None)
        make_event(db, starts_in=timedelta(days=1), notify_sms=True)
        stats = run(db)
        assert stats["sent"] == 1
        assert stats["failed"] == 0
        assert len(sent["email"]) == 1
        assert sent["sms"] == []

    def test_it_leaves_no_ledger_row_behind(self, db, sent, monkeypatch):
        """Claiming the sms slot for a send that never happened would suppress
        it forever once somebody DID configure a topic."""
        monkeypatch.setattr(settings, "SMS_TOPIC_ARN", None)
        event = make_event(db, starts_in=timedelta(days=1), notify_sms=True)
        run(db)
        assert [r.channel for r in ledger(db, event.id)] == ["email"]

    def test_the_service_itself_is_inert_rather_than_raising(self, monkeypatch):
        from app.services import sms

        sms.reset_client()
        monkeypatch.setattr(settings, "SMS_TOPIC_ARN", None)
        assert sms.is_configured() is False
        assert sms.send_sms("anything") is False

        monkeypatch.setattr(settings, "SMS_TOPIC_ARN", "   ")
        assert sms.is_configured() is False
        assert sms.send_sms("anything") is False

    def test_a_missing_sdk_is_a_warning_not_an_importerror(self, monkeypatch):
        """boto3 is NOT a runtime dependency of the api image — an ARN set on a
        box without it must degrade, not crash the cron."""
        import builtins

        from app.services import sms

        sms.reset_client()
        monkeypatch.setattr(settings, "SMS_TOPIC_ARN", "arn:aws:sns:us-east-1:1:topic")
        real_import = builtins.__import__

        def no_boto3(name, *args, **kwargs):
            if name == "boto3":
                raise ImportError("no module named boto3")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", no_boto3)
        assert sms.send_sms("hello") is False
        sms.reset_client()

    def test_a_publish_failure_is_false_not_an_exception(self, monkeypatch):
        from app.services import sms

        class Boom:
            def publish(self, **kwargs):
                raise RuntimeError("throttled")

        sms.reset_client()
        monkeypatch.setattr(settings, "SMS_TOPIC_ARN", "arn:aws:sns:us-east-1:1:topic")
        monkeypatch.setattr(sms, "_sns_client", lambda: Boom())
        assert sms.send_sms("hello") is False
        sms.reset_client()

    def test_the_region_comes_from_the_arn(self, monkeypatch):
        from app.services import sms

        monkeypatch.setattr(settings, "SMS_REGION", None)
        monkeypatch.setattr(settings, "SMS_TOPIC_ARN", "arn:aws:sns:eu-west-2:1234:reminders")
        assert sms.topic_region() == "eu-west-2"
        monkeypatch.setattr(settings, "SMS_REGION", "us-east-1")
        assert sms.topic_region() == "us-east-1"
        monkeypatch.setattr(settings, "SMS_REGION", None)
        monkeypatch.setattr(settings, "SMS_TOPIC_ARN", "not-an-arn")
        assert sms.topic_region() is None


# ── Recipients + composition ────────────────────────────────────────────────


class TestRecipientsAndComposition:
    def test_it_goes_to_the_fixed_roster_not_per_event_attendees(self, db, sent):
        """Deliberately deferred design: an attendees field is the obvious next
        step and is not needed to ship."""
        make_event(db, starts_in=timedelta(days=1))
        run(db)
        assert sent["email"][0]["to"] == list(settings.CALENDAR_RECIPIENTS)

    def test_the_roster_is_the_four_humans(self):
        """MAIL_SYNC_MAILBOXES additionally carries no-reply@, which is a relay
        identity with nobody reading it."""
        assert "no-reply@circuitcenter.ai" not in settings.CALENDAR_RECIPIENTS
        assert len(settings.CALENDAR_RECIPIENTS) == 4

    def test_an_empty_roster_is_a_failure_not_a_silent_success(self, db, sent, monkeypatch):
        monkeypatch.setattr(settings, "CALENDAR_RECIPIENTS", [])
        make_event(db, starts_in=timedelta(days=1))
        assert run(db)["failed"] == 1

    def test_the_email_body_carries_the_event(self, db):
        from app.services.email import _build_event_reminder

        msg = _build_event_reminder(
            ["a@test.example"],
            title="Board review",
            starts_at=datetime(2026, 8, 11, 18, 0, tzinfo=UTC),
            ends_at=datetime(2026, 8, 11, 19, 0, tzinfo=UTC),
            location="Room 2",
            meeting_url="https://meet.example.test/room",
            notes="bring the deck",
            lead_label="tomorrow",
        )
        body = msg.get_content()
        assert "Board review" in msg["Subject"]
        assert "tomorrow" in msg["Subject"]
        assert "Room 2" in body
        assert "https://meet.example.test/room" in body
        assert "bring the deck" in body

    def test_a_hostile_stored_url_never_reaches_the_body(self, db):
        """Belt and braces on top of the write boundary: a row written before
        the validator existed must not put a javascript: string in front of
        five people (mail clients autolink)."""
        from app.services.email import _build_event_reminder

        msg = _build_event_reminder(
            ["a@test.example"],
            title="Sync",
            starts_at=datetime(2026, 8, 11, 18, 0, tzinfo=UTC),
            ends_at=datetime(2026, 8, 11, 19, 0, tzinfo=UTC),
            meeting_url="javascript:alert(1)",
        )
        assert "javascript:" not in msg.get_content()

    def test_an_unknown_timezone_falls_back_to_utc_rather_than_guessing(self, monkeypatch):
        from app.services.email import _build_event_reminder

        monkeypatch.setattr(settings, "CALENDAR_TIMEZONE", "Mars/Olympus_Mons")
        msg = _build_event_reminder(
            ["a@test.example"],
            title="Sync",
            starts_at=datetime(2026, 8, 11, 18, 0, tzinfo=UTC),
            ends_at=datetime(2026, 8, 11, 19, 0, tzinfo=UTC),
        )
        assert "UTC" in msg.get_content()

    def test_an_all_day_event_says_so_instead_of_printing_a_time(self):
        from app.services.email import _build_event_reminder

        msg = _build_event_reminder(
            ["a@test.example"],
            title="Company offsite",
            starts_at=datetime(2026, 8, 11, 0, 0, tzinfo=UTC),
            ends_at=datetime(2026, 8, 11, 23, 59, tzinfo=UTC),
            all_day=True,
        )
        assert "(all day)" in msg.get_content()


class TestPassIsInertOnAnEmptyCalendar:
    def test_no_events_means_no_work_and_no_crash(self, db, sent):
        assert job.run(db, now=NOW, lookback=LOOKBACK) == {
            "due": 0,
            "sent": 0,
            "skipped_duplicate": 0,
            "failed": 0,
        }


# ── Demo-mode email must not be recorded as delivered ───────────────────────


class TestUnsentEmailIsNotClaimed:
    """The worst outcome this job has is silent non-delivery.

    `email._smtp_send` swallows every exception and returns None, and with
    SMTP_HOST unset it logs and returns without sending at all. `_send_email`
    used to return True unconditionally, so a dead relay produced a committed
    ledger row, a "sent" counter and a cheerful log line while the reminder was
    gone — and the UNIQUE constraint then guaranteed it could never be retried.

    These pin the honest behaviour. Note the whole suite passed while the bug
    was live, because every test stubbed the transport and none of them made
    the relay fail.
    """

    def test_demo_mode_sends_nothing_and_claims_nothing(self, db, sent, monkeypatch):
        monkeypatch.setattr(settings, "SMTP_HOST", None)
        event = make_event(db, starts_in=timedelta(days=1))
        stats = run(db)

        assert sent["email"] == [], "demo mode must not report a delivery"
        assert stats["sent"] == 0
        assert ledger(db, event.id) == [], (
            "a claim was committed for a reminder that was never sent — the "
            "UNIQUE constraint would make it unretryable forever"
        )

    def test_a_later_run_with_a_relay_configured_still_delivers(self, db, sent, monkeypatch):
        """The corollary: because nothing was claimed, fixing SMTP recovers it."""
        monkeypatch.setattr(settings, "SMTP_HOST", None)
        event = make_event(db, starts_in=timedelta(days=1))
        run(db)
        assert sent["email"] == []

        monkeypatch.setattr(settings, "SMTP_HOST", "smtp.test")
        run(db)
        assert len(sent["email"]) == 1
        assert len(ledger(db, event.id)) == 1

    def test_a_raising_relay_is_reported_as_failed_but_keeps_its_claim(self, db, sent, monkeypatch):
        """The other half of the distinction, and the deliberate one.

        Demo mode is "no attempt was made" and must not claim. A relay that was
        contacted and refused is "an attempt was made and we do not know if it
        landed" — that keeps its claim, because at-most-once is the documented
        choice and a duplicate reminder from a half-succeeded SMTP conversation
        is the failure we picked against. What must NOT happen is the old
        behaviour, where this counted as a success.
        """

        async def boom(recipients, **event):
            raise RuntimeError("relay refused")

        monkeypatch.setattr(job.email_service, "send_event_reminder", boom)
        event = make_event(db, starts_in=timedelta(days=1))
        stats = run(db)
        assert stats["sent"] == 0, "a refused relay must never count as sent"
        assert len(ledger(db, event.id)) == 1, "at-most-once: the claim is kept"
