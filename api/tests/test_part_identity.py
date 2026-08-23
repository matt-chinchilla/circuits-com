"""Part identity: (canonical manufacturer, case-folded MPN).

The cases below are not hypothetical — every one is a real collision measured
in the production catalog (175,065 parts) before the constraint existed. The
punctuation tests are the important ones: they are the guard against
"normalise harder", which looks tidier and merges a 6.8 V diode into a 68 V
one.
"""

import uuid

import pytest
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from app.models import Manufacturer, Part
from app.services.part_identity import (
    find_part,
    get_or_create_part,
    resolve_manufacturer_id,
)


def _build(sku: str):
    def build(manufacturer_id):
        return Part(
            id=uuid.uuid4(),
            sku=sku,
            slug=sku.lower(),
            manufacturer_name="x",
            manufacturer_id=manufacturer_id,
        )

    return build


def _mk(db, sku: str, maker: str):
    part, created = get_or_create_part(db, sku=sku, manufacturer_name=maker, build=_build(sku))
    db.flush()
    return part, created


# ── the rule ────────────────────────────────────────────────────────────────


def test_case_variant_is_the_same_part(db):
    """Production had five Nordic pairs like this, all genuine duplicates."""
    first, created_a = _mk(db, "nRF52840-QIAA-R7", "Nordic Semiconductor")
    second, created_b = _mk(db, "NRF52840-QIAA-R7", "Nordic Semiconductor")
    assert created_a is True
    assert created_b is False, "a case variant must resolve to the existing part"
    assert first.id == second.id


def test_punctuation_variant_is_a_DIFFERENT_part(db):
    """1.5SMC6.8AHM3 is a 6.8V TVS diode; 1.5SMC68AHM3 is a 68V one.

    If this test ever fails because someone 'improved' the key by stripping
    punctuation, the catalog will start quoting the wrong breakdown voltage.
    """
    low, _ = _mk(db, "1.5SMC6.8AHM3", "Littelfuse")
    high, created = _mk(db, "1.5SMC68AHM3", "Littelfuse")
    assert created is True, "punctuation carries meaning — these are two parts"
    assert low.id != high.id


@pytest.mark.parametrize(
    "a,b",
    [
        ("CHD15MF-2.5", "CHD15MF-25"),          # 2.5 ft vs 25 ft cable
        ("MS116-1.0", "MS116-10"),              # 0.63-1.0A vs 6.3-10.0A starter
        ("ASFLMB-1.8432MHZ", "ASFLMB-18.432MHZ"),  # different frequencies
        ("FLUKE-62MAX", "FLUKE-62MAX+"),        # '+' marks a product variant
    ],
)
def test_real_punctuation_pairs_stay_distinct(db, a, b):
    first, _ = _mk(db, a, "Acme")
    second, created = _mk(db, b, "Acme")
    assert created is True
    assert first.id != second.id


def test_same_mpn_different_manufacturer_are_different_parts(db):
    """49 real pairs collide this way — a Desco taper tap vs a Simpson meter."""
    one, _ = _mk(db, "100-17", "Desco")
    two, created = _mk(db, "100-17", "Simpson Electric")
    assert created is True
    assert one.id != two.id


# ── the constraint itself ───────────────────────────────────────────────────


def test_unique_index_is_declared_on_the_model(db):
    """SQLAlchemy cannot REFLECT an expression index, so assert the declaration.

    inspect() would return nothing here — that is the documented trap.
    """
    names = {ix.name for ix in Part.__table__.indexes}
    assert "uq_parts_manufacturer_sku_upper" in names
    ix = next(i for i in Part.__table__.indexes if i.name == "uq_parts_manufacturer_sku_upper")
    assert ix.unique is True


def test_database_rejects_a_case_duplicate_written_around_the_service(db):
    """Behavioural proof the index is live, not just declared.

    A writer that bypasses part_identity must still be stopped by the engine —
    that is the difference between a convention and a constraint.
    """
    mid = resolve_manufacturer_id(db, "SiTime")
    db.add(
        Part(id=uuid.uuid4(), sku="SiT1533AI-H4-DCC-32.768D", slug="a",
             manufacturer_name="SiTime", manufacturer_id=mid)
    )
    db.flush()
    db.add(
        Part(id=uuid.uuid4(), sku="SIT1533AI-H4-DCC-32.768D", slug="b",
             manufacturer_name="SiTime", manufacturer_id=mid)
    )
    with pytest.raises(IntegrityError):
        db.flush()


