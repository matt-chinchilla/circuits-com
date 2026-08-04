"""Optional SMS delivery for calendar reminders, via an SNS topic publish.

Design: ``docs/superpowers/specs/2026-08-04-shared-calendar-design.md``.

**Entirely optional, and inert when unconfigured.** With ``SMS_TOPIC_ARN``
unset this module sends nothing, raises nothing, and never imports boto3 — an
event's ``notify_sms`` toggle simply does nothing while email keeps working. A
shared calendar must not acquire a hard dependency on AWS credentials, and the
test suite, every dev box and the site as it runs today all have no topic.

boto3 is NOT in ``pyproject.toml``'s runtime dependencies, so the import is
lazy and its absence is one logged warning rather than an ImportError at module
load. That is deliberate: adding an AWS SDK to the api image to support a
feature that ships OFF is the wrong trade. Install it (and set the ARN) on the
box that actually wants SMS.

The topic's SUBSCRIPTIONS are the recipient list — there is no phone number in
this codebase. Cost note: SNS SMS is roughly $0.0065/message in the US; five
people and a few meetings a week is cents per month. The reason it is off by
default is setup friction and the risk of a loop spending real money.

Never raises. Every failure path — no topic, no SDK, no credentials, a throttle,
a malformed ARN — returns ``False`` and logs. The caller (the reminder job) is a
cron with no user waiting on it, and a broken SMS channel must never take the
email reminder down with it.
"""

from __future__ import annotations

import logging
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

# Cached SNS client. Building one costs a session + endpoint resolution, and the
# job publishes several messages per run. `reset_client()` clears it — tests and
# any future "reload config" path need the seam, because the client binds the
# region at construction time.
_client: Any | None = None


def is_configured() -> bool:
    """True when a topic ARN is set. THE single "is SMS on?" question.

    The reminder job consults this BEFORE claiming a ledger row, so an
    unconfigured channel leaves no ``sms`` row behind that would suppress the
    send forever once someone does configure a topic.
    """
    return bool((settings.SMS_TOPIC_ARN or "").strip())


def topic_region() -> str | None:
    """The region to talk to, parsed from the ARN unless SMS_REGION overrides.

    ``arn:aws:sns:us-east-1:123456789012:circuit-center-reminders`` → the 4th
    colon-separated field. Parsing beats a second env var that can silently
    disagree with the ARN; the override exists only for VPC-endpoint setups.
    """
    override = (settings.SMS_REGION or "").strip()
    if override:
        return override
    parts = (settings.SMS_TOPIC_ARN or "").split(":")
    # arn : partition : service : region : account : name
    if len(parts) >= 4 and parts[0] == "arn" and parts[3]:
        return parts[3]
    return None


def reset_client() -> None:
    """Drop the cached SNS client. For tests, and for any config reload."""
    global _client
    _client = None


def _sns_client() -> Any | None:
    """The boto3 SNS client, or None when the SDK/credentials aren't there.

    A function rather than a module constant so the import stays lazy and tests
    can substitute a fake without an AWS account.
    """
    global _client
    if _client is not None:
        return _client
    try:
        # Lazy on purpose — see the module docstring.
        import boto3
    except ImportError:
        logger.warning(
            "[sms] SMS_TOPIC_ARN is set but boto3 is not installed — no SMS will be sent. "
            "Add boto3 to the api image or unset SMS_TOPIC_ARN."
        )
        return None
    try:
        region = topic_region()
        _client = boto3.client("sns", region_name=region) if region else boto3.client("sns")
    except Exception:
        # Credential-resolution and endpoint errors both surface here.
        logger.exception("[sms] could not build an SNS client")
        return None
    return _client


def send_sms(message: str, *, subject: str | None = None) -> bool:
    """Publish one message to the configured topic. True iff it was accepted.

    Returns False (never raises) when SMS is unconfigured, the SDK is missing,
    or the publish fails.
    """
    if not is_configured():
        # Not a warning: "no topic" is the shipped default, not a fault.
        logger.debug("[sms] no SMS_TOPIC_ARN configured — skipping")
        return False

    client = _sns_client()
    if client is None:
        return False

    kwargs: dict[str, Any] = {
        "TopicArn": (settings.SMS_TOPIC_ARN or "").strip(),
        "Message": message,
    }
    if subject:
        # SNS caps Subject at 100 chars and rejects newlines outright; it is
        # also what an email subscriber to the same topic sees.
        kwargs["Subject"] = subject.replace("\n", " ").replace("\r", " ")[:100]

    try:
        client.publish(**kwargs)
    except Exception:
        logger.exception("[sms] SNS publish failed")
        return False
    return True
