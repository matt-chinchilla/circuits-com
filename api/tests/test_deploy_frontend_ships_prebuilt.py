"""Guards for deploy.sh — the frontend is never built on the prod box (D7).

THE OUTAGE (2026-09-23): the Vite build plus the ~15k-page SEO prerender
swap-thrashed the 1.9 GB t3.small until the box stopped answering. The fix
that brought it back was manual: build the prod image HERE from a clean
checkout of origin/master, `docker save | ssh … docker load` it, then
`up -d --no-build`. These tests pin that recipe into every deploy path so
the next `./deploy.sh` can't quietly go back to building on the box.

They parse deploy.sh as text (it is bash), except the --reseed census tests
at the bottom, which RUN ``confirm_reseed`` in bash with every remote call
stubbed (nothing reaches a box)."""

import pathlib
import re
import shlex
import subprocess

import pytest

DEPLOY = (pathlib.Path(__file__).parents[2] / "deploy.sh").read_text()

DEPLOY_PATHS = ("deploy_all", "deploy_frontend", "deploy_reseed")


def _body(fn: str) -> str:
    match = re.search(rf"^{fn}\(\)\s*\{{(.*?)\n\}}", DEPLOY, re.S | re.M)
    assert match, f"deploy.sh has no {fn}() function"
    return match.group(1)


def _code(fn: str) -> list[str]:
    """The function's executable lines — comments explain the old recipe too."""
    return [ln for ln in _body(fn).splitlines() if ln.strip() and not ln.strip().startswith("#")]


def test_no_remote_line_builds_the_frontend():
    for line in DEPLOY.splitlines():
        if "COMPOSE_CMD build" in line:
            assert not re.search(r"\bbuild\b[^&|;]*\bfrontend\b", line), line


def test_every_deploy_path_ships_the_prebuilt_image():
    for fn in DEPLOY_PATHS:
        assert "ship_frontend_image" in _body(fn), fn


def test_the_image_ships_before_the_box_starts_anything():
    # Shipping after `up -d` would start the OLD image and leave the new one
    # sitting unused until the next deploy.
    for fn in DEPLOY_PATHS:
        code = "\n".join(_code(fn))
        ship = code.index("ship_frontend_image")
        up = code.index("up -d")
        assert ship < up, f"{fn}: ship_frontend_image must run before the remote `up -d`"


def test_every_remote_up_refuses_to_build():
    # `up -d` builds a missing image on its own; --no-build makes a missing
    # frontend image an error instead of a 15k-page build on the box.
    ups = 0
    for fn in DEPLOY_PATHS:
        for line in _code(fn):
            for up in re.findall(r"up -d[^&|;\"]*", line):
                ups += 1
                assert "--no-build" in up, f"{fn}: {up!r}"
    assert ups == len(DEPLOY_PATHS), "each deploy path starts its services exactly once"


def test_ship_builds_from_a_clean_origin_master_worktree():
    body = _body("ship_frontend_image")
    assert "git worktree add" in body and "origin/master" in body
    assert "docker save" in body and "docker load" in body
    # The prod stage, the one prod compose selects (`target: prod`).
    assert "--target prod" in body


def test_ship_keeps_a_rollback_and_tags_the_name_compose_runs():
    body = _body("ship_frontend_image")
    # compose (project circuits-com, service frontend, no image: key) runs
    # circuits-com-frontend:latest — the shipped image must land on that name.
    assert "circuits-com-frontend:latest" in body
    assert "circuits-com-frontend:previous" in body
    assert body.index("circuits-com-frontend:previous") < body.index("docker load"), (
        "the running image must be retagged as the rollback BEFORE the new one loads"
    )


def test_ship_cleans_up_its_worktree_on_both_outcomes():
    body = _body("ship_frontend_image")
    assert body.count("git worktree remove") >= 2, (
        "a failed build must not leave a stray worktree registered in the repo"
    )


def test_ssh_key_push_cannot_eat_the_image_stream():
    # The image is piped into the brace group; anything in it that reads stdin
    # before ssh would swallow bytes of the tarball.
    body = _body("ship_frontend_image")
    assert re.search(r"push_ssh_key\s*<\s*/dev/null", body), body


def test_verify_probes_the_key_gated_stripe_routes():
    body = _body("verify_site")
    assert "/api/stripe/webhook" in body and "-X POST" in body and '"400"' in body
    assert "/api/checkout/exclusive/slots?tier=gold" in body and '"200"' in body


# ─── --reseed guard (LU-F17) ────────────────────────────────────────────────

RESEED_SENTENCE = "Stripe-billed sponsors that will lose their board but keep being charged:"


def test_reseed_counts_stripe_billed_sponsors_before_the_parts_prompt():
    body = _body("confirm_reseed")
    assert RESEED_SENTENCE in body
    assert "sponsor_billing" in body
    assert body.index(RESEED_SENTENCE) < body.index("parts that would be DESTROYED"), (
        "the billing guard must run before (and independently of) the parts prompt, "
        "which returns early when no parts are at risk"
    )


