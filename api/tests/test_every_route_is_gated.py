"""Every route carries a gate, or is on the allowlist. No third option.

This inverts the failure mode: a route added six months from now fails this
suite by DEFAULT rather than being silently reachable. Same construction as
test_leads_never_public.py.

It matches on FUNCTION IDENTITY, walking route.dependant.dependencies — not on
the path string and not on a decorator, either of which a route could satisfy
while being ungated.

Two assertions, because they answer two different questions:

* :func:`test_every_route_is_gated_or_allowlisted` — "does anything at all
  stand between the internet and this route?"
* :func:`test_every_authenticated_route_carries_the_customer_staff_wall` —
  "does this route say WHICH principal may pass?"  A bearer token proves only
  that somebody signed in, and since public registration exists that somebody
  may be a stranger's customer account. ``get_current_user`` is deliberately
  role-agnostic, so it answers the first question and not the second.

The allowlist is keyed on **(method, path)**, not path alone. That is not
fussiness: ``GET /api/parts/`` is the public catalog while ``POST /api/parts/``
creates a part, and a path-keyed allowlist exempts the second along with the
first. Verified by mutation — path-keyed, reverting the POST to the old
role-agnostic gate left this file green.
"""

from fastapi.routing import APIRoute

from app.main import app
from app.routes.calendar import require_calendar_access
from app.services.auth_service import (
    get_authenticated_user,
    require_account_user,
    require_staff,
)

# The dependencies that name a PRINCIPAL — the D16 customer/staff wall.
# ``require_console_user`` is deliberately NOT here: the 2026-08-27 fail-closed
# pass removed its every production use precisely because it ADMITS customer
# principals. Blessing it would let the next staff route re-open that door
# with this guard still green.
WALL = {require_staff, require_account_user}

# ``require_calendar_access`` is a wall too, but the walk below cannot see it:
# it CALLS require_staff rather than declaring it, because its other
# door (the Roundcube plugin's shared secret) arrives with no bearer token at
# all and a declared dependency would 401 it first. Named here by identity so
# the calendar is neither exempted nor mislabelled public — and backed by
# test_the_calendar_gate_really_is_a_wall below, so this stays a fact.
WALL_BY_CALL = {require_calendar_access}

# Proving a token is valid is a gate; it is not a wall. get_authenticated_user
# earns a place here only for the two endpoints a flagged user must still
# reach (see EXEMPT_FROM_THE_WALL).
GATES = WALL | WALL_BY_CALL | {get_authenticated_user}

# Deliberately unauthenticated. Adding a line here is an edit a human must
# look at — that is the entire point of the allowlist.
PUBLIC_ROUTES = {
    # Auth: the doors themselves, plus registration and verification.
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/logout"),
    ("POST", "/api/auth/forgot-password"),
    ("POST", "/api/auth/reset-password"),
    ("POST", "/api/auth/forgot-username"),
    ("POST", "/api/auth/signup"),
    ("POST", "/api/auth/verify"),
    ("POST", "/api/auth/resend-verification"),
    # The public catalog — every one of these renders a page on the public site.
    # Note the reads only: POST /api/parts/ and POST /api/suppliers/ share
    # these paths and are console routes.
    ("GET", "/api/categories/"),
    ("GET", "/api/categories/{slug}"),
    ("GET", "/api/categories/{slug}/partners"),
    ("GET", "/api/suppliers/"),
    ("GET", "/api/suppliers/{supplier_id}"),
    ("GET", "/api/suppliers/{supplier_id}/parts"),
    ("GET", "/api/parts/"),
    ("GET", "/api/parts/{part_id}"),
    ("GET", "/api/parts/{part_id}/related"),
    ("GET", "/api/parts/by-slug/{slug}"),
    ("GET", "/api/search/"),
    ("GET", "/api/manufacturers/"),
    ("GET", "/api/sponsors/keyword/{keyword}"),
    # Four catalog totals behind the About page's stat strip. Public
    # because the page is, and because every figure in it is already
    # countable from the sitemap — it names no supplier and exposes no
    # id, only how many of each thing exists.
    ("GET", "/api/stats/"),
    # Public forms and instrumentation.
    ("POST", "/api/contact"),
    ("POST", "/api/join"),
    ("POST", "/api/keyword-request"),
    ("POST", "/api/track"),
    ("POST", "/api/outbound"),
    # The sitemap is an INDEX plus its children (2026-09-01). All three
    # advertise nothing but URLs that are themselves public.
    ("GET", "/api/sitemap.xml"),
    ("GET", "/api/sitemap-core.xml"),
    ("GET", "/api/sitemap-parts-{page}.xml"),
    # Read-only, hard-capped ranked slug slice the build-time SEO prerender
    # reads. Public for the same reason the sitemap is: it advertises URLs
    # that are themselves public, and gating it would put a bearer token in
    # the manifest-regen CLI.
    ("GET", "/api/seo/prerender-parts"),
    # Money. The webhook authenticates by HMAC over the raw body, and the
    # self-serve Silver checkout is a PUBLIC purchase path by design.
    ("POST", "/api/stripe/webhook"),
    ("GET", "/api/checkout/silver"),
    ("POST", "/api/checkout/silver"),
    ("GET", "/api/checkout/silver/boards"),
    # The BOM tool is explicitly no-login, share links included.
    ("POST", "/api/bom/match"),
    ("POST", "/api/bom/resolve"),
    ("POST", "/api/bom/share"),
    ("GET", "/api/bom/share/{slug}"),
    ("GET", "/api/health"),
}

