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


# ── The sitemap seam (2026-09-22) ───────────────────────────────────────────
# The sitemap index and the part sitemaps are STATIC files the frontend build
# writes beside the prerendered part documents, so a part URL is advertised if
# and only if its document exists. That property lives entirely in nginx: the
# frontend container must serve the files (and 404 — never the SPA shell — when
# one is absent), and the prod edge must ask the frontend FIRST and fall back
# to the API only on that 404. No API or vitest test can see either config:
# delete a block and every suite stays green while the live-ranked drift that
# served 35% shells (audit 2026-09-21) comes back.


PROD_NGINX_CONF = Path(__file__).resolve().parents[2] / "nginx" / "nginx.ssl.conf"

INDEX = "/sitemap.xml"
PARTS_PAGES = ["/sitemap-parts-1.xml", "/sitemap-parts-12.xml"]
CORE = "/sitemap-core.xml"


def _block_after(conf: str, open_brace: int) -> str:
    """The body of the `{ ... }` opening at `open_brace`, nested blocks included.

    Brace-balanced rather than `[^}]*`: the frontend's sitemap location nests a
    `types { }` block, which a flat pattern would cut off at its first `}`.
    """
    depth = 0
    for i in range(open_brace, len(conf)):
        if conf[i] == "{":
            depth += 1
        elif conf[i] == "}":
            depth -= 1
            if depth == 0:
                return conf[open_brace + 1 : i]
    raise AssertionError("unbalanced braces in nginx config")


def _regex_locations(conf: str) -> list[tuple[str, str]]:
    """(pattern, body) for every `location ~ <regex> { ... }`, in file order.

    nginx tries regex locations in the order they appear and takes the FIRST
    match, so the order returned here is the order that decides routing.
    """
    return [
        (m.group(1), _block_after(conf, m.end() - 1))
        for m in re.finditer(r"location\s+~\*?\s+(\S+)\s*\{", conf)
    ]


def _first_regex_match(conf: str, uri: str) -> str:
    for pattern, body in _regex_locations(conf):
        if re.search(pattern, uri):
            return body
    raise AssertionError(f"no regex location matches {uri}")


def _location_body_in(conf: str, header: str) -> str:
    """Body of the first `<header> { ... }` block, nested blocks included."""
    match = re.search(re.escape(header) + r"\s*\{", conf)
    assert match, f"no `{header}` block found"
    return _block_after(conf, match.end() - 1)


def test_the_frontend_serves_its_built_sitemaps_and_404s_a_missing_one():
    conf = NGINX_CONF.read_text()
    for uri in [INDEX, *PARTS_PAGES]:
        body = _first_regex_match(conf, uri)
        assert "try_files $uri =404;" in body, (
            f"{uri} must be served from dist/ or 404 — falling through to the SPA "
            "fallback would answer a crawler's sitemap fetch with a 200 of HTML, "
            "and the edge could never fall back to the API."
        )
        assert "/index.html" not in body
        assert "default_type application/xml;" in body, "sitemaps are XML, as the API typed them"
        assert "immutable" not in body, "a sitemap changes every deploy; it must not be immutable"


def test_the_frontend_leaves_the_core_child_to_the_api():
    """/sitemap-core.xml is live on the API; the frontend has no file for it."""
    conf = NGINX_CONF.read_text()
    assert not [p for p, _ in _regex_locations(conf) if re.search(p, CORE) and "sitemap" in p]


def test_prod_edge_asks_the_frontend_first_for_the_index():
    conf = PROD_NGINX_CONF.read_text()
    body = _location_body_in(conf, "location = /sitemap.xml")
    assert "proxy_pass http://frontend;" in body, (
        "the index must come from the frontend build, which knows which part "
        "documents exist — the API does not."
    )
    assert "proxy_intercept_errors on;" in body
    assert "error_page 404 = @sitemap_from_api;" in body


def test_prod_edge_asks_the_frontend_first_for_every_parts_page():
    conf = PROD_NGINX_CONF.read_text()
    for uri in PARTS_PAGES:
        body = _first_regex_match(conf, uri)
        assert "proxy_pass http://frontend;" in body, (
            f"{uri} reached the API first — the generic sitemap-* location must stay "
            "BELOW the parts location, since nginx takes the first matching regex."
        )
        assert "proxy_intercept_errors on;" in body
        assert "error_page 404 = @sitemap_from_api;" in body


def test_prod_edge_falls_back_to_the_api_under_the_same_path():
    conf = PROD_NGINX_CONF.read_text()
    body = _location_body_in(conf, "location @sitemap_from_api")
    assert "proxy_pass http://api/api$uri;" in body


def test_prod_edge_still_routes_the_core_child_to_the_api():
    """The index advertises /sitemap-core.xml at the ROOT (path-scope rule)."""
    conf = PROD_NGINX_CONF.read_text()
    assert "proxy_pass http://api/api/$1;" in _first_regex_match(conf, CORE)
