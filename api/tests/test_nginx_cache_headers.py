"""Regression guard for the frontend nginx cache-header contract.

The unhashed SPA entry (`index.html`, served by `location /`) MUST be
`Cache-Control: no-cache` so browsers always revalidate it and pick up new
hashed-asset names after a rebuild/deploy. Without it, a stale cached
index.html pairs with a newer asset set -> 404 on old chunk hashes ->
"failed to preload the CSS". Hashed assets, by contrast, MUST stay
`immutable`. The service-worker scripts must also stay no-cache so browsers
adopt new caching rules. (2026-05-28 stale-CSS bug.)
"""

import re
from pathlib import Path

NGINX_CONF = Path(__file__).resolve().parents[2] / "frontend" / "nginx.conf"


def _location_body(conf: str, header: str) -> str:
    """Return the body of a non-nested `location <header> { ... }` block."""
    match = re.search(re.escape(header) + r"\s*\{([^}]*)\}", conf)
    assert match, f"no `{header}` block found in frontend/nginx.conf"
    return match.group(1)


def test_index_html_is_no_cache():
    conf = NGINX_CONF.read_text()
    body = _location_body(conf, "location /")
    assert 'Cache-Control "no-cache"' in body, (
        "`location /` serves index.html + the SPA fallback; it MUST set "
        'Cache-Control "no-cache" so the browser revalidates the entry HTML '
        "and never pairs a stale index.html with new asset hashes."
    )


def test_hashed_assets_stay_immutable():
    conf = NGINX_CONF.read_text()
    assert "immutable" in conf, (
        "hashed asset rule must keep `Cache-Control: ... immutable` — those "
        "filenames are content-hashed and safe to cache forever."
    )


def test_service_worker_scripts_are_no_cache():
    conf = NGINX_CONF.read_text()
    for header in ("location = /sw.js", "location = /registerSW.js"):
        body = _location_body(conf, header)
        assert 'Cache-Control "no-cache"' in body, (
            f"`{header}` must stay no-cache so browsers adopt new SW rules."
        )
