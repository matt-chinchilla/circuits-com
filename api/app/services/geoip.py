"""IP → ISO-3166 alpha-2 country lookup for page-view tracking.

Reads the committed DB-IP Lite country database (app/data/
dbip-country-lite.mmdb — CC-BY 4.0, https://db-ip.com; the admin analytics
page carries the required attribution link). The reader opens lazily once
per process.

FAIL-OPEN IS THE CONTRACT: /api/track must never fail or slow down because
of geo. A missing database file, an unparseable IP, or any reader error
returns None — the page view is stored with country NULL ("unknown").
Historical rows predate this column and stay NULL forever (ip_hash is
one-way).
"""

from pathlib import Path

import maxminddb

DB_PATH = Path(__file__).resolve().parents[1] / "data" / "dbip-country-lite.mmdb"

_reader: "maxminddb.Reader | None" = None
_open_failed = False


def _get_reader() -> "maxminddb.Reader | None":
    global _reader, _open_failed
    if _reader is None and not _open_failed:
        try:
            _reader = maxminddb.open_database(str(DB_PATH))
        except Exception:
            # Missing/corrupt file: remember and never retry per-request.
            _open_failed = True
    return _reader


def country_for_ip(ip: str | None) -> str | None:
    if not ip:
        return None
    reader = _get_reader()
    if reader is None:
        return None
    try:
        record = reader.get(ip)
    except Exception:
        # Bad input (not an IP, IPv6 scope ids, …) — this view is unknown,
        # but the reader stays healthy for the next one.
        return None
    if not isinstance(record, dict):
        return None
    iso = (record.get("country") or {}).get("iso_code")
    if isinstance(iso, str) and len(iso) == 2:
        return iso.upper()
    return None


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
