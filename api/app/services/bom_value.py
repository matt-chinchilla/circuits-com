"""What an MPN-less BOM line DOES say, read into terms the catalog is searched by.

Most KiCad schematics carry no part number (KiCad reserves no MPN field, spec
D7), so a real board lands as lines like `10k` on
`Resistor_SMD:R_0805_2012Metric_Pad1.20x1.40mm_HandSolder`. The catalog holds
that resistor (`RC0805FR-0710KL`, "RES 10K OHM 1% 1/8W 0805"), but only a
reading of the line can find it: a component CLASS, a VALUE in base units, a
CHIP SIZE. This module does the reading and nothing else. It is PURE (no DB, no
HTTP): `bom_match` owns the query built from it, and each is tested alone.

The reading is deliberately narrow. A line is readable only when the class and
the chip size are both CERTAIN, because a match that puts a 1206 part on an
0805 pad is worse than an honest "not found". So only chip footprints qualify
(an axial footprint fixes the lead pitch, not the body, and ranks a 1 W part
beside a 1/8 W one), and a value that carries no unit reads only when the
footprint has already said what the part is.
"""

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

# Imperial chip sizes: the codes a distributor's package field and description
# carry ("0805 (2012 Metric)", "RES 10K OHM 1% 1/8W 0805"). Digit-anchored so a
# code never matches inside a longer run ("2012Metric" is not 2010). The FIRST
# code in a string is the imperial one in every spelling this reads: KiCad's
# `R_0201_0603Metric` and a feed's "0201 (0603 Metric)" both lead with it.
_CHIP_CODE = re.compile(
    r"(?<!\d)(01005|0201|0402|0603|0805|1008|1206|1210|1806|1812|2010|2220|2225|2512)(?!\d)"
)

# A chip footprint NAME whose prefix says the class: KiCad's own
# `R_0805_2012Metric…`, `C_…`, `L_…`, `LED_…`, and the common `R0805` spellings
# of other libraries. `R_Array_Convex_4x0603` is a network and does not match.
_CHIP_FOOTPRINT = re.compile(
    r"^(LED|R|C|L)[_-]?(01005|0201|0402|0603|0805|1008|1206|1210|1806|1812|2010|2220|2225|2512)"
    r"(?:[_\-.]|$)",
    re.IGNORECASE,
)
_BARE_CHIP = re.compile(
    r"^(01005|0201|0402|0603|0805|1008|1206|1210|1806|1812|2010|2220|2225|2512)(?:[_\-.]|$)"
)

_CLASS_BY_PREFIX = {"R": "resistor", "C": "capacitor", "L": "inductor", "LED": "led"}

RESISTOR = "resistor"
CAPACITOR = "capacitor"
INDUCTOR = "inductor"
LED = "led"

# How each class is DESCRIBED in the catalog, in both feed dialects: DigiKey's
# "RES 10K OHM 1% 1/8W 0805" / "CAP CER 0.1UF 50V X7R 0805" / "FIXED IND 10UH …"
# / "LED RED DIFFUSED 0805 SMD", and Mouser's "Thick Film Resistors - SMD 0805
# 10K Ohms…" / "Multilayer Ceramic Capacitors MLCC - SMD/SMT 0805 0.1uF…".
# ILIKE patterns: any `include` must match and no `exclude` may.
CLASS_TERMS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    RESISTOR: (("RES %", "%resistor%"), ("%network%", "%array%")),
    CAPACITOR: (("CAP %", "%capacitor%"), ("%trimmer%", "%network%", "%array%")),
    INDUCTOR: (("%IND %", "%inductor%"), ("%coupled%", "%array%")),
    LED: (("%LED%",), ("%driver%",)),
}

_LED_COLOURS = ("red", "green", "blue", "yellow", "white", "orange", "amber")
_LED_COLOUR = re.compile(r"(?<![a-z])(" + "|".join(_LED_COLOURS) + r")(?![a-z])")


@dataclass(frozen=True)
class ValueSpec:
    """One readable line, as the catalog query needs it. Hashable, so lines that
    say the same thing share ONE branch of the batched query."""

    kind: str  # RESISTOR | CAPACITOR | INDUCTOR | LED
    code: str  # imperial chip size, e.g. "0805"
    # Description spellings of the value, ANY of which may match (ILIKE
    # `%term%`). Each term starts with a space, which is the word boundary that
    # keeps " 10K OHM" out of "RES 110K OHM". Empty = no value constraint (an
    # LED whose value names no colour).
    value_terms: tuple[str, ...]


def package_code(text: str | None) -> str | None:
    """The imperial chip size a footprint or package string names, or None.

    `Resistor_SMD:R_0805_2012Metric_Pad1.20x1.40mm_HandSolder` -> "0805";
    "0805 (2012 Metric)" -> "0805"; `Package_TO_SOT_SMD:SOT-23` -> None."""
    match = _CHIP_CODE.search(text or "")
    return match.group(1) if match else None


