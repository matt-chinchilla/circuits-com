"""Pure spec-field mappers for feed rows (search v2 §1.2).

Both mappers NEVER guess: anything outside their tables returns None, which
the importer treats as "the feed said nothing" — the stored value survives.
"""

import re

_NON_COMPLIANT = ("non-compliant", "non compliant", "not compliant")

# Package tokens → mounting style. Chip sizes match a token EXACTLY (the
# metric suffix "0805 (2012 Metric)" rides in a separate token); families
# match by token prefix ("SOIC-8", "TO-220-3", "DO-214AC").
_SMT_CHIP_SIZES = frozenset({"0201", "0402", "0603", "0805", "1206", "1210", "2010", "2512"})
_SMT_PREFIXES = (
    "SOT",
    "SOIC",
    "SSOP",
    "TSSOP",
    "MSOP",
    "QSOP",
    "QFN",
    "DFN",
    "QFP",
    "LQFP",
    "TQFP",
    "BGA",
    "CSP",
    "LGA",
    "SOD",
    "DPAK",
    "D2PAK",
    "DO-214",
)
_THT_PREFIXES = ("DIP", "PDIP", "TO-92", "TO-220", "TO-247", "DO-35", "DO-41", "RADIAL", "AXIAL")


def map_rohs(raw: str | None) -> bool | None:
    """Mouser ROHSStatus → tri-state. Non-compliant is checked FIRST because
    "RoHS Non-Compliant" would otherwise never be reachable behind a bare
    "compliant" containment."""
    text = (raw or "").strip().lower()
    if not text:
        return None
    if any(needle in text for needle in _NON_COMPLIANT):
        return False
    if "rohs compliant" in text:
        return True
    return None


def _mount_from_package(package: str | None) -> str | None:
    if not package:
        return None
    for token in re.split(r"[^A-Z0-9-]+", package.upper()):
        if not token:
            continue
        if token in _SMT_CHIP_SIZES:
            return "SMT"
        if token.startswith(_THT_PREFIXES):
            return "THT"
        if token.startswith(_SMT_PREFIXES):
            return "SMT"
    return None


def map_mount(attrs: list[dict] | None, package: str | None) -> str | None:
    """Feed mounting attribute first (AttributeName containing "mounting",
    case-insensitive), then the package-token table, else None."""
    for attr in attrs or []:
        name = (attr.get("AttributeName") or "").lower()
        if "mounting" not in name:
            continue
        value = (attr.get("AttributeValue") or "").lower()
        if "surface mount" in value or "smd" in value or "smt" in value:
            return "SMT"
        if "through hole" in value or "tht" in value:
            return "THT"
    return _mount_from_package(package)


# Raw feed lifecycle words → our enum. Anything unlisted returns None and the
# part keeps its default: an unmapped word must never stamp the truth-bit.
_LIFECYCLE_WORDS = (
    ("obsolete", "obsolete"),
    ("end of life", "obsolete"),
    ("eol", "obsolete"),
    ("not recommended", "nrnd"),
    ("nrnd", "nrnd"),
    ("new product", "active"),
    ("in production", "active"),
    ("production", "active"),
    ("active", "active"),
)


def map_lifecycle(raw: str | None) -> str | None:
    text = (raw or "").strip().lower()
    if not text:
        return None
    for needle, value in _LIFECYCLE_WORDS:
        if needle in text:
            return value
    return None
