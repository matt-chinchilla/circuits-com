"""Guard: the api container's environment allowlist actually carries the
switches the app documents.

`Settings` (app/config.py) declares no `env_file`, so pydantic-settings reads
PROCESS ENV ONLY — and the api container has no volume mount, so it never sees
/opt/circuits-com/.env. The `environment:` block in the compose files is
therefore an explicit ALLOWLIST: a setting that is not enumerated there is
unreachable from the host, no matter what the .env file says.

`DEMO_LOGIN_ENABLED` shipped as exactly that kind of dead switch — documented in
config.py and README as the way to close public demo access "without a frontend
redeploy", absent from both compose files, and defaulted to True on top. An
operator disabling it would have changed nothing while believing the
unauthenticated session-minting endpoint was shut.

`API_WORKERS` is a different coupling: app/services/rate_limit.py keeps its
counters in process memory and divides its thresholds by the worker count, so
the `--workers` flag and the env var must be fed by the SAME interpolation.

Same spirit as tests/test_nginx_cache_headers.py — assert on the shipped config
text, because nothing else in CI ever reads these files.
"""

import re
from pathlib import Path

from app.config import Settings

ROOT = Path(__file__).resolve().parents[2]
DEV_COMPOSE = ROOT / "docker-compose.yml"
PROD_COMPOSE = ROOT / "docker-compose.prod.yml"


def _service_block(path: Path, service: str) -> str:
    """The YAML text of one top-level service (2-space indented key)."""
    text = path.read_text()
    match = re.search(rf"^  {re.escape(service)}:\n(.*?)(?=^  \S|\Z)", text, re.M | re.S)
    assert match, f"no `{service}:` service found in {path.name}"
    return match.group(1)


# ── The kill switch reaches the container ───────────────────────────────────


def test_the_shipped_demo_default_is_off():
    """Fail-CLOSED: an environment that never opts in gets no demo door.

    Asserted on the class field, not on the live `settings` singleton — the
    test suite opts the flag ON via conftest so it can exercise the endpoint.
    """
    assert Settings.model_fields["DEMO_LOGIN_ENABLED"].default is False


def test_both_compose_files_pass_the_demo_switch_through():
    for path in (DEV_COMPOSE, PROD_COMPOSE):
        api = _service_block(path, "api")
        assert re.search(r"^\s*DEMO_LOGIN_ENABLED:\s*\$\{DEMO_LOGIN_ENABLED", api, re.M), (
            f"{path.name}: the api service must pass DEMO_LOGIN_ENABLED through, or the "
            "documented kill switch is inert (no env_file, no volume mount)."
        )
        assert re.search(r"^\s*DEMO_LOGIN_EMAIL:\s*\$\{DEMO_LOGIN_EMAIL", api, re.M), (
            f"{path.name}: DEMO_LOGIN_EMAIL must be host-overridable alongside the switch."
        )


def test_prod_defaults_the_demo_endpoint_off():
    api = _service_block(PROD_COMPOSE, "api")
    assert "DEMO_LOGIN_ENABLED: ${DEMO_LOGIN_ENABLED:-false}" in api, (
        "prod must default the unauthenticated /api/auth/demo endpoint OFF; the "
        "operator opts in from /opt/circuits-com/.env."
    )


# ── Worker count ↔ rate-limit thresholds ────────────────────────────────────


def test_prod_worker_count_and_api_workers_share_one_source():
    api = _service_block(PROD_COMPOSE, "api")
    command = re.search(r"--workers\s+\$\{API_WORKERS:-(\d+)\}", api)
    env = re.search(r"^\s*API_WORKERS:\s*\$\{API_WORKERS:-(\d+)\}", api, re.M)
    assert command, (
        "prod must run `uvicorn ... --workers ${API_WORKERS:-N}` — a hardcoded worker "
        "count silently multiplies the login-lockout threshold (counters are per process)."
    )
    assert env, "prod must also pass API_WORKERS into the container so the app knows the count."
    assert command.group(1) == env.group(1), (
        "the --workers flag and the API_WORKERS env var must default to the SAME number, "
        "or app.services.rate_limit scales its thresholds for the wrong process count."
    )


