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


# ── The fictional demo catalog stays out of prod (2026-08-18) ───────────────
# The seed re-runs on EVERY api container start, so a demo company the owner
# deleted in /admin came straight back on the next deploy. The switch is only
# real if it reaches the container — same allowlist trap as everything above.


def test_the_shipped_demo_catalog_default_seeds_it():
    """Code default True: a laptop that configures nothing still gets the
    showcase sponsorships. Prod opts OUT via compose, not the other way round."""
    assert Settings.model_fields["SEED_DEMO_CATALOG"].default is True
    # Leads CRM flags (owner decision L6: default TRUE everywhere — the CSVs
    # are the source of truth; compose defaults must MIRROR the code default).
    assert Settings.model_fields["SEED_MANUFACTURERS"].default is True
    assert Settings.model_fields["SEED_LEADS"].default is True


def test_both_compose_files_pass_the_seed_switch_through():
    for path in (DEV_COMPOSE, PROD_COMPOSE):
        api = _service_block(path, "api")
        assert re.search(r"^\s*SEED_DEMO_CATALOG:\s*\$\{SEED_DEMO_CATALOG", api, re.M), (
            f"{path.name}: the api service must pass SEED_DEMO_CATALOG through, or the "
            "seed keeps re-creating the fictional demo companies (no env_file, no "
            "volume mount)."
        )
        for flag in ("SEED_MANUFACTURERS", "SEED_LEADS"):
            assert re.search(rf"^\s*{flag}:\s*\${{{flag}:-true}}", api, re.M), (
                f"{path.name}: {flag} must pass through with a literal true default "
                "mirroring the code default (the compose-allowlist gotcha, 5th occurrence)"
            )



def test_dev_default_mirrors_the_code_default():
    api = _service_block(DEV_COMPOSE, "api")
    assert "SEED_DEMO_CATALOG: ${SEED_DEMO_CATALOG:-true}" in api, (
        "the dev passthrough must MIRROR Settings.SEED_DEMO_CATALOG (True) — a compose "
        "default that contradicts the code default silently overrides it."
    )


