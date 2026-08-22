"""Part spec fields (migration 039) + Mouser feed mapping.

Covers the §1.2 mapper tables (map_rohs / map_mount — no-guess NULLs), the
weeks-aware `_parse_lead_time` upgrade, `part_from_mouser` extraction, and the
importer's `is not None` stamp rule — rohs=False is a VALUE that must be
stored, and a later feed absence (None) must leave it untouched.
"""

import importlib.util
from pathlib import Path

import pytest

from app.models import Part
from app.services.part_feed.base import FeedPart
from app.services.part_feed.importer import _stamp_feed_facts
from app.services.part_feed.mouser import _parse_lead_time, part_from_mouser
from app.services.part_feed.specmap import map_mount, map_rohs, normalize_mount

# ── Migration 039 metadata guard ────────────────────────────────────────────
# SQLite ignores VARCHAR lengths, so the length contract is asserted on the
# column METADATA (the CLAUDE.md pattern), not on stored data.


def test_part_spec_columns_metadata():
    mount = Part.__table__.c.mount
    assert mount.nullable
    assert mount.type.length >= 8
    assert Part.__table__.c.rohs.nullable
    assert Part.__table__.c.lead_time_days.nullable


def test_migration_039_imports_cleanly():
    path = Path(__file__).parent.parent / "alembic" / "versions" / "039_part_spec_fields.py"
    spec = importlib.util.spec_from_file_location("migration_039", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.revision == "039"
    assert module.down_revision == "038"


# ── map_rohs ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("RoHS Compliant", True),
        ("ROHS COMPLIANT", True),
        ("RoHS Compliant By Exemption", True),
        # Versioned spellings — the directive number rides BETWEEN the word
        # and "compliant", so a plain containment matched none of these and
        # reported compliant parts as unknown.
        ("RoHS3 Compliant", True),
        ("ROHS3 COMPLIANT", True),
        ("RoHS-3 Compliant", True),
        ("RoHS 3 Compliant", True),
        ("RoHS3 Compliant By Exemption", True),
        # The versioned token alone IS the status in some feeds.
        ("RoHS3", True),
        ("RoHS-3", True),
        ("rohs 3", True),
        # Non-compliant still wins, versioned or not.
        ("RoHS3 Non-Compliant", False),
        ("RoHS-3 Not Compliant", False),
        # A bare label is not a claim — no guessing.
        ("RoHS", None),
        ("RoHS Status", None),
        ("Non-Compliant", False),
        ("non compliant", False),
        ("Not Compliant", False),
        ("", None),
        (None, None),
        ("Not Applicable", None),
        ("Unknown", None),
    ],
)
def test_map_rohs(raw, expected):
    assert map_rohs(raw) is expected


# ── map_mount ───────────────────────────────────────────────────────────────


def _attrs(name, value):
    return [{"AttributeName": name, "AttributeValue": value}]


@pytest.mark.parametrize(
    ("attrs", "package", "expected"),
    [
        # Feed mounting attribute wins, case-insensitive on the NAME too.
        (_attrs("Mounting Style", "Surface Mount"), None, "SMT"),
        (_attrs("MOUNTING TYPE", "SMD/SMT"), None, "SMT"),
        (_attrs("Mounting Style", "Through Hole"), None, "THT"),
        (_attrs("Mounting Style", "THT"), None, "THT"),
        # Attribute beats a contradicting package token.
        (_attrs("Mounting Style", "Through Hole"), "0805", "THT"),
        # Non-mounting attributes are ignored.
        (_attrs("Package / Case", "SOIC-8"), None, None),
        # Package-token table: SMT families.
        (None, "0805 (2012 Metric)", "SMT"),
        (None, "0402", "SMT"),
        (None, "SOT-23", "SMT"),
        (None, "SOIC-8", "SMT"),
        (None, "TSSOP-20", "SMT"),
        (None, "QFN-32", "SMT"),
        (None, "LQFP-64", "SMT"),
        (None, "BGA-256", "SMT"),
        (None, "SOD-123", "SMT"),
        (None, "D2PAK", "SMT"),
        (None, "DO-214AC (SMA)", "SMT"),
        # Package-token table: THT families.
        (None, "DIP-8", "THT"),
        (None, "PDIP-14", "THT"),
        (None, "TO-92", "THT"),
        (None, "TO-220-3", "THT"),
        (None, "DO-41", "THT"),
        (None, "Radial", "THT"),
        (None, "Axial", "THT"),
        # Never guess.
        (None, "XYZ-99", None),
        (None, None, None),
        (None, "", None),
        # Unrecognized mounting VALUE falls through to the package table.
        (_attrs("Mounting Style", "Chassis Mount"), "SOIC-8", "SMT"),
    ],
)
def test_map_mount(attrs, package, expected):
    assert map_mount(attrs, package) == expected


# ── _parse_lead_time (weeks-aware upgrade, single home) ─────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("28 Days", 28),
        ("6 Weeks", 42),
        ("1 Week", 7),
        ("12 weeks", 84),
        ("42", 42),
        (None, None),
        ("", None),
        ("In Stock", None),
    ],
)
def test_parse_lead_time(raw, expected):
    assert _parse_lead_time(raw) == expected


# ── part_from_mouser carries the new facts across the boundary ──────────────