def test_the_shipped_worker_default_keeps_the_limiter_exact():
    assert Settings.model_fields["API_WORKERS"].default == 1
    api = _service_block(PROD_COMPOSE, "api")
    assert "--workers ${API_WORKERS:-1}" in api, (
        "raising the prod worker count loosens the login lockout and makes "
        "clear()-on-success heal only one worker — read app/services/rate_limit.py first."
    )


def test_prod_does_not_publish_the_api_port():
    """nginx must be the only way in.

    The limiter trusts nginx's X-Real-IP / rightmost X-Forwarded-For hop. A
    published 8000 is a second, un-proxied front door where both headers are
    whatever the caller typed — which is exactly the bypass the trust rule fixes.
    """
    api = _service_block(PROD_COMPOSE, "api")
    assert re.search(r"^\s*ports:\s*!reset\s*\[\]", api, re.M), (
        "docker-compose.prod.yml must reset the base compose's `8000:8000` publish."
    )


# ── Calendar (2026-08-04) ───────────────────────────────────────────────────
# These exist because the calendar shipped with EXACTLY the DEMO_LOGIN_ENABLED
# bug this file was written to prevent: six settings declared in config.py,
# documented in the plugin README as things you put in /opt/circuits-com/.env,
# and enumerated in neither compose file. The failure was silent and total —
# CALENDAR_API_SECRET stayed None, so every call from the Roundcube plugin was
# refused and the calendar was unreachable from the webmail, with nothing in
# the error pointing at compose. It fails closed, so it was never a leak; it
# was simply inert. The guard the spec asked for was the one thing not written.

CALENDAR_SETTINGS = (
    "CALENDAR_API_SECRET",
    "CALENDAR_RECIPIENTS",
    "CALENDAR_TIMEZONE",
    "CALENDAR_REMINDER_LOOKBACK_MINUTES",
    "SMS_TOPIC_ARN",
    "SMS_REGION",
)


def test_both_compose_files_pass_every_calendar_setting_through():
    for path in (DEV_COMPOSE, PROD_COMPOSE):
        block = _service_block(path, "api")
        for name in CALENDAR_SETTINGS:
            assert f"{name}:" in block, (
                f"{name} is missing from the api environment block in {path.name}. "
                "pydantic-settings reads process env only and the api container has "
                "no volume mount, so a setting absent here can never be set from the "
                "host — however carefully it is written into .env."
            )


def test_every_calendar_setting_is_host_overridable():
    """No hard-coded values: each must interpolate from the host environment."""
    block = _service_block(PROD_COMPOSE, "api")
    for name in CALENDAR_SETTINGS:
        line = next(ln for ln in block.splitlines() if ln.strip().startswith(f"{name}:"))
        assert "${" in line, (
            f"{name} is pinned in docker-compose.prod.yml instead of reading from "
            "the host .env, so rotating it would need a redeploy."
        )


def test_the_reminder_job_is_actually_scheduled():
    """The job existed, was tested, and nothing ran it.

    `app.jobs.send_reminders` is a one-shot. Without a caller every reminder
    silently never fires and half the calendar is inert — which is precisely
    how it was first delivered. Asserting on the shipped compose text because
    nothing else in CI would notice the service disappearing.
    """
    text = DEV_COMPOSE.read_text()
    assert "calendar-reminders:" in text, (
        "no calendar-reminders service in docker-compose.yml — the reminder job "
        "has no caller and no reminder will ever be sent"
    )
    block = _service_block(DEV_COMPOSE, "calendar-reminders")
    assert "app.jobs.send_reminders" in block, "the service does not invoke the job"
    assert "|| true" in block, (
        "one failed pass would kill the container and silence every future reminder"
    )
    for name in ("CALENDAR_RECIPIENTS", "CALENDAR_TIMEZONE", "SMTP_HOST"):
        assert f"{name}:" in block, (
            f"{name} is missing from calendar-reminders — the job would run with a "
            "different configuration from the API that writes the events."
        )


