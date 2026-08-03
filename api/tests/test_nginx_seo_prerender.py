"""Regression guard for the nginx half of the build-time SEO prerender.

`frontend/scripts/seoPrerender.ts` writes one static HTML document per
templated route (`/about` -> `about/index.html`, `/category/a/b` ->
`category/a/b/index.html`, `/` -> `home.html`). Those files are inert unless
nginx resolves a request to them, so the two try_files rules below are load-
bearing: drop either and every URL silently reverts to the byte-identical SPA
shell that was the P0 SEO defect.
"""

import re
from pathlib import Path

NGINX_CONF = Path(__file__).resolve().parents[2] / "frontend" / "nginx.conf"


def _location_body(conf: str, header: str) -> str:
    """Return the body of a non-nested `location <header> { ... }` block."""
    match = re.search(re.escape(header) + r"\s*\{([^}]*)\}", conf)
    assert match, f"no `{header}` block found in frontend/nginx.conf"
    return match.group(1)


def test_prerendered_route_documents_are_reachable():
    conf = NGINX_CONF.read_text()
    body = _location_body(conf, "location /")
    assert "$uri/index.html" in body, (
        "`location /` must try `$uri/index.html` BEFORE falling back to "
        "/index.html, or the prerendered per-route documents are never served "
        "and every URL returns the generic SPA shell again."
    )
    # Order matters: the fallback has to come last or it wins every time.
    assert body.index("$uri/index.html") < body.index("/index.html;"), (
        "the /index.html SPA fallback must be the LAST try_files entry."
    )


def test_home_is_served_from_its_own_document():
    conf = NGINX_CONF.read_text()
    body = _location_body(conf, "location = /")
    assert "home.html" in body, (
        "`/` must serve the prerendered home.html. index.html cannot carry "
        "home's canonical because it is also the SPA fallback for the ~3,600 "
        "part URLs, which would then all advertise `rel=canonical -> /`."
    )
    assert "/index.html" in body, (
        "home.html must fall back to /index.html so a build without the "
        "prerender step still serves the site."
    )


def test_spa_fallback_shell_carries_no_canonical():
    """index.html is inherited by every un-prerendered route."""
    index_html = NGINX_CONF.parent / "index.html"
    assert 'rel="icon"' in index_html.read_text(), "sanity: read the right file"
    assert 'rel="canonical"' not in index_html.read_text(), (
        "a canonical hardcoded in index.html is inherited by every route that "
        "falls back to it — part pages, keyword profiles and 404s would all "
        "point at whichever URL it names."
    )