def _raw_mouser(**overrides):
    raw = {
        "ManufacturerPartNumber": "STM32F407VGT6",
        "Manufacturer": "STMicroelectronics",
        "Description": "ARM MCU",
        "LeadTime": "6 Weeks",
        "ROHSStatus": "RoHS Compliant",
        "ProductAttributes": [
            {"AttributeName": "Package / Case", "AttributeValue": "LQFP-100"},
            {"AttributeName": "Mounting Style", "AttributeValue": "Surface Mount"},
        ],
    }
    raw.update(overrides)
    return raw


def test_part_from_mouser_extracts_spec_fields():
    fp = part_from_mouser(_raw_mouser())
    assert fp.rohs is True
    assert fp.mount == "SMT"
    assert fp.lead_time_days == 42
    assert fp.package == "LQFP-100"


def test_part_from_mouser_absent_fields_are_none():
    fp = part_from_mouser(_raw_mouser(ROHSStatus=None, ProductAttributes=[], LeadTime=None))
    assert fp.rohs is None
    assert fp.mount is None
    assert fp.lead_time_days is None


def test_part_from_mouser_non_compliant_is_false():
    fp = part_from_mouser(_raw_mouser(ROHSStatus="RoHS Non-Compliant"))
    assert fp.rohs is False


# ── Importer stamp rule: `is not None`, never truthiness ────────────────────


def _feed_part(**kw):
    return FeedPart(mpn="X1", manufacturer="Acme", **kw)


def test_stamp_stores_rohs_false():
    part = Part(sku="X1", manufacturer_name="Acme")
    changed = _stamp_feed_facts(part, _feed_part(rohs=False))
    assert part.rohs is False
    assert changed


def test_stamp_absence_leaves_false_untouched():
    part = Part(sku="X1", manufacturer_name="Acme")
    _stamp_feed_facts(part, _feed_part(rohs=False, mount="SMT", lead_time_days=42))
    # A later feed row that says NOTHING about the specs must not erase them.
    changed = _stamp_feed_facts(part, _feed_part())
    assert part.rohs is False
    assert part.mount == "SMT"
    assert part.lead_time_days == 42
    assert not changed


def test_stamp_writes_all_three():
    part = Part(sku="X1", manufacturer_name="Acme")
    changed = _stamp_feed_facts(part, _feed_part(rohs=True, mount="THT", lead_time_days=28))
    assert changed
    assert part.rohs is True
    assert part.mount == "THT"
    assert part.lead_time_days == 28


def test_stamp_same_values_report_unchanged():
    part = Part(sku="X1", manufacturer_name="Acme", rohs=True, mount="SMT", lead_time_days=14)
    changed = _stamp_feed_facts(part, _feed_part(rohs=True, mount="SMT", lead_time_days=14))
    assert not changed


# ── normalize_mount: the {SMT, THT, None} contract, enforced at every exit ──


class TestNormalizeMount:
    """`Part.mount` is String(8) and every reader branches on exactly two
    tokens, so an unrecognized value is worse than none — it renders as a
    mystery badge and a long one fails the Postgres INSERT outright."""

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("SMT", "SMT"),
            ("THT", "THT"),
            ("smt", "SMT"),  # casing is normalized, not rejected
            (" tht ", "THT"),
            # Anything else clamps to None = "the feed said nothing".
            ("Surface Mount", None),
            ("Through Hole", None),
            ("SMD", None),
            ("Chassis Mount", None),
            ("", None),
            (None, None),
        ],
    )
    def test_clamps_to_the_contract(self, raw, expected):
        assert normalize_mount(raw) == expected

    def test_map_mount_output_is_always_in_contract(self):
        """Whatever the table does, the exit is clamped."""
        packages = [
            "0805 (2012 Metric)",
            "SOIC-8",
            "DIP-8",
            "TO-220-3",
            "XYZ-99",
            "",
            None,
            "Surface Mount Device",
            "DO-214AC (SMA)",
            "Radial",
        ]
        attrs = [
            None,
            _attrs("Mounting Style", "Surface Mount"),
            _attrs("Mounting Style", "Chassis Mount"),
            _attrs("Package / Case", "SOIC-8"),
        ]
        for a in attrs:
            for pkg in packages:
                assert map_mount(a, pkg) in (None, "SMT", "THT")

    def test_stamp_clamps_a_provider_supplied_value(self):
        """FeedPart.mount is a bare `str`, so the clamp has to hold at the
        WRITE boundary too — Mouser is not the only feed this registry can
        carry, and a raw "Surface Mount" would not fit the column."""
        part = Part(sku="X1", manufacturer_name="Acme")
        changed = _stamp_feed_facts(part, _feed_part(mount="Surface Mount"))
        assert part.mount is None
        assert not changed

    def test_stamp_does_not_erase_a_good_value_with_junk(self):
        part = Part(sku="X1", manufacturer_name="Acme", mount="SMT")
        _stamp_feed_facts(part, _feed_part(mount="Chassis Mount"))
        assert part.mount == "SMT"

    def test_stamp_normalizes_casing(self):
        part = Part(sku="X1", manufacturer_name="Acme")
        assert _stamp_feed_facts(part, _feed_part(mount="tht"))
        assert part.mount == "THT"


def test_rohs3_survives_the_mouser_boundary():
    fp = part_from_mouser(_raw_mouser(ROHSStatus="RoHS3 Compliant"))
    assert fp.rohs is True
