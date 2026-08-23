"""Part identity — the one place that decides whether a feed row IS an existing part.

A part is identified by **(canonical manufacturer, case-folded MPN)**. Both
halves were chosen from the live catalog, not from taste:

* **Case-folded, never punctuation-stripped.** Stripping punctuation merges
  parts that genuinely differ, because the decimal point is load-bearing in
  electronics part numbers: ``1.5SMC6.8AHM3`` is a 6.8 V TVS diode and
  ``1.5SMC68AHM3`` is a 68 V one; ``CHD15MF-2.5`` is a 2.5 ft cable and
  ``CHD15MF-25`` is 25 ft; ``ASFLMB-1.8432MHZ`` is not ``ASFLMB-18.432MHZ``.
  Measured against production (175,065 parts): case-folding alone collides on
  6 groups, **all 6 genuine duplicates** (five Nordic nRF parts and one
  SiTime, differing only in capitalisation). Also stripping punctuation
  collides on 97, the large majority of which are distinct products. The
  cheaper-looking normalisation is the wrong one.

* **Manufacturer-qualified.** 49 colliding MPN pairs span different makers and
  are unrelated products — a Desco taper tap versus a Simpson panel meter, a
  Keystone test pin versus AIM solder. Without the manufacturer the key
  rejects those as though they were duplicates.

This also settles a disagreement that predates it: ``bom_match`` has always
matched on ``upper(sku)`` while every write path matched case-sensitively, so
a feed returning different capitalisation created a row the matcher then found
twice. Writers now use the same rule the reader already assumed.

**Why the write is an upsert and not a check-then-insert.** Measured with 8
concurrent writers inserting one MPN against real Postgres: the
SELECT-then-INSERT pattern produced **8 rows and reported zero errors** — the
duplication is silent, and `bom_match` then picks between the copies by
``lifecycle_verified_at DESC``, which means the price a customer sees depends
on which duplicate sorted first. Adding the unique index *without* changing
the write path is worse in a different way: 7 of the 8 writers died with
IntegrityError. Only the upsert gives one row and eight successes, so the
index and this module have to ship together.

The conflict is handled with a real ``INSERT … ON CONFLICT DO NOTHING`` and a
re-read, NOT with ``begin_nested()`` + catch. The savepoint version is the
obvious one and is wrong here: on SQLAlchemy 2.0.52 leaving a ``begin_nested()``
block fires ``after_commit`` on the session, which would commit the caller's
in-flight work and break the importer's per-part commit ordering.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import Manufacturer, ManufacturerAlias, Part
from app.services.manufacturer_canon import canon


def _insert_if_absent(db: Session, model, obj) -> bool:
    """``INSERT … ON CONFLICT DO NOTHING``. True when the row was written.

    Deliberately NOT ``with db.begin_nested(): … except IntegrityError``, which
    is the obvious way to write this and is wrong here: measured on SQLAlchemy
    2.0.52, exiting a ``begin_nested()`` block fires ``after_commit`` on the
    session — with or without an enclosing transaction. That silently commits
    the caller's work, and this importer's per-part commit ordering is a tested
    invariant (`test_each_part_commits_before_its_event`), so a savepoint here
    breaks durability guarantees a long way from this file.

    A conflict-free INSERT raises nothing, so no savepoint is needed at all.
    The conflict target is left bare rather than naming the expression index:
    Postgres and SQLite both accept bare DO NOTHING, and neither has to infer
    an index over ``upper(sku)``. Column defaults still apply — Core honours
    ``Column(default=…)`` — so timestamps fill exactly as on the ORM path.
    """
    table = model.__table__
    values = {
        column.name: getattr(obj, column.name)
        for column in table.columns
        if getattr(obj, column.name, None) is not None
    }
    if db.bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as _insert
    else:
        from sqlalchemy.dialects.sqlite import insert as _insert
    result = db.execute(_insert(table).values(**values).on_conflict_do_nothing())
    return bool(result.rowcount)


def find_part(db: Session, manufacturer_id: uuid.UUID | None, sku: str) -> Part | None:
    """The part this (manufacturer, MPN) names, or None.

    Case-insensitive on sku so it rides ``uq_parts_manufacturer_sku_upper`` and
    agrees with `bom_match`.
    """
    if manufacturer_id is None or not sku:
        return None
    return (
        db.query(Part)
        .filter(Part.manufacturer_id == manufacturer_id, func.upper(Part.sku) == sku.upper())
        .first()
    )


def resolve_manufacturer_id(db: Session, name: str | None) -> uuid.UUID | None:
    """Canonical manufacturer for a feed's raw maker string, creating a
    provisional row when the name is genuinely new.

    Resolution order matches the seed's (alias table first, then the canonical
    key) so a feed and a reseed land on the same row rather than forking one
    company into two. Creating a provisional row on a miss is deliberate and
    also mirrors the seed: `parts.manufacturer_id` is half of the identity key
    and cannot be NULL, so "unknown maker" has to become a real row rather
    than a hole. `source='catalog'` marks it for the review queue.

    Returns None only when the name canonicalises to nothing — an empty or
    punctuation-only string — which the caller must treat as unidentifiable
    rather than as a new manufacturer.
    """
    # Truncated ONCE, here, so every lookup below and the row eventually
    # written all use the same string. They used to disagree: the stored
    # canonical_key was `key[:220]` while both lookups queried the full-length
    # key, so a maker whose canon exceeds 220 chars missed forever — each pass
    # tried to create it again, conflicted on the unique index, failed the
    # recovery re-read (also full-length), and raised RuntimeError.
    key = canon(name or "")[:220]
    if not key:
        return None

    alias = db.query(ManufacturerAlias).filter(ManufacturerAlias.alias_canon == key).first()
    if alias is not None:
        return alias.manufacturer_id

    existing = db.query(Manufacturer).filter(Manufacturer.canonical_key == key).first()
    if existing is not None:
        return existing.id

    return _create_provisional(db, (name or "").strip(), key)


def _create_provisional(db: Session, raw: str, key: str) -> uuid.UUID:
    """A new manufacturer row plus its alias, race-tolerant.

    Two feeds meeting the same unseen maker at once would both miss the
    lookups above; the loser catches the unique violation on `slug` and reads
    the winner's row instead of failing the part.
    """
    mid = uuid.uuid4()
    maker = Manufacturer(
        id=mid,
        name=raw[:200] or key[:200],
        slug=_unique_slug(db, raw or key),
        canonical_key=key,
        source="catalog",
    )
    if not _insert_if_absent(db, Manufacturer, maker):
        winner = db.query(Manufacturer).filter(Manufacturer.canonical_key == key).first()
        if winner is None:  # pragma: no cover - conflicted on slug, not key
            raise RuntimeError(f"manufacturer {raw!r} conflicted but is not findable")
        return winner.id
    _insert_if_absent(
        db,
        ManufacturerAlias,
        ManufacturerAlias(
            manufacturer_id=mid,
            alias_canon=key,
            alias=raw[:200] or key[:200],
            source="catalog",
            confidence="auto",
        ),
    )
    return mid


def _unique_slug(db: Session, name: str) -> str:
    """A URL-safe manufacturer slug, derived the way the seed derives one.

    `canon()` only strips `.,'®™` and turns `-_/()` into spaces — a colon, a
    slash inside a longer token, or any non-ASCII survives it. Building a slug
    by swapping spaces for hyphens therefore put those characters straight into
    `manufacturers.slug`, so the same company seeded from CSV and created by a
    feed got differently-shaped slugs, and a slug carrying `/` breaks any URL
    built from it. `_slugify` is the single home for this column's shape.
    """
    from app.db.seed_manufacturers import _slugify

    base = _slugify(name)[:200] or "manufacturer"
    slug = base
    n = 2
    while db.query(Manufacturer.id).filter(Manufacturer.slug == slug).first() is not None:
        slug = f"{base}-{n}"[:220]
        n += 1
    return slug


def _adopt_unlinked(
    db: Session, manufacturer_id: uuid.UUID, sku: str, manufacturer_name: str | None
) -> Part | None:
    """Claim a pre-existing row for this part that was never linked to a maker.

    Rows created before write-time manufacturer resolution carry
    ``manufacturer_id = NULL`` — 3,229 of them on production when this landed —
    and are therefore invisible to :func:`find_part`, which keys on the
    manufacturer. Without this, the first feed hit on such a part would create
    a SECOND row beside it: the exact duplication the constraint exists to
    prevent, caused by the fix for it.

    Adoption is deliberately narrow. The candidate must match on case-folded
    sku AND canonicalise to the same maker — matching on sku alone would fold
    a Desco taper tap into a Simpson panel meter, which is the collision the
    manufacturer half of the key is there to stop.

    This makes the code safe to deploy BEFORE the backfill migration, and
    self-healing afterwards for any straggler.
    """
    key = canon(manufacturer_name or "")
    if not key:
        return None
    candidates = (
        db.query(Part)
        .filter(Part.manufacturer_id.is_(None), func.upper(Part.sku) == sku.upper())
        .all()
    )
    for candidate in candidates:
        if canon(candidate.manufacturer_name or "") == key:
            candidate.manufacturer_id = manufacturer_id
            return candidate
    return None


def get_or_create_part(db: Session, *, sku: str, manufacturer_name: str | None, build):
    """Resolve (manufacturer, MPN) to a Part, creating it if new.

    `build(manufacturer_id)` constructs the Part the caller wants — the caller
    owns what a new row looks like (category, sub_slug, media), this owns
    identity and the race.

    Returns ``(part, created)``. Raises ValueError when the maker string
    carries no identity at all, because a part with no manufacturer cannot be
    keyed and would silently become undedupable.
    """
    manufacturer_id = resolve_manufacturer_id(db, manufacturer_name)
    if manufacturer_id is None:
        raise ValueError(f"unidentifiable manufacturer for sku {sku!r}: {manufacturer_name!r}")

    existing = find_part(db, manufacturer_id, sku)
    if existing is not None:
        return existing, False

    adopted = _adopt_unlinked(db, manufacturer_id, sku, manufacturer_name)
    if adopted is not None:
        return adopted, False

    _insert_if_absent(db, Part, build(manufacturer_id))
    # Always re-read: the row is now in the table either because we wrote it or
    # because a concurrent writer did, and the caller needs the SESSION-MANAGED
    # instance so its media/spec writes flush. Never `db.add()` the object we
    # built — Core already inserted it, and adding it would insert it twice.
    part = find_part(db, manufacturer_id, sku)
    if part is None:  # pragma: no cover - would mean the insert silently vanished
        raise RuntimeError(f"insert of {sku!r} left no findable row")
    return part, True
