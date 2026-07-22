"""Tests for the account-recovery email composers.

Mirrors the _build_notification pattern in services/email.py: the pure builders
return an EmailMessage we can assert on without opening an SMTP connection.
"""

from app.services.email import _build_password_reset, _build_username_reminder


class TestPasswordResetEmail:
    def test_addressed_to_the_user(self):
        msg = _build_password_reset(
            "user@example.com", "matthew", "https://circuitcenter.ai/admin/reset-password?token=ABC"
        )
        assert msg["To"] == "user@example.com"
        assert msg["From"]  # has a From

    def test_body_contains_link_and_username(self):
        url = "https://circuitcenter.ai/admin/reset-password?token=ABC123"
        msg = _build_password_reset("user@example.com", "matthew", url)
        body = msg.get_content()
        assert url in body
        assert "matthew" in body

    def test_subject_mentions_password(self):
        msg = _build_password_reset("user@example.com", "matthew", "https://x/y?token=T")
        assert "password" in msg["Subject"].lower()


class TestUsernameReminderEmail:
    def test_addressed_to_the_user(self):
        msg = _build_username_reminder("user@example.com", ["matthew"])
        assert msg["To"] == "user@example.com"

    def test_body_lists_every_username(self):
        msg = _build_username_reminder("user@example.com", ["matthew", "mike"])
        body = msg.get_content()
        assert "matthew" in body
        assert "mike" in body

    def test_subject_mentions_username(self):
        msg = _build_username_reminder("user@example.com", ["matthew"])
        assert "username" in msg["Subject"].lower()
