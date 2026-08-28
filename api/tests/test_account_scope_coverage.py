"""Every /api/account route must ride the customer gate — structurally.

The per-endpoint files prove each route SCOPES correctly; this guard proves no
future account route can ship without the gate at all. Two halves, and the
second is the one that matters:

1. Every mounted /api/account route's dependency tree contains
   ``require_account_user`` (directly, or through ``account_scope``).
2. AN ANTI-VACUITY FLOOR. This feature produced five tests that asserted
   nothing before anyone noticed, so a sweep over "whatever routes exist" is
   not trusted: the known route set is pinned and must be PRESENT. If the
   routers silently fall out of main.py, this fails loudly instead of passing
   over an empty enumeration.

Mutation-proven 2026-08-27: dropping ``app.include_router(account_catalog...)``
from main.py reddens the floor; renaming the gate the walker looks for reddens
every row of the sweep (proving the dependency walk actually walks).
"""

from fastapi.routing import APIRoute

from app.main import app

# The console's account surface as of migration 046. ADD to this when you add
# a route — its absence here is the reminder that it needs a scoping test too.
EXPECTED = {
    ("GET", "/api/account/me"),
    ("DELETE", "/api/account/me"),
    ("GET", "/api/account/dashboard"),
    ("GET", "/api/account/parts"),
    ("GET", "/api/account/categories"),
    ("GET", "/api/account/manufacturers"),
    ("GET", "/api/account/suppliers"),
    ("GET", "/api/account/my-supply"),
    ("GET", "/api/account/my-manufacturing"),
    ("GET", "/api/account/sponsors"),
    ("GET", "/api/account/messages"),
    ("GET", "/api/account/messages/{message_id}"),
    ("PATCH", "/api/account/messages/{message_id}"),
    ("GET", "/api/account/kpi"),
    ("PUT", "/api/account/kpi"),
    ("GET", "/api/account/referral-clicks"),
    ("GET", "/api/account/revenue"),
    ("GET", "/api/account/sponsor-mix"),
    ("GET", "/api/account/book-of-business"),
    ("GET", "/api/account/activity"),
    ("GET", "/api/account/import-queue"),
    ("GET", "/api/account/operating-costs"),
    ("GET", "/api/account/leads-summary"),
}

GATE = "require_account_user"


def _dependency_names(dependant) -> set[str]:
    names = set()
    for dep in dependant.dependencies:
        if dep.call is not None:
            # Instances (HTTPBearer) have no __name__ — report their class.
            names.add(getattr(dep.call, "__name__", type(dep.call).__name__))
        names |= _dependency_names(dep)
    return names


def _account_routes() -> dict[tuple[str, str], APIRoute]:
    return {
        (method, route.path): route
        for route in app.routes
        if isinstance(route, APIRoute) and route.path.startswith("/api/account")
        for method in route.methods
    }


def test_every_account_route_carries_the_customer_gate():
    routes = _account_routes()
    ungated = sorted(
        f"{m} {p}" for (m, p), r in routes.items() if GATE not in _dependency_names(r.dependant)
    )
    assert not ungated, f"account routes without {GATE}: {ungated}"


def test_the_known_surface_is_actually_mounted():
    """The floor. A sweep over zero routes proves nothing."""
    mounted = set(_account_routes())
    missing = EXPECTED - mounted
    assert not missing, f"expected account routes are not mounted: {sorted(missing)}"
    assert len(mounted) >= len(EXPECTED)
