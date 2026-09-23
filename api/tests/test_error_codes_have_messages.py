"""Every machine-code ``detail`` the sales / billing / checkout routes raise has
a sentence waiting for it in the admin client.

A 4xx ``detail`` that is a snake_case CODE (``not_a_conflict``) rather than prose
is printed through ``apiErrorDetail`` → ``CODE_MESSAGES``
(``frontend/src/admin/services/apiError.ts``); a code missing from that map is
shown to the rep verbatim, underscores and all. The vitest suite pins a
hand-kept list of codes, which is exactly how ``not_a_conflict`` slipped past
it: nobody added it to the list. This test DISCOVERS the codes instead.

Discovery is by AST, not grep: every ``HTTPException(...)`` call in the scanned
modules whose ``detail=`` is a string literal, or a name / attribute resolving
to a module-level string constant (``detail=BILLING_ACTIVE``), and whose value
is snake_case. Prose and f-strings are human copy already and are ignored.

Rules, named:

* ADMIN codes → a key of ``CODE_MESSAGES``.
* PUBLIC /join codes (raised ONLY by ``routes/checkout.py``, which only the
  public /join page calls) may instead be answered by /join's own copy,
  ``checkoutErrorMessage`` in ``frontend/src/public/pages/join/exclusive.ts``,
  whose sentence for each is pinned by ``exclusive.test.ts`` — so such a code
  passes when that test file names it.
* ``routes/stripe_webhooks.py`` is NOT scanned: its 400s answer Stripe's
  delivery log, never a person.
* The billing reader wall's ``no_billing_access`` is raised from
  ``auth_service`` (shared with every other wall, so not scanned wholesale)
  and is listed explicitly.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

from app.services.auth_service import NO_BILLING_ACCESS_DETAIL

API = Path(__file__).resolve().parents[1]
REPO = API.parent
API_ERROR_TS = REPO / "frontend/src/admin/services/apiError.ts"
JOIN_COPY_TEST = REPO / "frontend/src/public/pages/join/exclusive.test.ts"

ROUTES = (
    "admin_billing",
    "admin_checkout_intents",
    "admin_quotes",
    "admin_sales_codes",
    "admin_sponsors",
    "billing_card",
    "checkout",
)
SERVICES = (
    "billing_followups",
    "billing_guard",
    "billing_mirror",
    "billing_sweep",
    "card_links",
    "checkout_intents",
    "sales_codes",
    "sales_pricing",
    "stripe_billing",
    "stripe_checkout",
    "stripe_quotes",
    "stripe_webhook",
)
PUBLIC_JOIN_ROUTE = "routes/checkout.py"
KNOWN_CONSTANTS = {NO_BILLING_ACCESS_DETAIL: "services/auth_service.py (require_billing_reader)"}

CODE = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$")


def _scanned() -> list[Path]:
    return [API / "app/routes" / f"{m}.py" for m in ROUTES] + [
        API / "app/services" / f"{m}.py" for m in SERVICES
    ]


def _constants(trees: dict[Path, ast.Module]) -> dict[str, str]:
    """Module-level ``NAME = "string"`` across every scanned module."""
    found: dict[str, str] = {}
    for tree in trees.values():
        for node in tree.body:
            if (
                isinstance(node, ast.Assign)
                and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str)
            ):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        found[target.id] = node.value.value
    return found


def _is_http_exception(call: ast.Call) -> bool:
    fn = call.func
    return (isinstance(fn, ast.Name) and fn.id == "HTTPException") or (
        isinstance(fn, ast.Attribute) and fn.attr == "HTTPException"
    )


def raised_codes() -> dict[str, set[str]]:
    """snake_case code → the scanned files (repo-relative) that raise it."""
    trees = {path: ast.parse(path.read_text(), str(path)) for path in _scanned()}
    constants = _constants(trees)
    codes: dict[str, set[str]] = {}
    for path, tree in trees.items():
        where = str(path.relative_to(API / "app"))
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and _is_http_exception(node)):
                continue
            for kw in node.keywords:
                if kw.arg != "detail":
                    continue
                value = kw.value
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    text = value.value
                elif isinstance(value, ast.Name):
                    text = constants.get(value.id)
                elif isinstance(value, ast.Attribute):
                    text = constants.get(value.attr)
                else:
                    text = None  # f-string / call / expression: prose, not a code
                if text and CODE.fullmatch(text):
                    codes.setdefault(text, set()).add(where)
    for code, where in KNOWN_CONSTANTS.items():
        codes.setdefault(code, set()).add(where)
    return codes


def code_messages() -> set[str]:
    source = API_ERROR_TS.read_text()
    start = source.index("const CODE_MESSAGES")
    body = source[start : source.index("\n};", start)]
    return set(re.findall(r"^\s+([a-z][a-z0-9_]*):", body, flags=re.MULTILINE))


def test_discovery_sees_the_codes_it_is_meant_to_police():
    """A broken scan would pass vacuously — pin a few codes it MUST find, one
    of each shape (literal, same-module constant, public-only, known)."""
    codes = raised_codes()
    for code in (
        "not_a_conflict",  # detail="…" literal
        "billing_active",  # detail=BILLING_ACTIVE (billing_guard constant)
        "legacy_price",  # detail=LEGACY_PRICE (admin_billing constant)
        "slot_taken",  # public /join only
        "no_billing_access",  # the billing reader wall
    ):
        assert code in codes, f"{code} not discovered; found {sorted(codes)}"


def test_every_admin_code_has_a_sentence():
    messages = code_messages()
    assert "not_a_conflict" in messages  # sanity: the map parsed
    missing = sorted(
        f"{code} (raised in {', '.join(sorted(where))})"
        for code, where in raised_codes().items()
        if where != {PUBLIC_JOIN_ROUTE} and code not in messages
    )
    assert not missing, (
        "machine-code details with no CODE_MESSAGES entry in "
        f"frontend/src/admin/services/apiError.ts: {missing}"
    )


def test_every_public_join_code_has_a_sentence_somewhere():
    messages = code_messages()
    join_copy = JOIN_COPY_TEST.read_text()
    missing = sorted(
        code
        for code, where in raised_codes().items()
        if where == {PUBLIC_JOIN_ROUTE} and code not in messages and f"'{code}'" not in join_copy
    )
    assert not missing, (
        "public /join codes answered neither by CODE_MESSAGES nor by a pinned "
        f"checkoutErrorMessage sentence (exclusive.test.ts): {missing}"
    )
