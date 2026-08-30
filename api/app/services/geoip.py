"""IP → place lookup for page-view tracking (country, region, city, point).

Reads a DB-IP Lite database (CC-BY 4.0, https://db-ip.com; the admin analytics
page carries the required attribution link). TWO databases can back this, and
which one is present decides how much detail a lookup can yield:

  * ``data/dbip-city-lite.mmdb`` — city-level, ~124MB, NOT committed. The
    Docker image downloads it at build time and .gitignore/.dockerignore keep
    it out of the repo and the build context. Yields every field.
  * ``data/dbip-country-lite.mmdb`` — country-only, ~8MB, COMMITTED. The
    fallback, so a checkout without the big file still geolocates.

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
from dataclasses import dataclass
from pathlib import Path

import maxminddb

_DATA_DIR = Path(__file__).resolve().parents[1] / "data"
CITY_DB_PATH = _DATA_DIR / "dbip-city-lite.mmdb"
COUNTRY_DB_PATH = _DATA_DIR / "dbip-country-lite.mmdb"

# Region and city names are stored in String(80) columns. The longest real
# place names run well under this; the cap is what stops a surprising record
# from raising on insert.
_NAME_MAX = 80

# Two decimals ≈ 1.1km. The free tier's coordinates are city CENTROIDS, so
# every extra digit would be precision the data does not have — and storing a
# visitor's position more precisely than it is known is the wrong default.
_COORD_DP = 2


@dataclass(frozen=True)
class GeoResult:
    """Everything one lookup could resolve. Every field independently optional:
    the country DB fills only `country`, and the city DB routinely knows a
    country and a point for an IP whose city it cannot name."""

    country: str | None = None
    region: str | None = None
    city: str | None = None
    latitude: float | None = None
    longitude: float | None = None


EMPTY_GEO = GeoResult()

_reader: "maxminddb.Reader | None" = None
_open_failed = False


def _get_reader() -> "maxminddb.Reader | None":
    global _reader, _open_failed
    if _reader is None and not _open_failed:
        for path in (CITY_DB_PATH, COUNTRY_DB_PATH):
            try:
                if not path.exists():
                    continue
                _reader = maxminddb.open_database(str(path))
                break
            except Exception:
                continue
        if _reader is None:
            # Missing/corrupt files: remember and never retry per-request.
            _open_failed = True
    return _reader


def _name(value: object) -> str | None:
    """A `names` mapping's English label, truncated to the column width."""
    if not isinstance(value, dict):
        return None
    label = value.get("en")
    if not isinstance(label, str):
        return None
    label = label.strip()[:_NAME_MAX]
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


def geo_for_ip(ip: str | None) -> GeoResult:
    """One mmdb lookup, everything it knows. Never raises."""
    if not ip:
        return EMPTY_GEO
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
        city=_name(city.get("names")) if isinstance(city, dict) else None,
        latitude=latitude,
        longitude=longitude,
    )


def country_for_ip(ip: str | None) -> str | None:
    """ISO-3166 alpha-2 only. Kept for the signup path, which stores nothing else."""
    return geo_for_ip(ip).country


def reset_geoip() -> None:
    """Test seam: drop the cached reader/open-failure state."""
    global _reader, _open_failed
    if _reader is not None:
        try:
            _reader.close()
        except Exception:
            pass
    _reader = None
    _open_failed = False