def _footprint_chip(footprint: str | None) -> tuple[str | None, str] | None:
    """(class or None, chip code) when the footprint is a chip footprint."""
    name = (footprint or "").strip()
    if ":" in name:
        name = name.split(":", 1)[1].strip()
    if not name:
        return None
    match = _CHIP_FOOTPRINT.match(name)
    if match:
        return _CLASS_BY_PREFIX[match.group(1).upper()], match.group(2)
    bare = _BARE_CHIP.match(name)
    if bare:
        return None, bare.group(1)
    return None


# ── values ─────────────────────────────────────────────────────────────────

_SCALE = {
    "p": Decimal("1e-12"),
    "n": Decimal("1e-9"),
    "u": Decimal("1e-6"),
    "µ": Decimal("1e-6"),  # MICRO SIGN
    "μ": Decimal("1e-6"),  # GREEK SMALL LETTER MU
    "m": Decimal("1e-3"),
    "": Decimal(1),
    "k": Decimal("1e3"),
    "K": Decimal("1e3"),
    "M": Decimal("1e6"),
    "G": Decimal("1e9"),
}

# `4k7`, `2M2`, `1R5`, `0R1`, `10K0`. At most three digits after the letter, so
# a part number that happens to start the same way (`2n7002`, `1n4148`) is
# never read as a value.
_RES_RKM = re.compile(r"^(\d+)([RrEkKMG])(\d{1,3})$")
# `10k`, `10 k`, `10kΩ`, `10 kOhm`, `47R`, `47`, `100 ohms`, `1M`, `100m`.
_RES_DEC = re.compile(r"^(\d+(?:\.\d+)?)\s*([kKMGm]?)\s*(Ω|Ω|(?i:ohms?)|R|r|E)?$")
# `4u7`, `4n7`, `2p2` (a trailing F allowed).
_CAP_RKM = re.compile(r"^(\d+)([pnuµμ])(\d{1,3})F?$")
# `100nF`, `100n`, `100 nF`, `0.1uF`, `0.1µF`, `22pF`.
_CAP_DEC = re.compile(r"^(\d+(?:\.\d+)?)\s*([pnuµμm]?)\s*(F)?$")
_IND_RKM = re.compile(r"^(\d+)([nuµμm])(\d{1,3})H?$")
_IND_DEC = re.compile(r"^(\d+(?:\.\d+)?)\s*([pnuµμm]?)\s*(H)?$")


def _candidates(value: str) -> list[str]:
    """The whole value, then its leading token: `10k 1%`, `100nF/50V` and
    `10k_0805` carry a qualifier after the value itself."""
    text = value.strip().replace(",", ".")
    head = re.split(r"[\s/;@_]+", text, maxsplit=1)[0]
    return [text] if head == text else [text, head]


def _dec(number: str, scale: str) -> Decimal | None:
    try:
        return Decimal(number) * _SCALE[scale]
    except (InvalidOperation, KeyError):
        return None


def parse_resistance(value: str, *, lenient: bool) -> Decimal | None:
    """Ohms. `lenient` (the footprint already says RESISTOR) admits a bare
    number (`47`) and a milli prefix (`100m`); otherwise the value must carry
    its own unit (`47R`, `47Ω`) or a k/M/G multiplier."""
    for text in _candidates(value):
        rkm = _RES_RKM.match(text)
        if rkm:
            whole, letter, frac = rkm.groups()
            scale = "" if letter in "RrE" else letter
            return _dec(f"{whole}.{frac}", scale)
        dec = _RES_DEC.match(text)
        if dec:
            number, scale, unit = dec.groups()
            explicit = unit is not None or scale in ("k", "K", "M", "G")
            if explicit or (lenient and scale in ("", "m")):
                return _dec(number, scale)
    return None


def parse_capacitance(value: str, *, lenient: bool) -> Decimal | None:
    """Farads. `lenient` (the footprint says CAPACITOR) admits KiCad's usual
    unitless `100n`; otherwise the value must end in F. A bare number is never
    a capacitance: `100` could be pF or µF."""
    for text in _candidates(value):
        rkm = _CAP_RKM.match(text)
        if rkm and (lenient or text.endswith("F")):
            whole, scale, frac = rkm.groups()
            return _dec(f"{whole}.{frac}", scale)
        dec = _CAP_DEC.match(text)
        if dec:
            number, scale, unit = dec.groups()
            if scale == "":
                if unit is not None and lenient:
                    return _dec(number, "")  # a literal `1F` supercap
                continue
            if unit is not None or (lenient and scale != "m"):
                return _dec(number, scale)
    return None