def test_reseed_billing_count_uses_the_status_rule():
    body = _body("confirm_reseed")
    assert "s.status IS NULL OR s.status <> 'Expired'" in body


def test_reseed_requires_the_billed_count_typed_back():
    body = _body("confirm_reseed")
    assert re.search(r'\[\[\s*"\$\w+"\s*!=\s*"\$billed"\s*\]\]', body), (
        "the operator must type the billed-sponsor count back"
    )


def test_reseed_refuses_blind_when_billing_cannot_be_counted():
    body = _body("confirm_reseed")
    assert re.search(r'\[\[\s*"\$billed"\s*=~\s*\^\[0-9\]\+\$\s*\]\]', body)
    assert "Could not count Stripe-billed sponsors" in body


# ─── --reseed census (F11): the guard asks Stripe too ───────────────────────
# The DB count alone misses a rep-quoted subscription whose sponsor never got
# a billing row. confirm_reseed runs app.jobs.billing_census on the box
# ("<db> <stripe>") and refuses unless BOTH are 0 or the operator types the
# larger. These tests RUN the real function in bash with run_remote stubbed.


def test_reseed_runs_the_census_job_in_the_api_container():
    body = _body("confirm_reseed")
    assert re.search(r"exec -T api python -m app\.jobs\.billing_census < /dev/null", body), (
        "the census runs inside the api container, stdin detached (the exec -T gotcha)"
    )


def _run_confirm(census: str, typed: str = "", fallback: str = "0") -> subprocess.CompletedProcess:
    """Run confirm_reseed with the box stubbed: the census job prints
    ``census``; the pre-census psql fallback prints ``fallback``; no parts are
    at risk (so only the billing prompt can stop it)."""
    fn = re.search(r"^confirm_reseed\(\)\s*\{.*?\n\}", DEPLOY, re.S | re.M).group(0)
    census_step = "return 1" if census == "FAIL" else f"printf '%s\\n' {shlex.quote(census)}"
    script = f"""
set -euo pipefail
red() {{ echo "RED: $*"; }}
yellow() {{ echo "YELLOW: $*"; }}
green() {{ echo "GREEN: $*"; }}
python3() {{ cat > /dev/null; echo 0; }}
APP_DIR=/opt/app
COMPOSE_CMD="sudo docker compose"
run_remote() {{
    case "$*" in
        *billing_census*) {census_step} ;;
        *to_regclass*) echo t ;;
        *sponsor_billing*|*stripe_subscription_id*) printf '%s\\n' {shlex.quote(fallback)} ;;
        *"FROM parts"*) echo 0 ;;
    esac
}}
{fn}
confirm_reseed
echo "PROCEEDED"
"""
    return subprocess.run(
        ["bash", "-c", script],
        input=typed + "\n",
        capture_output=True,
        text=True,
        timeout=20,
    )


def test_reseed_census_both_zero_proceeds_without_a_prompt():
    out = _run_confirm("0 0")
    assert out.returncode == 0, out.stderr
    assert "PROCEEDED" in out.stdout
    assert "type that number" not in out.stdout


@pytest.mark.parametrize(
    ("census", "larger"),
    [("0 3", "3"), ("2 1", "2"), ("4 4", "4"), ("0 unavailable", "0"), ("5 unavailable", "5")],
)
def test_reseed_census_demands_the_larger_number(census, larger):
    refused = _run_confirm(census, typed="")
    assert "PROCEEDED" not in refused.stdout, census
    assert f"({larger})" in refused.stdout, refused.stdout
    assert "Reseed cancelled" in refused.stdout

    wrong = _run_confirm(census, typed=str(int(larger) + 1))
    assert "PROCEEDED" not in wrong.stdout, census

    typed = _run_confirm(census, typed=larger)
    assert typed.returncode == 0, typed.stderr
    assert "PROCEEDED" in typed.stdout, (census, typed.stdout)


def test_reseed_census_says_when_stripe_could_not_be_asked():
    out = _run_confirm("0 unavailable")
    assert "Stripe could not be counted" in out.stdout


@pytest.mark.parametrize("census", ["", "FAIL"])
def test_reseed_falls_back_to_the_database_count_on_an_older_api_image(census):
    """The box's api image predates the census job (the first deploy of it:
    `python -m` exits non-zero, which under `set -euo pipefail` must not kill
    the script silently): count the database directly, Stripe unknown."""
    out = _run_confirm(census, typed="", fallback="2")
    assert "PROCEEDED" not in out.stdout
    assert "(2)" in out.stdout, out.stdout + out.stderr
    assert "PROCEEDED" in _run_confirm(census, typed="2", fallback="2").stdout
    # Zero in the database is still not proof: Stripe was never asked.
    assert "PROCEEDED" not in _run_confirm(census, typed="", fallback="0").stdout
    assert "PROCEEDED" in _run_confirm(census, typed="0", fallback="0").stdout


def test_reseed_census_refuses_blind_when_nothing_answers():
    out = _run_confirm("garbage", fallback="")
    assert out.returncode == 1
    assert "refusing to reseed blind" in out.stdout
    assert "PROCEEDED" not in out.stdout
