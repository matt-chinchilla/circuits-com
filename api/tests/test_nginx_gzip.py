"""Regression guard for edge-nginx gzip compression.

The edge config (`nginx/nginx.ssl.conf`) terminates TLS and proxies `/`,
`/api`, and `/admin`. Gzip MUST be enabled HERE — the inner
`frontend/nginx.conf` gzip directive only compresses what the frontend
container serves directly; it does NOT apply to responses the edge proxies
back from the api upstream. Without edge gzip, the 116 KB category JSON and
the 522 KB JS bundle ship UNCOMPRESSED (config drift: CLAUDE.md claimed
compression on, but it was off at the edge). `gzip_proxied` must be set or
proxied `/api` responses stay uncompressed even with `gzip on`.
(2026-06-07 category-page performance — Phase 0.)
"""

import re
from pathlib import Path

NGINX_CONF = Path(__file__).resolve().parents[2] / "nginx" / "nginx.ssl.conf"


def test_edge_gzip_is_enabled():
    conf = NGINX_CONF.read_text()
    assert re.search(r"^\s*gzip\s+on\s*;", conf, re.MULTILINE), (
        "edge `nginx/nginx.ssl.conf` MUST set `gzip on;` so proxied responses "
        "(category JSON, JS bundle) compress — the inner frontend/nginx.conf "
        "gzip does NOT apply to what the edge proxies from the api upstream."
    )


def test_edge_gzip_covers_json_and_javascript():
    conf = NGINX_CONF.read_text()
    gzip_types_line = next(
        (ln for ln in conf.splitlines() if "gzip_types" in ln), ""
    )
    assert "application/json" in gzip_types_line, (
        "`gzip_types` MUST include application/json or the 116 KB category "
        "JSON ships uncompressed — the headline cold-load lever."
    )
    assert "application/javascript" in gzip_types_line, (
        "`gzip_types` MUST include application/javascript or the 522 KB JS "
        "bundle ships uncompressed."
    )


def test_edge_gzip_proxied_is_set():
    conf = NGINX_CONF.read_text()
    assert re.search(r"^\s*gzip_proxied\s+\S+\s*;", conf, re.MULTILINE), (
        "`gzip_proxied` MUST be set (e.g. `any`) — nginx does NOT compress "
        "proxied responses by default, so /api responses from the api "
        "upstream would stay uncompressed even with `gzip on`."
    )