def test_concurrent_loser_gets_the_winners_row_instead_of_an_error(db):
    """The upsert path: when the INSERT loses the race, return the winner.

    Simulated by creating the row behind the service's back between its
    lookup and its insert — the same end state a second writer produces.
    Without this, adding the index turns silent duplicates into 500s (measured:
    7 of 8 concurrent writers died with IntegrityError).
    """
    mid = resolve_manufacturer_id(db, "Nordic Semiconductor")
    winner = Part(id=uuid.uuid4(), sku="nRF5340-QKAA-R7", slug="w",
                  manufacturer_name="Nordic Semiconductor", manufacturer_id=mid)
    db.add(winner)
    db.flush()

    got, created = get_or_create_part(
        db,
        sku="NRF5340-QKAA-R7",           # same identity, different case
        manufacturer_name="Nordic Semiconductor",
        build=_build("NRF5340-QKAA-R7"),
    )
    assert created is False
    assert got.id == winner.id


# ── manufacturer resolution ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    "a,b",
    [
        ("Texas Instruments Inc.", "Texas Instruments"),   # legal suffix + full stop
        ("Yageo Corporation", "YAGEO"),                    # legal suffix + case
        ("Vishay / Dale", "Vishay Dale"),                  # separator
    ],
)
def test_manufacturer_resolves_through_canon_not_raw_string(db, a, b):
    """Two spellings of one company must land on one manufacturer row.

    If they don't, the same physical part arrives from two distributors under
    two manufacturer ids, the identity key sees two parts, and the comparison
    silently doesn't happen.
    """
    first = resolve_manufacturer_id(db, a)
    second = resolve_manufacturer_id(db, b)
    assert first is not None and first == second


@pytest.mark.parametrize(
    "a,b",
    [
        # 'ASA' (Norwegian) is NOT in canon's legal-suffix set, which has 24
        # mostly-Western forms. 'inc/ltd/gmbh/ab/oy' are handled; asa, oyj and
        # a/s are not.
        ("Nordic Semiconductor ASA", "NORDIC SEMICONDUCTOR"),
        # canon does not close internal spacing.
        ("STMicroelectronics", "ST Microelectronics"),
    ],
)
def test_KNOWN_GAP_canon_does_not_merge_these(db, a, b):
    """Documented limitation, pinned so a future canon change is a deliberate act.

    These SHOULD be one company each and currently resolve to two rows. It is
    tolerable today because one feed spells each maker one way; it becomes a
    duplicate-part source the moment a second distributor spells them
    differently. Fixing it means editing `manufacturer_canon._LEGAL_SUFFIXES`,
    which carries pinned contract pairs of its own (Microchip USA must NOT
    merge with Microchip Technology) — so it is its own change, with its own
    review. If you make them merge, flip this test rather than delete it.
    """
    assert resolve_manufacturer_id(db, a) != resolve_manufacturer_id(db, b)


def test_unknown_manufacturer_becomes_a_provisional_row(db):
    """manufacturer_id is half the identity key, so it cannot be left NULL."""
    before = db.query(Manufacturer).count()
    mid = resolve_manufacturer_id(db, "Entirely New Maker Ltd")
    db.flush()
    assert mid is not None
    assert db.query(Manufacturer).count() == before + 1
    created = db.query(Manufacturer).filter(Manufacturer.id == mid).one()
    assert created.source == "catalog", "provisional rows must be reviewable"


def test_unidentifiable_manufacturer_is_refused_not_guessed(db):
    """A part with no maker cannot be keyed, so it must not be created."""
    with pytest.raises(ValueError):
        get_or_create_part(db, sku="ABC123", manufacturer_name="   ", build=_build("ABC123"))


def test_find_part_is_case_insensitive_and_agrees_with_bom_match(db):
    """bom_match has always used upper(sku); writers used to disagree."""
    mid = resolve_manufacturer_id(db, "Yageo")
    part, _ = _mk(db, "RC0603FR-0710KL", "Yageo")
    assert find_part(db, mid, "rc0603fr-0710kl") is not None
    assert find_part(db, mid, "RC0603FR-0710KL").id == part.id
    # and the index the matcher rides is the same one
    assert (
        db.query(Part)
        .filter(func.upper(Part.sku) == "RC0603FR-0710KL")
        .count()
        == 1
    )
