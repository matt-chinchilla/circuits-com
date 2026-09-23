"""Guards for deploy.sh — the frontend is never built on the prod box (D7).

THE OUTAGE (2026-09-23): the Vite build plus the ~15k-page SEO prerender
swap-thrashed the 1.9 GB t3.small until the box stopped answering. The fix
that brought it back was manual: build the prod image HERE from a clean
checkout of origin/master, `docker save | ssh … docker load` it, then
`up -d --no-build`. These tests pin that recipe into every deploy path so
the next `./deploy.sh` can't quietly go back to building on the box.

They parse deploy.sh as text (it is bash; nothing here runs it)."""

import pathlib
import re

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
