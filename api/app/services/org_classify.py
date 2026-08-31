"""What kind of thing is the organization behind a page view?

`page_views.network` holds the AS organization name DB-IP resolves for the
visitor's address — "Cirrus Logic Inc.", "Comcast Cable Communications, LLC",
"Sachem Central School District". The owner's question is "which COMPANIES are
visiting the site", and the answer is buried: on the 177 distinct networks
production has resolved so far, four names carry ~90% of the traffic and every
one of them is a carrier or a cloud.

So this module is a sorter, not an identifier. It splits those names into:

* ``corporate`` — a named organization on its own address space. THE bucket:
  a manufacturer, a school district, a university, a hospital, a rocket
  company. The panel defaults to it.
* ``isp``       — a consumer or business access carrier. The visitor is a
  person at home or in a small office; the name says nothing about who they
  work for.
* ``hosting``   — a cloud, CDN, VPS, colo, proxy or platform range. Almost
  never a person: tooling, previews and crawlers.
* ``unknown``   — no name at all (a view from before ASN capture, or a lookup
  that failed).

**Read time, on purpose.** Nothing here is stored — `analytics.py` calls this
while assembling a response. The keyword lists below are therefore editable
in one deploy with no column, no migration and no backfill: a rule that turns
out to hide a prospect can be fixed for ALL of history, including the rows
already written.

The keyword families are drawn from the real distinct `network` values in
production (2026-08-30), not invented; the brand entries name operators that
have actually appeared.
"""

import re
import unicodedata
from typing import Literal

OrgKind = Literal["corporate", "isp", "hosting", "unknown"]


# ── Normalisation ───────────────────────────────────────────────────────────
# Two rules, and both earn their place on real names:
#
#   `&`, `-` and apostrophes are DELETED, so "AT&T" collapses to the single
#   token `att` and "T-Mobile" to `tmobile`. Turning them into spaces instead
#   would leave `at` + `t`, and matching a two-letter fragment inside other
#   names is exactly the false positive this module must not make.
#
#   Everything else non-alphanumeric becomes a SPACE, so "Amazon.com, Inc."
#   yields the token `amazon` rather than `amazoncom`.
#
# Accents are folded first: DB-IP emits the operator's own spelling
# ("TELEFÔNICA BRASIL S.A", "VIA SUL TELECOMUNICAÇOES LTDA ME") and an
# unfolded `ô` would break the word in half.
_DELETED = str.maketrans({"&": "", "-": "", "'": "", "’": ""})
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def normalize_network(name: str | None) -> str:
    """Lower-cased, accent-folded, space-padded token text.

    Padded on both ends so a caller can test for a whole token with a plain
    ``" verizon " in text`` — no regex per keyword, and no matching `att`
    inside `seattle`.
    """
    if not name:
        return ""
    folded = unicodedata.normalize("NFKD", name)
    ascii_only = "".join(ch for ch in folded if not unicodedata.combining(ch))
    lowered = ascii_only.lower().translate(_DELETED)
    collapsed = _NON_ALNUM.sub(" ", lowered).strip()
    return f" {collapsed} " if collapsed else ""


def _mentions(text: str, phrases: tuple[str, ...]) -> bool:
    """True when `text` contains any phrase as WHOLE tokens."""
    return any(f" {phrase} " in text for phrase in phrases)


def _contains(text: str, fragments: tuple[str, ...]) -> bool:
    """True when `text` contains any fragment anywhere, token boundaries
    included. Reserved for stems that inflect across languages and that no
    English word contains — see `_ISP_FRAGMENTS`."""
    return any(fragment in text for fragment in fragments)


# ── (1) Institutions win outright ───────────────────────────────────────────
# Checked BEFORE everything else, and the only rule that can promote a name
# INTO the corporate bucket rather than merely leaving it there.
#
# The reason is asymmetric cost. A wrong `isp`/`hosting` verdict HIDES a row
# from the panel's default view, and the rows most worth seeing are exactly
# the ones whose names collide with carrier and cloud vocabulary: "Orange
# County Public Schools" (carrier brand), "Cloud County Community College"
# (cloud), "Arizona Tri University Network". A wrong `corporate` verdict only
# adds a visible line the owner can dismiss at a glance.
#
# Production has already resolved four of these — Sachem Central School
# District (18 visitors), Arizona Tri University Network, Nova Scotia
# Department of Education, Church of Cyberology.
_INSTITUTION = (
    "school",
    "schools",
    "district",
    "university",
    "universities",
    "universidad",
    "universidade",
    "universite",
    "universiteit",
    "college",
    "academy",
    "institute",
    "institution",
    "hospital",
    "healthcare",
    "medical",
    "clinic",
    "church",
    "diocese",
    "ministry",
    "county",
    "municipality",
    "library",
    "museum",
    "laboratory",
    "laboratories",
    "city of",
    "board of education",
    "department of",
)


