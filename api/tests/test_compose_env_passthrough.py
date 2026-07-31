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
