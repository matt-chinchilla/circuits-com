#!/usr/bin/env python
"""Regenerate ``app/services/part_feed/digikey_manufacturers.json``.

WHAT THE MAP IS FOR. The overlap sweep asks DigiKey a question about ONE
manufacturer at a time — ``Keywords="SN74LV"`` narrowed by
``ManufacturerFilter:[{"Id":"296"}]`` — because a query whose ``ProductsCount``
exceeds 300 can never be paged out (measured: ``Offset + Limit <= 300``, HTTP
400 otherwise). The filter needs DigiKey's OWN manufacturer id, and nothing in
our schema knows it. This file is that translation: our ``canonical_key`` ->
the DigiKey manufacturer ids that canonicalise to the same company.

WHY IT IS GENERATED AND COMMITTED, not fetched at run time.

* The Docker build stage has no network and no database, and the api container
  must not spend a rate-limited call on start-up to learn a table that changes
  a few times a year. Same reasoning as ``frontend/seo-manifest.json``.
* A hand-typed map is a wrong price waiting to happen. If ``296`` is typed as
  ``269`` the sweep does not fail — it quietly narrows to the wrong company and
  writes that company's prices onto our parts. Nothing announces it. The only
  safe map is one nothing types.

HOW THE MATCH IS MADE. Both sides go through the repo's real
:func:`app.services.manufacturer_canon.canon`, then through a DIACRITIC FOLD on
top of it. ``canon`` NFKC-normalises but does not decompose accents, so
``Würth Elektronik`` and ``Wurth Elektronik`` canonicalise differently and would
never meet. Measured on the live catalog, 2026-08-24::

    exact canon only : 452 keys with >=1 part / 124,548 parts / 92,169 Mouser-priced
    + diacritic fold : 454 keys with >=1 part / 126,395 parts / 93,459 Mouser-priced

1,847 more parts for the same call budget, and the makers it recovers are real
(Würth, Schaffner). The exact-canon numbers are recorded because they reproduce
the design's figures to the digit, which is the evidence this matcher is right.

WHY THE VALUE IS A LIST. 59 distinct fold-keys in DigiKey's OWN 3,718-name list
collide with each other — ``abracon`` is ids 535 and 6290, ``advantech`` is
2963/1588/2084. Storing one id would silently pick a coin-flip half of a
manufacturer's catalog. The sweep issues one scope per id.

DIFF, NEVER OVERWRITE. A regeneration prints what it would ADD, CHANGE and
REMOVE and refuses to write unless ``--write`` is passed. A removal in
particular is worth a human look: DigiKey retiring an id we currently sweep is
a real event, and a silent rewrite would erase the evidence.

HUMAN PINS. ``EXTRA`` in ``digikey.py`` (not this file) holds hand-approved
aliases the canon rules legitimately refuse to merge — ``Analog Devices /
Maxim Integrated`` is our largest unmatched maker at 2,975 parts, and the canon
key is deliberately not ``analog devices`` because ``Microchip USA`` is not
``Microchip Technology``. Pins live in code, beside the reasoning; this file
holds only what the generator derived. Pins WIN on conflict.

Usage::

    # live (one API call, needs DIGIKEY_CLIENT_ID / DIGIKEY_CLIENT_SECRET)
    python scripts/gen_digikey_manufacturers.py --database-url postgresql://...
    python scripts/gen_digikey_manufacturers.py --write

    # offline, from a previously saved GET /products/v4/search/manufacturers body
    python scripts/gen_digikey_manufacturers.py --from-file dk.json --write
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import unicodedata
from collections import defaultdict

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.services.manufacturer_canon import canon  # noqa: E402

OUT_PATH = (
    pathlib.Path(__file__).resolve().parents[1]
    / "app"
    / "services"
    / "part_feed"
    / "digikey_manufacturers.json"
)


def fold(name: str) -> str:
    """`canon()` plus a diacritic fold — the ONE matcher, used on both sides.

    Mirrored by ``digikey._fold_key`` so a lookup at run time asks the same
    question this generator answered. If you change one, change both; the test
    ``TestTheManufacturerMap`` pins that they agree.
    """
    key = canon(name or "")
    return "".join(c for c in unicodedata.normalize("NFD", key) if not unicodedata.combining(c))


def fetch_live() -> list[dict]:
    """GET /products/v4/search/manufacturers — ONE call, no paging."""
    import httpx

    client_id = os.environ.get("DIGIKEY_CLIENT_ID", "").strip()
    client_secret = os.environ.get("DIGIKEY_CLIENT_SECRET", "").strip()
    if not (client_id and client_secret):
        raise SystemExit(
            "DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET must both be set "
            "(or pass --from-file to work offline)"
        )
    with httpx.Client(timeout=60) as client:
        token = client.post(
            "https://api.digikey.com/v1/oauth2/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "client_credentials",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if token.status_code != 200:
            # NEVER echo the body — it can carry the client id.
            raise SystemExit(f"DigiKey token request failed with HTTP {token.status_code}")
        response = client.get(
            "https://api.digikey.com/products/v4/search/manufacturers",
            headers={
                "Authorization": f"Bearer {token.json()['access_token']}",
                "X-DIGIKEY-Client-Id": client_id,
                "X-DIGIKEY-Locale-Site": "US",
                "X-DIGIKEY-Locale-Language": "en",
                "X-DIGIKEY-Locale-Currency": "USD",
            },
        )
        if response.status_code != 200:
            raise SystemExit(f"DigiKey manufacturers returned HTTP {response.status_code}")
        print(f"  quota remaining after the call: {response.headers.get('x-ratelimit-remaining')}")
        return response.json().get("Manufacturers") or []


def our_manufacturers(database_url: str) -> dict[str, int]:
    """canonical_key -> how many parts we hold for it.

    Keys with ZERO parts are dropped: they are the Leads CRM's outreach roster,
    not catalog makers, and 2,519 rows shrink to the 454 the sweep can use.
    """
    from sqlalchemy import create_engine, text

    engine = create_engine(database_url)
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT mf.canonical_key, count(p.id) "
                "FROM manufacturers mf LEFT JOIN parts p ON p.manufacturer_id = mf.id "
                "GROUP BY 1"
            )
        ).all()
    return {row[0]: int(row[1]) for row in rows if row[1]}


def build(digikey_rows: list[dict], ours: dict[str, int]) -> dict[str, list[int]]:
    by_fold: dict[str, list[int]] = defaultdict(list)
    for row in digikey_rows:
        try:
            by_fold[fold(row.get("Name") or "")].append(int(row["Id"]))
        except (KeyError, TypeError, ValueError):
            continue
    by_fold.pop("", None)
    return {key: sorted(set(by_fold[fold(key)])) for key in sorted(ours) if fold(key) in by_fold}


def report(old: dict[str, list[int]], new: dict[str, list[int]], ours: dict[str, int]) -> None:
    added = sorted(set(new) - set(old))
    removed = sorted(set(old) - set(new))
    changed = sorted(k for k in set(old) & set(new) if old[k] != new[k])
    print(f"  matched {len(new)} makers, covering {sum(ours[k] for k in new):,} of our parts")
    print(f"  + added   {len(added)}: {added[:8]}{' …' if len(added) > 8 else ''}")
    print(f"  ~ changed {len(changed)}: {changed[:8]}{' …' if len(changed) > 8 else ''}")
    print(f"  - REMOVED {len(removed)}: {removed[:8]}{' …' if len(removed) > 8 else ''}")
    if removed:
        print(
            "    a removal means DigiKey no longer lists a maker we sweep — read it "
            "before writing, it is not routine churn"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--from-file", help="a saved manufacturers response, instead of a call")
    parser.add_argument(
        "--database-url",
        default=os.environ.get(
            "DATABASE_URL", "postgresql://circuits:circuits@localhost:5432/circuits"
        ),
    )
    parser.add_argument("--write", action="store_true", help="actually rewrite the JSON")
    args = parser.parse_args(argv)

    if args.from_file:
        raw = json.loads(pathlib.Path(args.from_file).read_text())
        rows = raw.get("Manufacturers") if isinstance(raw, dict) else raw
    else:
        rows = fetch_live()
    print(f"DigiKey manufacturers: {len(rows)}")

    ours = our_manufacturers(args.database_url)
    print(f"our manufacturers with >=1 part: {len(ours)}")

    new = build(rows, ours)
    old = json.loads(OUT_PATH.read_text()) if OUT_PATH.exists() else {}
    report(old, new, ours)

    if not args.write:
        print("\n(dry run — pass --write to update the file)")
        return 0
    # ONE LINE PER KEY, deliberately. `json.dumps(indent=…)` breaks every
    # id list across three lines and turns a 454-row table into 1,400 lines of
    # diff noise, which is how a real change (an id that MOVED) hides. This
    # shape makes a regeneration's diff readable at a glance.
    body = ",\n".join(f"  {json.dumps(k)}: {json.dumps(v)}" for k, v in sorted(new.items()))
    OUT_PATH.write_text("{\n" + body + "\n}\n")
    print(f"\nwrote {OUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
