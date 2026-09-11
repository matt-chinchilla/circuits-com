"""Flow (Sankey) aggregations for the staff Reports page.

Two flows, both pure functions over rows the route fetches, so the bucketing
and the conservation rules are unit-testable without a database:

- ``traffic_flow`` — one SESSION is one unit of flow: where it came from
  (referrer bucket) → the page type it landed on → what it did next (the page
  type of its second view, or "Left the site"). Every session appears in every
  column exactly once, so each column's links sum to the session count.
- ``parts_flow`` — one part-page VIEW is one unit: category → subcategory →
  part (the top N by views, the rest pooled), with distributor clicks carried
  beside it as a fourth column the client draws only once there are enough
  to read. Views on a path that resolves to no real part (a smoke-test slug,
  a deleted part) are dropped, never labelled — nothing that is not in the
  catalog reaches a chart a partner will see.

Node ids are ``<column>:<label>`` so a label may repeat across columns
("Category page" as a landing page AND as a next step) while ECharts, which
keys nodes by name, still sees distinct nodes; the client formats labels off
``label``, never off the id.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from urllib.parse import urlparse

DIRECT = "Direct"
OTHER_SITES = "Other sites"
LEFT = "Left the site"
OTHER_PARTS = "All other parts"
OTHER_SUBCATEGORIES = "Other subcategories"
OWN_HOST = "circuitcenter.ai"

# A referrer host is bucketed by its DOMAIN LABELS (``www.google.co.kr`` →
# {"www","google","co","kr"}), never by substring: ``t.co`` is a substring of
# ``checkout.stripe.com``-shaped hosts and ``x.com`` of ``netflix.com``.
# Android app referrers arrive as ``android-app://com.reddit.frontpage`` and
# carry the brand as a label too. First match wins.
_SOURCE_LABELS: tuple[tuple[frozenset[str], str], ...] = (
    (frozenset({"google", "googleapis"}), "Google"),
    (frozenset({"bing"}), "Bing"),
    (frozenset({"duckduckgo"}), "DuckDuckGo"),
    (frozenset({"yahoo"}), "Yahoo"),
    (frozenset({"ecosia"}), "Ecosia"),
    (frozenset({"reddit", "redd"}), "Reddit"),
    (frozenset({"linkedin", "lnkd"}), "LinkedIn"),
    (frozenset({"facebook", "fb", "messenger"}), "Facebook"),
    (frozenset({"instagram"}), "Instagram"),
    (frozenset({"twitter"}), "X"),
    (frozenset({"youtube", "youtu"}), "YouTube"),
    (frozenset({"chatgpt", "openai"}), "ChatGPT"),
    (frozenset({"perplexity"}), "Perplexity"),
    (frozenset({"github"}), "GitHub"),
    (frozenset({"bsky"}), "Bluesky"),
    (frozenset({"stripe"}), "Stripe checkout"),
)
# Hosts that are a brand in their entirety.
_SOURCE_HOSTS: dict[str, str] = {
    "t.co": "X",
    "x.com": "X",
    "lnkd.in": "LinkedIn",
    "fb.me": "Facebook",
}

# Nodes smaller than this fold into their column's "Other" so the column
# stays legible: the larger of an absolute floor and a share of the total,
# because a twelve-month window makes a two-session source a hairline whose
# label collides with its neighbours. Direct and "Left the site" never fold
# — they are the honest bulk and the honest end.
SOURCE_MIN_SESSIONS = 5
MIN_NODE_SHARE = 0.01


def node_floor(total: int) -> int:
    """Floor for a SOURCE node: an absolute five sessions or 1%."""
    return max(SOURCE_MIN_SESSIONS, int(total * MIN_NODE_SHARE))


def page_floor(total: int) -> int:
    """Floor for a PAGE-TYPE node: share only. A week with thirty sessions
    should still show that one of them started on the BOM tool; only a big
    window folds the sub-1% tail."""
    return max(1, int(total * MIN_NODE_SHARE))


def referrer_host(referrer: str | None) -> str:
    """The lower-cased host of a referrer, '' when there is none."""
    if not referrer:
        return ""
    raw = referrer.strip()
    if not raw:
        return ""
    parsed = urlparse(raw if "://" in raw else "//" + raw)
    host = parsed.netloc.lower().rsplit("@", 1)[-1].split(":", 1)[0]
    return host[4:] if host.startswith("www.") else host


def source_of(referrer: str | None) -> str:
    host = referrer_host(referrer)
    if not host or host == OWN_HOST or host.endswith("." + OWN_HOST):
        return DIRECT
    if host in _SOURCE_HOSTS:
        return _SOURCE_HOSTS[host]
    labels = set(host.split("."))
    for tokens, label in _SOURCE_LABELS:
        if labels & tokens:
            return label
    return OTHER_SITES


_PAGE_TYPES: tuple[tuple[str, str], ...] = (
    ("/category", "Category page"),
    ("/part", "Part page"),
    ("/search", "Search"),
    ("/bom", "BOM tool"),
    ("/join", "Join"),
    ("/pricing", "Join"),
    ("/keyword", "Keyword page"),
    ("/contact", "Contact"),
    ("/about", "About"),
)
HOME = "Home"
OTHER_PAGES = "Other pages"


def page_type(path: str | None) -> str:
    p = (path or "/").split("?", 1)[0].split("#", 1)[0].rstrip("/")
    if p in ("", "/index.html"):
        return HOME
    for prefix, label in _PAGE_TYPES:
        if p == prefix or p.startswith(prefix + "/"):
            return label
    return OTHER_PAGES


def part_token(path: str | None) -> str | None:
    """The slug-or-uuid segment of a ``/part/<token>`` path, else None."""
    if not path:
        return None
    p = path.split("?", 1)[0].split("#", 1)[0]
    if not p.startswith("/part/"):
        return None
    token = p[len("/part/") :].split("/", 1)[0].strip()
    return token or None


# ── payload assembly ─────────────────────────────────────────────────────────


def _node(column: int, label: str, hint: str | None = None) -> dict:
    node = {"id": f"{column}:{label}", "label": label, "column": column}
    if hint:
        node["hint"] = hint
    return node


def _assemble(columns: list[str], links: Counter, hints: dict[str, str] | None = None) -> dict:
    """Nodes in top-to-bottom order (largest first per column) + links.

    ECharts lays a Sankey's nodes out in DATA order when ``layoutIterations``
    is 0, so the order here is the order on screen.
    """
    hints = hints or {}
    weight: dict[str, int] = defaultdict(int)
    column_of: dict[str, int] = {}
    for (src, dst), value in links.items():
        weight[src] += value
        weight[dst] += value
        column_of[src] = int(src.split(":", 1)[0])
        column_of[dst] = int(dst.split(":", 1)[0])
    ordered = sorted(
        column_of,
        key=lambda nid: (
            column_of[nid],
            nid.endswith(":" + OTHER_PARTS) or nid.endswith(":" + OTHER_SUBCATEGORIES),
            -weight[nid],
            nid,
        ),
    )
    nodes = [_node(column_of[nid], nid.split(":", 1)[1], hints.get(nid)) for nid in ordered]
    link_rows = [
        {"source": src, "target": dst, "value": value}
        for (src, dst), value in sorted(links.items(), key=lambda kv: -kv[1])
        if value > 0
    ]
    return {"columns": columns, "nodes": nodes, "links": link_rows}


# ── traffic ──────────────────────────────────────────────────────────────────


def traffic_flow(rows: Iterable[tuple[str, int, str | None, str | None]]) -> dict:
    """``rows`` = (session_id, rank_within_session, path, referrer) for the
    first TWO views of every session in the window, in any order."""
    first: dict[str, tuple[str, str]] = {}
    second: dict[str, str] = {}
    for session_id, rank, path, referrer in rows:
        if rank == 1:
            first[session_id] = (source_of(referrer), page_type(path))
        elif rank == 2:
            second[session_id] = page_type(path)

    src_floor = node_floor(len(first))
    pg_floor = page_floor(len(first))
    per_source: Counter = Counter(src for src, _ in first.values())
    per_landing: Counter = Counter(landing for _, landing in first.values())
    per_next: Counter = Counter(second.get(sid, LEFT) for sid in first)
    keep_source = {s for s, n in per_source.items() if s == DIRECT or n >= src_floor}
    keep_landing = {p for p, n in per_landing.items() if n >= pg_floor}
    keep_next = {p for p, n in per_next.items() if p == LEFT or n >= pg_floor}

    links: Counter = Counter()
    for session_id, (src, landing) in first.items():
        source = src if src in keep_source else OTHER_SITES
        landed = landing if landing in keep_landing else OTHER_PAGES
        nxt = second.get(session_id, LEFT)
        nxt = nxt if nxt in keep_next else OTHER_PAGES
        links[(f"0:{source}", f"1:{landed}")] += 1
        links[(f"1:{landed}", f"2:{nxt}")] += 1

    payload = _assemble(["Source", "Landing page", "Next step"], links)
    payload.update(kind="traffic", unit="sessions", total=len(first))
    return payload


# ── parts ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PartRef:
    part_id: str
    sku: str
    manufacturer: str
    category: str
    subcategory: str


def parts_flow(
    token_views: dict[str, int],
    parts_by_token: dict[str, PartRef],
    clicks: Iterable[tuple[str, str, int]],
    limit: int = 12,
    subcategory_limit: int = 12,
) -> dict:
    """``token_views`` = views per ``/part/<token>``; ``parts_by_token`` maps
    the tokens that resolve to a catalog part (the rest are DROPPED);
    ``clicks`` = (part_id, distributor_name, count) in the window.

    Both middle and right columns are capped, largest-first, with the tail
    pooled into ONE node each: production has ~60 subcategories with views
    in a month, and a Sankey column of sixty 6px nodes is a barcode, not a
    chart. The category column is the catalog's 15 roots and needs no cap.
    """
    views_by_part: dict[str, int] = defaultdict(int)
    ref_by_part: dict[str, PartRef] = {}
    for token, n in token_views.items():
        ref = parts_by_token.get(token)
        if ref is None:
            continue
        views_by_part[ref.part_id] += n
        ref_by_part[ref.part_id] = ref

    ranked = sorted(views_by_part.items(), key=lambda kv: (-kv[1], ref_by_part[kv[0]].sku))
    top = {pid for pid, _ in ranked[:limit]}

    views_by_sub: Counter = Counter()
    for pid, n in views_by_part.items():
        views_by_sub[ref_by_part[pid].subcategory] += n
    kept_subs = {sub for sub, _ in views_by_sub.most_common(subcategory_limit)}

    links: Counter = Counter()
    hints: dict[str, str] = {}
    for pid, n in views_by_part.items():
        ref = ref_by_part[pid]
        sub_label = ref.subcategory if ref.subcategory in kept_subs else OTHER_SUBCATEGORIES
        links[(f"0:{ref.category}", f"1:{sub_label}")] += n
        part_label = ref.sku if pid in top else OTHER_PARTS
        links[(f"1:{sub_label}", f"2:{part_label}")] += n
        if pid in top:
            hints[f"2:{ref.sku}"] = ref.manufacturer

    total_views = sum(views_by_part.values())
    payload = _assemble(["Category", "Subcategory", "Part"], links, hints)
    payload.update(kind="parts", unit="views", total=total_views)

    # Distributor column: clicks out of the part nodes above. Kept separate so
    # the client decides whether the count is large enough to draw.
    dist: Counter = Counter()
    clicks_total = 0
    for pid, distributor, n in clicks:
        if pid not in ref_by_part or n <= 0:
            continue
        clicks_total += n
        source = ref_by_part[pid].sku if pid in top else OTHER_PARTS
        dist[(f"2:{source}", f"3:{distributor}")] += n
    payload["clicks_total"] = clicks_total
    payload["distributor_links"] = [
        {"source": src, "target": dst, "value": value}
        for (src, dst), value in sorted(dist.items(), key=lambda kv: -kv[1])
    ]
    payload["distributor_nodes"] = [
        _node(3, label)
        for label in sorted(
            {dst.split(":", 1)[1] for (_, dst) in dist},
            key=lambda d: -sum(v for (s, t), v in dist.items() if t == f"3:{d}"),
        )
    ]
    return payload
