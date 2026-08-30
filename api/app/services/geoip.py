"""IP → place and network lookup for page-view tracking.

Reads DB-IP Lite databases (CC-BY 4.0, https://db-ip.com; the admin analytics
page carries the required attribution link). TWO INDEPENDENT readers, because
they answer different questions and either can be absent on its own:

PLACE (country, region, city, point) — first of:
  * ``data/dbip-city-lite.mmdb`` — city-level, ~124MB, NOT committed. The
    Docker image downloads it at build time and .gitignore/.dockerignore keep
    it out of the repo and the build context. Yields every place field.
  * ``data/dbip-country-lite.mmdb`` — country-only, ~8MB, COMMITTED. The
    fallback, so a checkout without the big file still geolocates.

NETWORK (the AS organization behind the address):
  * ``data/dbip-asn-lite.mmdb`` — ~9MB, NOT committed, downloaded in the same
    build layer. It has NO fallback: absent means every view stores network
    NULL, which is exactly what the pre-049 history looks like anyway.

The two are deliberately not one lookup. A city database with no ASN file
beside it must still resolve cities, and an ASN file with no city database
must still name networks — so each reader carries its OWN open-failure memo
and neither can disable the other.

Preference is by FILE EXISTENCE, deliberately, rather than a setting: the
compose `environment:` block is an allowlist that has silently dropped four
config values already, and a path test cannot be forgotten there.

FAIL-OPEN IS THE CONTRACT: /api/track must never fail or slow down because of
geo. A missing database file, an unparseable IP, a reader error, or a record
shaped in some way this parser did not expect returns an EMPTY result — the
page view is stored with those columns NULL ("unknown"). Historical rows
predate the columns and stay NULL forever (ip_hash is one-way).
"""

import math
import re
from dataclasses import dataclass, replace
from pathlib import Path

import maxminddb

_DATA_DIR = Path(__file__).resolve().parents[1] / "data"
CITY_DB_PATH = _DATA_DIR / "dbip-city-lite.mmdb"
COUNTRY_DB_PATH = _DATA_DIR / "dbip-country-lite.mmdb"
ASN_DB_PATH = _DATA_DIR / "dbip-asn-lite.mmdb"

# Region and city names are stored in String(80) columns. The longest real
# place names run well under this; the cap is what stops a surprising record
# from raising on insert.
_NAME_MAX = 80

# AS organization names are stored in String(120). Real ones run long —
# "Comcast Cable Communications, LLC" is 33 — but registry strings are free
# text and a few are much longer, so the column width is enforced here.
_NETWORK_MAX = 120

# Two decimals ≈ 1.1km. The free tier's coordinates are city CENTROIDS, so
# every extra digit would be precision the data does not have — and storing a
# visitor's position more precisely than it is known is the wrong default.
_COORD_DP = 2


@dataclass(frozen=True)
class GeoResult:
    """Everything the readers could resolve. Every field independently
    optional: the country DB fills only `country`, the city DB routinely knows
    a country and a point for an IP whose city it cannot name, and `network`
    comes from a separate database that may not be there at all."""

    country: str | None = None
    region: str | None = None
    city: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    network: str | None = None


EMPTY_GEO = GeoResult()

_reader: "maxminddb.Reader | None" = None
_open_failed = False
_asn_reader: "maxminddb.Reader | None" = None
_asn_open_failed = False


def _open_first(paths) -> "maxminddb.Reader | None":
    """The first of `paths` that exists AND opens. Present-but-corrupt is not
    the same as absent, so an open error falls through to the next candidate
    rather than ending the search."""
    for path in paths:
        try:
            if not path.exists():
                continue
            return maxminddb.open_database(str(path))
        except Exception:
            continue
    return None


def _get_reader() -> "maxminddb.Reader | None":
    global _reader, _open_failed
    if _reader is None and not _open_failed:
        _reader = _open_first((CITY_DB_PATH, COUNTRY_DB_PATH))
        if _reader is None:
            # Missing/corrupt files: remember and never retry per-request.
            _open_failed = True
    return _reader


def _get_asn_reader() -> "maxminddb.Reader | None":
    """Its OWN memo — a missing ASN file must not mark the place reader dead
    (or vice versa), which one shared flag would do."""
    global _asn_reader, _asn_open_failed
    if _asn_reader is None and not _asn_open_failed:
        _asn_reader = _open_first((ASN_DB_PATH,))
        if _asn_reader is None:
            _asn_open_failed = True
    return _asn_reader


def _name(value: object) -> str | None:
    """A `names` mapping's English label, truncated to the column width."""
    if not isinstance(value, dict):
        return None
    label = value.get("en")
    if not isinstance(label, str):
        return None
    label = label.strip()[:_NAME_MAX]
    return label or None


