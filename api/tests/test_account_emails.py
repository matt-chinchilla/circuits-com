"""The project's first HTML mail. Everything else stays plain text.

Every assertion here is about a property a mail client will actually exercise:
the multipart shape, the link surviving in a text-only reader, no remote image
(blocked by default, and a fetch confirms the address is live to the sender),
and the recipient being the person rather than the NOTIFY_RECIPIENTS roster.
"""

from unittest.mock import AsyncMock, patch

import pytest

from app.services.email import (
    _build_activation_email,
    _build_verification_email,
    _build_welcome_email,
    send_activation_email,
    send_verification_email,
    send_welcome_email,
)

URL = "https://circuitcenter.ai/admin/verify?token=abc"


def _parts(msg):
    return {p.get_content_type() for p in msg.walk() if not p.is_multipart()}


def _html_of(msg):
    return [p.get_content() for p in msg.walk() if p.get_content_type() == "text/html"][0]


def test_verification_is_multipart_alternative_with_a_text_part():
    msg = _build_verification_email("a@test.example", "James", URL)
    assert msg.get_content_type() == "multipart/alternative"
    assert _parts(msg) == {"text/plain", "text/html"}


def test_the_link_appears_in_both_parts():
    msg = _build_verification_email("a@test.example", "James", URL)
    for part in msg.walk():
        if part.is_multipart():
            continue
        assert URL in part.get_content(), "a text-only reader must still get the link"


def test_no_remote_images():
    # Remote images are blocked by default in most clients, and fetching one
    # confirms to the sender that the address is live.
    for msg in (
        _build_verification_email("a@test.example", "James", URL),
        _build_welcome_email("a@test.example", "James"),
        _build_activation_email("a@test.example", "James", "https://circuitcenter.ai/account"),
    ):
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                assert "<img" not in part.get_content().lower()


def test_addressed_to_the_person_not_the_notify_list():
    msg = _build_welcome_email("a@test.example", "James")
    assert msg["To"] == "a@test.example"


def test_first_name_is_used():
    msg = _build_welcome_email("a@test.example", "James")
    html = [p.get_content() for p in msg.walk() if p.get_content_type() == "text/html"][0]
    assert "James" in html


# ── Beyond the brief: the two things that would silently ship broken ────────


def test_a_missing_first_name_still_greets():
    """first_name is nullable on the user row, so None must not render "Hi None"."""
    for msg in (
        _build_verification_email("a@test.example", None, URL),
        _build_welcome_email("a@test.example", None),
        _build_activation_email("a@test.example", None, URL),
    ):
        for part in msg.walk():
            if part.is_multipart():
                continue
            assert "None" not in part.get_content()


def test_a_typed_name_cannot_inject_markup():
    """first_name is whatever the registrant typed. It reaches an HTML body,
    so it is escaped there — the plain-text part keeps it verbatim."""
    msg = _build_welcome_email("a@test.example", "<b>James</b>")
    assert "<b>James</b>" not in _html_of(msg)
    assert "&lt;b&gt;James&lt;/b&gt;" in _html_of(msg)


def test_every_message_carries_a_subject_and_a_from():
    for msg in (
        _build_verification_email("a@test.example", "James", URL),
        _build_welcome_email("a@test.example", "James"),
        _build_activation_email("a@test.example", "James", URL),
    ):
        assert msg["Subject"]
        assert msg["From"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("sender", "args"),
    [
        (send_verification_email, ("a@test.example", "James", URL)),
        (send_welcome_email, ("a@test.example", "James")),
        (send_activation_email, ("a@test.example", "James", URL)),
    ],
)
async def test_the_wrappers_hand_a_built_message_to_smtp_send(sender, args):
    with patch("app.services.email._smtp_send", new_callable=AsyncMock) as send:
        await sender(*args)
    send.assert_awaited_once()
    (message,) = send.await_args.args
    assert message["To"] == "a@test.example"
    assert message.get_content_type() == "multipart/alternative"