# ── (2) Hosting, clouds, CDNs, proxies and platforms ────────────────────────
# Checked BEFORE isp, because transit and datacenter operators carry carrier
# vocabulary in their LEGAL names and the more specific evidence has to win:
# "Level 3 Communications, Inc.", "Zayo Bandwidth" and "IDC, China
# Telecommunications Corporation" are all datacenter/backbone ranges that the
# isp rules below would otherwise claim on the word "communications" alone.
_HOSTING = (
    # What the operator sells.
    "host",
    "hosts",
    "hosted",
    "hosting",
    "datacenter",
    "datacenters",
    "data center",
    "data centre",
    "idc",  # "internet data center" — how CN/APAC operators label colo ranges
    "colo",
    "colocation",
    "vps",
    "cloud",
    "clouds",
    "server",
    "servers",
    "dedicated",
    "cdn",
    "bandwidth",
    "web services",
    "digital ocean",
    # Named operators seen in production or named in the brief.
    "amazon",
    "aws",
    "microsoft",
    "azure",
    "oracle",
    "alibaba",
    "aliyun",
    "tencent",
    "cloudflare",
    "akamai",
    "fastly",
    "digitalocean",
    "linode",
    "ovh",
    "hetzner",
    "vultr",
    "scaleway",
    "railway",
    "leaseweb",
    "contabo",
    "ionos",
    "iomart",
    "zenlayer",
    "gcore",
    "misaka",
    "maxihost",
    "hostroyale",
    "hostpapa",
    "egihosting",
    "logicweb",
    "gthost",
    "vegasnap",
    "advin services",
    "web2objects",
    "datacamp",
    "zayo",
    "level 3",
    "m247",
    "latitude sh",
    "constant company",
    # Google is matched as a PHRASE, never on the bare word: "Google Fiber
    # Inc." is a residential access ISP and belongs in the bucket below.
    "google llc",
    "google cloud",
    # Platform and crawler ranges. Not clouds in the strict sense, but the
    # same thing for this panel's purpose — no prospect is behind them.
    # Microsoft alone is 3,719 of production's visitors (Bing plus Azure).
    "facebook",
    "meta platforms",
    "twitter",
    "yandex",
    "ahrefs",
    "opendns",
    "oxylabs",
    "sprious",
)


# ── (3) Access carriers ─────────────────────────────────────────────────────
# Deliberately NOT here: the bare words "internet", "network(s)", "systems"
# and "technologies". Every one of them appears in a name this panel exists to
# show — "Internet Archive", "Arizona Tri University Network", "Cablevision
# Systems Corp." is caught by its brand instead, and "Space Exploration
# Technologies Corporation" must never leave the corporate bucket.
_ISP = (
    # What the operator sells.
    "communication",
    "communications",
    "cable",
    "cablevision",
    "broadband",
    "wireless",
    "mobile",
    "cellular",
    "fiber",
    "fibre",
    "fibra",
    "fios",
    "dsl",
    "adsl",
    "isp",
    "internet services",
    # Named carriers seen in production or named in the brief.
    "verizon",
    "comcast",
    "xfinity",
    "charter",
    "spectrum",
    "cox",
    "att",
    "tmobile",
    "sprint",
    "optimum",
    "altice",
    "frontier",
    "centurylink",
    "lumen",
    "windstream",
    "rcn",
    "breezeline",
    "bell canada",
    "telus",
    "rogers",
    "videotron",
    "cogeco",
    "shaw",
    "jio",
    "airtel",
    "chinanet",
    "china unicom",
    "vodafone",
    "orange",
    "telia",
    "telenor",
    "tele2",
    "virgin media",
    "hutchison",
    "safaricom",
    "viettel",
    "vnpt",
    "axiata",
    "singnet",
    "bsnl",
    # Non-English words for "communications" that carry the same weight as the
    # English ones above: "TURKCELL ILETISIM HIZMETLERI A.S.", "Bharat Sanchar
    # Nigam Ltd". Both appeared in production.
    "iletisim",
    "sanchar nigam",
)

# Stems that inflect across the languages DB-IP reports in, and that no
# English word contains: "Telecom Italia", "Turk Telekomunikasyon",
# "TELEFÔNICA BRASIL", "Claro NXT Telecomunicacoes", "Comunicaciones". Matched
# as fragments precisely because the token they sit in is never the same twice.
_ISP_FRAGMENTS = (
    "telecom",
    "telekom",
    "telefonica",
    "comunicacion",
    "comunicacoes",
)


def classify_network(name: str | None) -> OrgKind:
    """Sort one AS organization name into a bucket.

    Order is the whole design — see the family comments above:
    empty → institution → hosting → isp → corporate. The fallthrough is
    ``corporate`` on purpose: a name no rule recognises is SHOWN to the owner
    rather than filed away where it will never be looked at.
    """
    text = normalize_network(name)
    if not text:
        return "unknown"
    if _mentions(text, _INSTITUTION):
        return "corporate"
    if _mentions(text, _HOSTING):
        return "hosting"
    if _mentions(text, _ISP) or _contains(text, _ISP_FRAGMENTS):
        return "isp"
    return "corporate"