# DB-IP qualifies sub-city records as "City (District)" — "New York (Midtown)",
# "Philadelphia (South Philadelphia East)". Measured over 20,000 random IPv4
# lookups (2026-08-30): 16.6% of US hits carry the suffix.
_DISTRICT_SUFFIX = re.compile(r"\s*\([^()]*\)\s*$")


def _city_name(value: object) -> str | None:
    """The city label with DB-IP's district qualifier removed.

    The district is real information at the wrong grain: stored as-is, one
    metro fragments into several map bubbles that each claim a slice of the
    same city's traffic. The suffix is stripped BEFORE the width truncation —
    a long label cut mid-parenthesis would no longer match the pattern."""
    if not isinstance(value, dict):
        return None
    label = value.get("en")
    if not isinstance(label, str):
        return None
    label = _DISTRICT_SUFFIX.sub("", label).strip()[:_NAME_MAX]
    return label or None


def _coord(value: object, limit: float) -> float | None:
    # `isinstance(True, int)` is True, hence the explicit bool rejection.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or abs(number) > limit:
        return None
    return round(number, _COORD_DP)


def _region(record: dict) -> str | None:
    """The first subdivision's NAME — "New York", not "NY".

    DB-IP Lite ships no `iso_code` on subdivisions (verified against the real
    2026-08 city database), so the name is the only identifier there is, and
    the analytics payload calls this field a name for that reason.
    """
    subdivisions = record.get("subdivisions")
    if not isinstance(subdivisions, list) or not subdivisions:
        return None
    first = subdivisions[0]
    return _name(first.get("names")) if isinstance(first, dict) else None


def _place_for_ip(ip: str) -> GeoResult:
    """Country/region/city/point from the place reader. Never raises."""
    reader = _get_reader()
    if reader is None:
        return EMPTY_GEO
    try:
        record = reader.get(ip)
    except Exception:
        # Bad input (not an IP, IPv6 scope ids, …) — this view is unknown,
        # but the reader stays healthy for the next one.
        return EMPTY_GEO
    if not isinstance(record, dict):
        return EMPTY_GEO

    country = record.get("country")
    iso = country.get("iso_code") if isinstance(country, dict) else None
    if not (isinstance(iso, str) and len(iso) == 2):
        iso = None

    city = record.get("city")
    location = record.get("location")
    if isinstance(location, dict):
        latitude = _coord(location.get("latitude"), 90.0)
        longitude = _coord(location.get("longitude"), 180.0)
    else:
        latitude = longitude = None
    # A coordinate is a PAIR. Half of one cannot be put on a map, and storing
    # it would make `latitude IS NOT NULL` a lie about what is plottable.
    if latitude is None or longitude is None:
        latitude = longitude = None

    return GeoResult(
        country=iso.upper() if iso else None,
        region=_region(record),
        city=_city_name(city.get("names")) if isinstance(city, dict) else None,
        latitude=latitude,
        longitude=longitude,
    )


def _network_for_ip(ip: str) -> str | None:
    """The AS organization behind the address — "Comcast Cable
    Communications, LLC", not an AS number.

    The record is GeoLite2-ASN shaped and FLAT (verified against the real
    2026-08 file, whose metadata literally says `compat=GeoLite2-ASN`):
    `autonomous_system_organization` and `autonomous_system_number` sit at the
    top level, with no nested `names` mapping to dig through. A private or
    unrouted address simply has no record and returns None.

    The AS number is deliberately NOT stored. The panel shows a name to a
    human, the number would need the name to be legible anyway, and a column
    nothing reads is a column that rots.
    """
    reader = _get_asn_reader()
    if reader is None:
        return None
    try:
        record = reader.get(ip)
    except Exception:
        return None
    if not isinstance(record, dict):
        return None
    org = record.get("autonomous_system_organization")
    if not isinstance(org, str):
        return None
    org = org.strip()[:_NETWORK_MAX]
    return org or None


def geo_for_ip(ip: str | None) -> GeoResult:
    """Place AND network for one address. Never raises.

    Two reads rather than one because they come from two databases, and each
    half stands alone: a view can carry a city with no network (no ASN file)
    or a network with no city (country-lite fallback only).
    """
    if not ip:
        return EMPTY_GEO
    place = _place_for_ip(ip)
    network = _network_for_ip(ip)
    if network is None:
        return place
    return replace(place, network=network)


def country_for_ip(ip: str | None) -> str | None:
    """ISO-3166 alpha-2 only. Kept for the signup path, which stores nothing else."""
    return geo_for_ip(ip).country


def reset_geoip() -> None:
    """Test seam: drop every cached reader and open-failure memo. BOTH
    readers, or a test that hid one database would leak it into the next."""
    global _reader, _open_failed, _asn_reader, _asn_open_failed
    for reader in (_reader, _asn_reader):
        if reader is not None:
            try:
                reader.close()
            except Exception:
                pass
    _reader = None
    _open_failed = False
    _asn_reader = None
    _asn_open_failed = False
