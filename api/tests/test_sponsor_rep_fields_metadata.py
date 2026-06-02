"""Dialect-agnostic metadata assertions for new Sponsor rep-contact columns.

SQLite (used for the test suite) silently ignores ``String(N)`` length
contracts at runtime, so assertions about column WIDTH must read off the
SQLAlchemy table metadata instead. Mirrors the pattern flagged in
CLAUDE.md ("Tests use SQLite via Base.metadata.create_all — SQLite ignores
String(N) length").

Covers the 9 new Sponsor columns added in CSB v13 commit 1 + the
widening of Message.type from String(20) -> String(30) to fit the new
'sponsor_rep_request' enum value.
"""

from app.models import Sponsor
from app.models.message import Message


def test_sponsor_contact_name_length():
    assert Sponsor.__table__.c.contact_name.type.length >= 80


def test_sponsor_role_length():
    assert Sponsor.__table__.c.role.type.length >= 80


def test_sponsor_phone_length():
    assert Sponsor.__table__.c.phone.type.length >= 40


def test_sponsor_hours_length():
    assert Sponsor.__table__.c.hours.type.length >= 60


def test_sponsor_email_length():
    assert Sponsor.__table__.c.email.type.length >= 120


def test_sponsor_division_length():
    assert Sponsor.__table__.c.division.type.length >= 80


def test_sponsor_partno_length():
    assert Sponsor.__table__.c.partno.type.length >= 60


def test_sponsor_lettermark_length():
    assert Sponsor.__table__.c.lettermark.type.length >= 8


def test_sponsor_blurb_length():
    assert Sponsor.__table__.c.blurb.type.length >= 160


def test_message_type_widened_to_at_least_30():
    """Message.type must fit 'sponsor_rep_request' (19 chars) with headroom."""
    assert Message.__table__.c.type.type.length >= 30
