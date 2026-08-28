"""Straight-line miles from HQ for the Leads roster (the Location column).

Geocoding is a COMMITTED dataset, not a service call: `app/data/
zcta_centroids.csv` is the 2023 Census Gazetteer ZCTA file (public domain)
trimmed to `zip,lat,lon` — 33,791 ZIP-code centroids, ~890KB, the same
ship-the-data pattern as the DB-IP GeoIP mmdb beside it. A lead's distance is
HQ→ZIP-centroid great-circle miles, which is why sub-mile precision would be
false precision: two leads in HQ's own ZIP both measure the centroid, not
their doorsteps. One decimal is stored; the UI rounds to whole miles at ≥10.
"""

from __future__ import annotations

import csv
import math
from functools import lru_cache
from pathlib import Path

# 79 Creighton Avenue, Lake Ronkonkoma, NY 11779 — the company's own address,
# geocoded once (OSM exact building match, 2026-08-28). Distances are STORED on
# rows at seed time, so moving HQ means updating this pair AND nulling
# `leads.distance_miles` so the next seed backfill recomputes.
HQ_LAT = 40.8216522
HQ_LON = -73.0965465

_EARTH_RADIUS_MILES = 3958.7613
_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "zcta_centroids.csv"


@lru_cache(maxsize=1)
def _centroids() -> dict[str, tuple[float, float]]:
    with open(_DATA_PATH, newline="", encoding="utf-8") as f:
        return {row[0]: (float(row[1]), float(row[2])) for row in csv.reader(f) if row}


def normalize_zip(postal_code: str | None) -> str | None:
    """`'11779-1234'` → `'11779'`; `'7001'` (spreadsheet-stripped leading
    zero) → `'07001'`. Fewer than 3 digits is not recoverable — None."""
    if not postal_code:
        return None
    digits = "".join(ch for ch in postal_code.strip().split("-")[0] if ch.isdigit())
    if len(digits) >= 5:
        return digits[:5]
    if len(digits) >= 3:
        return digits.zfill(5)
    return None


def haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    rlat1, rlon1, rlat2, rlon2 = map(math.radians, (lat1, lon1, lat2, lon2))
    a = (
        math.sin((rlat2 - rlat1) / 2) ** 2
        + math.cos(rlat1) * math.cos(rlat2) * math.sin((rlon2 - rlon1) / 2) ** 2
    )
    return _EARTH_RADIUS_MILES * 2 * math.asin(math.sqrt(a))


def distance_from_hq_miles(postal_code: str | None) -> float | None:
    """One decimal, or None when the ZIP is absent/unknown — absence renders
    as an em-dash, never as 0 miles (0 would sort a data gap to the top of
    'Nearest first')."""
    zip5 = normalize_zip(postal_code)
    if zip5 is None:
        return None
    centroid = _centroids().get(zip5)
    if centroid is None:
        return None
    return round(haversine_miles(HQ_LAT, HQ_LON, centroid[0], centroid[1]), 1)