def test_the_recipient_roster_default_is_not_empty_in_either_compose_file():
    """An empty default DESTROYS the code default; it does not inherit it.

    `CALENDAR_RECIPIENTS: ${CALENDAR_RECIPIENTS:-}` looks like "leave it to
    config.py". It is not: pydantic-settings receives the empty string, the
    CSV validator parses it to [], and the four-person roster in Settings is
    overwritten with nobody. Caught by running the job against the real stack,
    where it found a due event and had no one to send to. Exactly the trap the
    MAIL_SYNC_MAILBOXES comment records, one setting over.
    """
    for path in (DEV_COMPOSE, PROD_COMPOSE):
        block = _service_block(path, "api")
        line = next(
            ln for ln in block.splitlines() if ln.strip().startswith("CALENDAR_RECIPIENTS:")
        )
        default = line.split(":-", 1)[1].rstrip("}").strip()
        assert default, (
            f"CALENDAR_RECIPIENTS has an EMPTY default in {path.name}. That does not "
            "fall back to Settings.CALENDAR_RECIPIENTS — it overwrites it with an "
            "empty list and no reminder can ever be delivered."
        )
        assert set(default.split(",")) == set(Settings().CALENDAR_RECIPIENTS), (
            f"the {path.name} roster has drifted from Settings.CALENDAR_RECIPIENTS"
        )


# ── Stripe (2026-08-05) ─────────────────────────────────────────────────────

STRIPE_SETTINGS = ("STRIPE_SECRET_KEY", "STRIPE_PUBLIC_KEY")


def test_both_compose_files_pass_the_stripe_keys_through():
    """Same allowlist rule, and the same failure if it is forgotten.

    A key written into /opt/circuits-com/.env but absent from the api
    `environment:` block never reaches pydantic-settings, so billing would
    silently do nothing while the operator believed it was configured.
    """
    for path in (DEV_COMPOSE, PROD_COMPOSE):
        block = _service_block(path, "api")
        for name in STRIPE_SETTINGS:
            assert f"{name}:" in block, (
                f"{name} is missing from the api environment block in {path.name}"
            )


def test_the_stripe_keys_are_host_supplied_and_never_literal():
    """No key may be pinned in a compose file — that would commit a credential.

    The secret key moves real money once it is a live key. It has to come from
    the host environment, and the empty default has to stay empty: a fallback
    value here would be a secret in git.
    """
    for path in (DEV_COMPOSE, PROD_COMPOSE):
        block = _service_block(path, "api")
        for name in STRIPE_SETTINGS:
            line = next(ln for ln in block.splitlines() if ln.strip().startswith(f"{name}:"))
            assert "${" in line, f"{name} is pinned in {path.name} instead of read from the host"
            default = line.split(":-", 1)[1].rstrip("}").strip() if ":-" in line else ""
            assert default == "", (
                f"{name} has a literal default in {path.name} — a Stripe key must never "
                "be committed, and an empty value correctly means 'billing not configured'."
            )


def test_the_secret_key_is_not_exposed_to_the_frontend_build():
    """The publishable key is safe in a browser; the secret key is not.

    Vite inlines anything prefixed VITE_ into the client bundle at build time,
    so a secret key reaching the frontend service would be published to every
    visitor with no way to un-publish it short of rotating the key.
    """
    for path in (DEV_COMPOSE, PROD_COMPOSE):
        text = path.read_text()
        frontend = text.split("  frontend:", 1)
        if len(frontend) < 2:
            continue
        after = frontend[1].split("\n  ", 1)[0]
        assert "STRIPE_SECRET_KEY" not in after, (
            f"STRIPE_SECRET_KEY appears in the frontend service in {path.name}"
        )
        assert "VITE_STRIPE_SECRET" not in text, "a secret key must never carry a VITE_ prefix"