def test_prod_defaults_the_demo_catalog_off():
    api = _service_block(PROD_COMPOSE, "api")
    assert "SEED_DEMO_CATALOG: ${SEED_DEMO_CATALOG:-false}" in api, (
        "prod must seed the REAL catalog only; with the fictional companies on, "
        "deleting one in /admin is undone by the next container start."
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

STRIPE_SETTINGS = ("STRIPE_SECRET_KEY", "STRIPE_PUBLIC_KEY", "STRIPE_WEBHOOK_SECRET")


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


# ── Automated cost sync (2026-08-11) ────────────────────────────────────────
# app/jobs/sync_costs.py has exactly one caller — the `cost-sync` compose
# service. Same failure mode as the reminder job before its service existed:
# complete, tested, and never run, so the Cost Breakdown would keep showing the
# seeded list-price estimate forever with nothing to indicate why.


def test_the_cost_sync_job_is_actually_scheduled():
    text = DEV_COMPOSE.read_text()
    assert "cost-sync:" in text, (
        "no cost-sync service in docker-compose.yml — app.jobs.sync_costs has no "
        "caller and no real cost ever reaches the expenses table"
    )
    block = _service_block(DEV_COMPOSE, "cost-sync")
    assert "app.jobs.sync_costs" in block, "the service does not invoke the job"
    assert "restart:" in block, (
        "without a restart policy one crash silences cost sync until the next deploy"
    )


COST_SYNC_SETTINGS = ("DATABASE_URL", "STRIPE_SECRET_KEY", "ANTHROPIC_ADMIN_KEY")


def test_the_cost_sync_service_carries_its_own_configuration():
    """It is a SEPARATE container from api — it inherits none of api's env."""
    block = _service_block(DEV_COMPOSE, "cost-sync")
    for name in COST_SYNC_SETTINGS:
        assert f"{name}:" in block, (
            f"{name} is missing from cost-sync in docker-compose.yml. The job runs in "
            "its own container, so the api service's allowlist does nothing for it."
        )
    assert "AWS_DEFAULT_REGION: us-east-1" in block, (
        "Cost Explorer has ONE endpoint region for the whole account; anything else "
        "resolves to an endpoint that does not exist."
    )


def test_the_anthropic_admin_key_reaches_only_the_cost_sync_service():
    """An ORGANIZATION admin credential goes where it is read and nowhere
    else: cost-sync consumes it; the internet-facing api container never
    does, so carrying it there was pure blast radius (2026-08-11 review)."""
    for path in (DEV_COMPOSE, PROD_COMPOSE):
        sync_block = _service_block(path, "cost-sync")
        assert re.search(r"^\s*ANTHROPIC_ADMIN_KEY:\s*\$\{ANTHROPIC_ADMIN_KEY", sync_block, re.M), (
            f"{path.name}: ANTHROPIC_ADMIN_KEY must be host-overridable on cost-sync, or "
            "the key can never reach Settings (no env_file, no volume mount)."
        )
        api_block = _service_block(path, "api")
        # Matched as an ENV LINE (key + colon at line start), not a substring:
        # the block legitimately mentions the key by name in a comment that
        # explains exactly why it is absent.
        assert not re.search(r"^\s*ANTHROPIC_ADMIN_KEY:", api_block, re.M), (
            f"{path.name}: the api service must NOT carry ANTHROPIC_ADMIN_KEY — "
            "nothing in the api reads it, and it is an org-level admin secret."
        )


def test_the_anthropic_key_is_never_pinned_in_a_compose_file():
    """An organization ADMIN key — a larger credential than the Stripe secret."""
    for path in (DEV_COMPOSE, PROD_COMPOSE):
        for service in ("api", "cost-sync"):
            block = _service_block(path, service)
            lines = [
                ln for ln in block.splitlines() if ln.strip().startswith("ANTHROPIC_ADMIN_KEY:")
            ]
            for line in lines:
                default = line.split(":-", 1)[1].rstrip("}").strip() if ":-" in line else ""
                assert "${" in line and default == "", (
                    f"{path.name}/{service}: an admin key must come from the host and "
                    "never be committed with a literal default."
                )


def test_dev_mounts_the_operator_credentials_and_prod_does_not():
    """Dev reads the real account through the operator's CLI credentials; prod
    uses the circuits-cost-explorer-read instance profile over IMDS.

    Without the prod `volumes: !reset []`, compose would mount root's (empty)
    ~/.aws over the container's and boto3's chain would find an empty
    credentials file BEFORE it ever asked IMDS — cost sync would be dead on the
    one box where it matters, with a credentials error as the only clue.
    """
    dev = _service_block(DEV_COMPOSE, "cost-sync")
    assert re.search(r"\$\{HOME\}/\.aws:/root/\.aws:ro", dev), (
        "dev cost-sync must mount ~/.aws READ-ONLY so a local run can reach Cost Explorer"
    )

    prod = _service_block(PROD_COMPOSE, "cost-sync")
    assert re.search(r"^\s*volumes:\s*!reset\s*\[\]", prod, re.M), (
        "docker-compose.prod.yml must reset the dev ~/.aws bind mount — EC2 has no "
        "such directory and credentials come from the instance profile."
    )


def test_the_cost_sync_service_inherits_the_prod_log_cap():
    prod = _service_block(PROD_COMPOSE, "cost-sync")
    assert "logging: *default-logging" in prod, (
        "an hourly loop with an uncapped json-file log is the 238 MB nginx access log "
        "again — see the x-logging anchor's comment."
    )


# ── Distributor part feed (2026-08-17) ──────────────────────────────────────
# POST /api/suppliers/{id}/sync reads MOUSER_API_KEY from process env and 404s
# without it. Absent from this allowlist the key can never arrive, so the
# feature would be permanently "unavailable" on a box whose .env sets it —
# the DEMO_LOGIN_ENABLED failure again.


def test_both_compose_files_pass_the_part_feed_key_through():
    for path in (DEV_COMPOSE, PROD_COMPOSE):
        block = _service_block(path, "api")
        assert re.search(r"^\s*MOUSER_API_KEY:\s*\$\{MOUSER_SEARCH_API_KEY:-\}\s*$", block, re.M), (
            f"{path.name}: the api service must map MOUSER_API_KEY to the HOST variable "
            "MOUSER_SEARCH_API_KEY with an empty default (empty = the sync route 404s, "
            "which is the correct 'not configured' state)."
        )


def test_neither_compose_file_passes_the_host_mouser_api_key_through():
    """The container variable and the host variable share a name ONLY by
    accident of history, and that accident is a trap: a stale, INVALID
    MOUSER_API_KEY already exists in host environments. Interpolating it would
    hand the app a key that authenticates as nobody — every sync would fail
    with a 401 (a FeedFatalError) while the deployment looked configured.
    The working key lives in MOUSER_SEARCH_API_KEY; nothing may read the other.
    """
    for path in (DEV_COMPOSE, PROD_COMPOSE):
        # Comment lines are skipped deliberately: both files EXPLAIN this trap
        # by naming the variable, the same way the ANTHROPIC_ADMIN_KEY guard
        # above matches an env LINE rather than a substring.
        live = [ln for ln in path.read_text().splitlines() if not ln.strip().startswith("#")]
        assert "${MOUSER_API_KEY" not in "\n".join(live), (
            f"{path.name} interpolates the HOST MOUSER_API_KEY. Read from "
            "MOUSER_SEARCH_API_KEY instead — the same-named host value is a "
            "known-invalid key and would silently break every sync."
        )


def test_the_part_feed_key_is_never_pinned_in_a_compose_file():
    for path in (DEV_COMPOSE, PROD_COMPOSE):
        block = _service_block(path, "api")
        line = next(ln for ln in block.splitlines() if ln.strip().startswith("MOUSER_API_KEY:"))
        default = line.split(":-", 1)[1].rstrip("}").strip() if ":-" in line else "<unset>"
        assert default == "", (
            f"{path.name}: a distributor API key must come from the host, never be "
            "committed with a literal default."
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


# ── Nightly feed import (2026-08-18) ────────────────────────────────────────
# app/jobs/feed_import_daily.py has exactly one caller — the `feed-import`
# compose service — and it runs in its OWN container, so the api service's
# allowlist does nothing for it. Third time this pattern is guarded: the
# reminder job and the cost sync were both complete, tested, and unscheduled.


def test_the_nightly_import_job_is_actually_scheduled():
    text = DEV_COMPOSE.read_text()
    assert "feed-import:" in text, (
        "no feed-import service in docker-compose.yml — app.jobs.feed_import_daily "
        "has no caller, so every supplier's nightly toggle is a switch wired to "
        "nothing and the catalog stops growing silently"
    )
    block = _service_block(DEV_COMPOSE, "feed-import")
    assert "app.jobs.feed_import_daily" in block, "the service does not invoke the job"
    assert "restart:" in block, (
        "without a restart policy one crash silences the nightly import until the next deploy"
    )


FEED_IMPORT_SETTINGS = ("DATABASE_URL", "FEED_IMPORT_HOUR_UTC", "FEED_IMPORT_CALL_BUDGET")


def test_the_feed_import_service_carries_its_own_configuration():
    block = _service_block(DEV_COMPOSE, "feed-import")
    for name in FEED_IMPORT_SETTINGS:
        assert f"{name}:" in block, (
            f"{name} is missing from feed-import in docker-compose.yml. The job runs in "
            "its own container, so the api service's allowlist does nothing for it."
        )
    assert re.search(r"^\s*MOUSER_API_KEY:\s*\$\{MOUSER_SEARCH_API_KEY:-\}\s*$", block, re.M), (
        "feed-import must map MOUSER_API_KEY to the HOST variable MOUSER_SEARCH_API_KEY "
        "(the same-named host value is a known-invalid legacy key). Without it, a box "
        "configured only through .env has a nightly job that can never find a key."
    )


def test_the_feed_import_defaults_mirror_the_code_defaults():
    """An empty — or a DIFFERENT — default here does not defer to config.py, it
    overwrites it. The budget is money: a compose default of 900 against a code
    default of 850 would silently spend the difference every night, and nothing
    would ever report the disagreement.
    """
    expected = {
        "FEED_IMPORT_HOUR_UTC": str(Settings.model_fields["FEED_IMPORT_HOUR_UTC"].default),
        "FEED_IMPORT_CALL_BUDGET": str(Settings.model_fields["FEED_IMPORT_CALL_BUDGET"].default),
    }
    block = _service_block(DEV_COMPOSE, "feed-import")
    for name, code_default in expected.items():
        line = next(ln for ln in block.splitlines() if ln.strip().startswith(f"{name}:"))
        assert "${" in line, f"{name} is pinned instead of host-overridable"
        default = line.split(":-", 1)[1].rstrip("}").strip() if ":-" in line else ""
        assert default == code_default, (
            f"the docker-compose.yml default for {name} ({default!r}) has drifted from "
            f"Settings.{name} ({code_default!r})"
        )


def test_the_nightly_budget_leaves_room_under_the_free_tier():
    """The click ceiling (routes/suppliers.py clamps an import to 900) and this
    nightly budget CAN jointly exceed the ~1,000 calls/day a free key allows —
    documented in config.py and the runbook, and deliberately not tracked at
    runtime (the two are separate processes with no shared counter). What must
    stay true is that the nightly run alone leaves headroom for a human to click
    something the next day.
    """
    assert Settings.model_fields["FEED_IMPORT_CALL_BUDGET"].default <= 900


def test_the_feed_import_service_inherits_the_prod_log_cap():
    prod = _service_block(PROD_COMPOSE, "feed-import")
    assert "logging: *default-logging" in prod, (
        "an uncapped json-file log is the 238 MB nginx access log again — see the "
        "x-logging anchor's comment."
    )


def test_deploy_names_the_feed_import_service_in_every_build_list():
    """`up -d` NEVER rebuilds an existing image. A service missing from the
    build list keeps running first-deploy code forever — the cost-sync lesson,
    which is why this is asserted on the shipped script rather than remembered.
    """
    deploy = (ROOT / "deploy.sh").read_text()
    build_lines = [ln for ln in deploy.splitlines() if "COMPOSE_CMD build api" in ln]
    assert build_lines, "no `build api ...` line found in deploy.sh"
    for line in build_lines:
        assert "feed-import" in line, (
            "deploy.sh builds api without feed-import: the nightly import container "
            "would keep whatever code it was first built with, forever."
        )