# The two authenticated endpoints that must stay reachable by ANY principal:
# a flagged user has to be able to ask who they are and set a new password, and
# an unactivated customer has to get far enough to be told they are not
# activated. Both are on get_authenticated_user for exactly that reason.
EXEMPT_FROM_THE_WALL = {
    ("GET", "/api/auth/me"),
    ("POST", "/api/auth/change-password"),
}


def _gate_calls(route):
    seen = set()
    stack = list(route.dependant.dependencies)
    while stack:
        dep = stack.pop()
        if dep.call is not None:
            seen.add(dep.call)
        stack.extend(dep.dependencies)
    return seen


def _endpoints():
    """Every (method, path, route) the app serves. HEAD rides along with GET."""
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        for method in sorted(route.methods):
            if method in ("HEAD", "OPTIONS"):
                continue
            yield method, route.path, route


def _listed(method, path, allowlist):
    return (method, path) in allowlist or (method, path.rstrip("/")) in allowlist


def test_every_route_is_gated_or_allowlisted():
    ungated = []
    for method, path, route in _endpoints():
        if _listed(method, path, PUBLIC_ROUTES):
            continue
        if not (_gate_calls(route) & GATES):
            ungated.append(f"{method} {path}")
    assert not ungated, "These routes carry no gate and are not allowlisted:\n  " + "\n  ".join(
        sorted(ungated)
    )


def test_every_authenticated_route_carries_the_customer_staff_wall():
    """A valid token is not an authorization decision.

    Without this, a console route added with the old role-agnostic
    ``get_current_user`` would pass the suite above while being reachable by
    any activated customer's token — which is the exact hole D16/D17 exist to
    close, and which the wall was applied to close.
    """
    unwalled = []
    for method, path, route in _endpoints():
        if _listed(method, path, PUBLIC_ROUTES) or _listed(method, path, EXEMPT_FROM_THE_WALL):
            continue
        gates = _gate_calls(route)
        if not (gates & GATES):
            continue  # already reported by the test above
        if not (gates & (WALL | WALL_BY_CALL)):
            unwalled.append(f"{method} {path}")
    assert not unwalled, (
        "These routes authenticate but never say WHICH principal may pass — "
        "add require_staff (or require_account_user):\n  " + "\n  ".join(sorted(unwalled))
    )


def test_the_allowlist_only_names_endpoints_that_exist():
    # A stale allowlist entry is a silent hole waiting for a path to be reused.
    live = set()
    for method, path, _route in _endpoints():
        live.add((method, path))
        live.add((method, path.rstrip("/")))
    stale = {e for e in PUBLIC_ROUTES | EXEMPT_FROM_THE_WALL if e not in live}
    assert not stale, f"allowlist names endpoints that do not exist: {sorted(stale)}"


def test_the_calendar_gate_really_is_a_wall(client, seeded_db, auth_header):
    """WALL_BY_CALL is an assertion of fact, so prove the fact.

    Naming require_calendar_access as a wall is worthless if it stops being
    one. Since the fail-closed pass (2026-08-27) the calendar is STAFF-only:
    a customer is refused on PRINCIPAL, before activation is even consulted,
    so activated and unactivated customers get the same staff_only body.
    """
    resp = client.get(
        "/api/calendar/events", headers=auth_header(email="kennedy_user@test.example")
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "staff_only"