def parse_inductance(value: str, *, lenient: bool) -> Decimal | None:
    """Henries. Same rule as capacitance: unitless `10u` only on an inductor
    footprint."""
    for text in _candidates(value):
        rkm = _IND_RKM.match(text)
        if rkm and (lenient or text.endswith("H")):
            whole, scale, frac = rkm.groups()
            return _dec(f"{whole}.{frac}", scale)
        dec = _IND_DEC.match(text)
        if dec:
            number, scale, unit = dec.groups()
            if scale == "":
                continue
            if unit is not None or lenient:
                return _dec(number, scale)
    return None


# ── how the catalog spells a value ─────────────────────────────────────────


def _num(value: Decimal) -> str:
    """`Decimal('4.700')` -> "4.7", `Decimal('1E+1')` -> "10"."""
    text = format(value.normalize(), "f")
    return text


def _ohm_terms(ohms: Decimal) -> tuple[str, ...]:
    for scale, letter in ((Decimal("1e9"), "G"), (Decimal("1e6"), "M"), (Decimal("1e3"), "K")):
        if ohms >= scale:
            number = _num(ohms / scale)
            # " 10K OHM" (DigiKey, and Mouser's "10K Ohms"), " 10KOHM", and
            # Mouser's spaced " 10 kOhms".
            return (f" {number}{letter} OHM", f" {number}{letter}OHM", f" {number} {letter}OHM")
    number = _num(ohms)
    return (f" {number} OHM", f" {number}OHM")


def _unit_terms(base: Decimal, units: tuple[tuple[str, Decimal], ...]) -> tuple[str, ...]:
    """Every unit a feed might print the value in, tight and spaced: 100 nF is
    DigiKey's "0.1UF" and Mouser's "100nF" alike."""
    terms: list[str] = []
    for suffix, scale in units:
        number = _num(base / scale)
        terms.extend((f" {number}{suffix}", f" {number} {suffix}"))
    return tuple(terms)


_FARAD_UNITS = (("UF", Decimal("1e-6")), ("NF", Decimal("1e-9")), ("PF", Decimal("1e-12")))
# No mH spelling on purpose: " 1MH" also matches an inductor's "1MHZ" SRF.
_HENRY_UNITS = (("UH", Decimal("1e-6")), ("NH", Decimal("1e-9")))


def read_value_spec(value: str | None, footprint: str | None) -> ValueSpec | None:
    """The line as a catalog query, or None when it cannot be read with
    certainty (no chip footprint, an unreadable value, or a value that
    contradicts its footprint, like `100nF` on `R_0805`)."""
    text = (value or "").strip()
    chip = _footprint_chip(footprint)
    if not text or chip is None:
        return None
    kind, code = chip

    if kind == LED:
        colour = _LED_COLOUR.search(text.lower())
        return ValueSpec(LED, code, (f" {colour.group(1).upper()}",) if colour else ())

    if kind in (None, RESISTOR):
        ohms = parse_resistance(text, lenient=kind == RESISTOR)
        if ohms is not None:
            return ValueSpec(RESISTOR, code, _ohm_terms(ohms))
    if kind in (None, CAPACITOR):
        farads = parse_capacitance(text, lenient=kind == CAPACITOR)
        if farads is not None and farads > 0:
            return ValueSpec(CAPACITOR, code, _unit_terms(farads, _FARAD_UNITS))
    if kind in (None, INDUCTOR):
        henries = parse_inductance(text, lenient=kind == INDUCTOR)
        if henries is not None and henries > 0:
            return ValueSpec(INDUCTOR, code, _unit_terms(henries, _HENRY_UNITS))
    return None


# ── a value that is really a part number ────────────────────────────────────

_PART_NUMBER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.,+#/\-]*$")
_FREQUENCY = re.compile(r"^\d+(?:\.\d+)?\s*[kKMG]?Hz$", re.IGNORECASE)


def looks_like_part_number(value: str | None) -> bool:
    """Is this Value field a part number (`BSS138`, `LM1117-3.3`, `2N7002`)?

    Designers put the part number in the Value field constantly, and when they
    do it is the best identity the line has. Refused: anything shorter than 4,
    anything without both a letter and a digit (`LED`, `Pico`), KiCad's generic
    symbol names (the underscore in `SW_Push`, `Conn_01x01_Pin`), frequencies,
    and anything that reads as a passive value under ANY class (`10k`, `100n`,
    `4u7`), because a SKU that happens to equal `100N` is not a capacitor."""
    text = (value or "").strip()
    if len(text) < 4 or not _PART_NUMBER.match(text):
        return False
    if not (re.search(r"[A-Za-z]", text) and re.search(r"\d", text)):
        return False
    if _FREQUENCY.match(text):
        return False
    return (
        parse_resistance(text, lenient=True) is None
        and parse_capacitance(text, lenient=True) is None
        and parse_inductance(text, lenient=True) is None
    )
