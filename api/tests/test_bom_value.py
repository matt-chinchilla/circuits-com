"""bom_value — reading an MPN-less BOM line into catalog terms (pure, no DB)."""

from decimal import Decimal

import pytest

from app.services.bom_value import (
    CAPACITOR,
    INDUCTOR,
    LED,
    RESISTOR,
    ValueSpec,
    looks_like_part_number,
    package_code,
    parse_capacitance,
    parse_resistance,
    read_value_spec,
)

R_0805 = "Resistor_SMD:R_0805_2012Metric_Pad1.20x1.40mm_HandSolder"
C_0805 = "Capacitor_SMD:C_0805_2012Metric"
L_0805 = "Inductor_SMD:L_0805_2012Metric"
LED_0805 = "LED_SMD:LED_0805_2012Metric_Pad1.15x1.40mm_HandSolder"


def spec_of(value: str, footprint: str) -> ValueSpec:
    spec = read_value_spec(value, footprint)
    assert spec is not None, f"{value!r} on {footprint!r} did not read"
    return spec


class TestPackageCode:
    @pytest.mark.parametrize(
        ("text", "code"),
        [
            (R_0805, "0805"),
            ("0805 (2012 Metric)", "0805"),
            ("R_0201_0603Metric", "0201"),  # imperial first, never the metric 0603
            ("0201 (0603 Metric)", "0201"),
            ("C_01005_0402Metric", "01005"),
            ("Package_TO_SOT_SMD:SOT-23", None),
            ("Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm", None),  # 3225 is not 2225
            (None, None),
        ],
    )
    def test_reads_the_imperial_chip_code(self, text, code):
        assert package_code(text) == code


class TestValues:
    @pytest.mark.parametrize(
        ("value", "ohms"),
        [
            ("10k", "10000"),
            ("10K", "10000"),
            ("10 kOhm", "10000"),
            ("10kΩ", "10000"),
            ("4k7", "4700"),
            ("4.7k", "4700"),
            ("47R", "47"),
            ("100R", "100"),
            ("1R5", "1.5"),
            ("0R", "0"),
            ("2M2", "2200000"),
            ("10k 1%", "10000"),
            ("4,7k", "4700"),
        ],
    )
    def test_resistance(self, value, ohms):
        assert parse_resistance(value, lenient=False) == Decimal(ohms)

    def test_a_bare_number_is_ohms_only_on_a_resistor_footprint(self):
        assert parse_resistance("47", lenient=False) is None
        assert parse_resistance("47", lenient=True) == Decimal(47)

    @pytest.mark.parametrize(
        ("value", "farads"),
        [
            ("100nF", "1e-7"),
            ("0.1uF", "1e-7"),
            ("0.1µF", "1e-7"),
            ("22pF", "2.2e-11"),
            ("4u7F", "4.7e-6"),
            ("100nF/50V", "1e-7"),
        ],
    )
    def test_capacitance_with_its_unit(self, value, farads):
        assert parse_capacitance(value, lenient=False) == Decimal(farads)

    def test_unitless_capacitance_reads_only_on_a_capacitor_footprint(self):
        assert parse_capacitance("100n", lenient=False) is None
        assert parse_capacitance("100n", lenient=True) == Decimal("1e-7")
        assert parse_capacitance("100", lenient=True) is None  # pF or µF? never guessed


class TestReadValueSpec:
    def test_the_keyboard_resistor_reads_in_both_feed_dialects(self):
        spec = spec_of("10k", R_0805)
        assert (spec.kind, spec.code) == (RESISTOR, "0805")
        # DigiKey "RES 10K OHM", Mouser "10K Ohms" and "10 kOhms"
        assert spec.value_terms == (" 10K OHM", " 10KOHM", " 10 KOHM")

    def test_sub_kilohm_values_have_no_multiplier(self):
        assert spec_of("47R", R_0805).value_terms == (" 47 OHM", " 47OHM")

    def test_capacitance_is_spelled_in_every_unit(self):
        spec = spec_of("100n", C_0805)
        assert spec.kind == CAPACITOR
        assert {" 0.1UF", " 100NF", " 100000PF"} <= set(spec.value_terms)

    def test_inductor(self):
        spec = spec_of("10uH", L_0805)
        assert (spec.kind, spec.code) == (INDUCTOR, "0805")
        assert " 10UH" in spec.value_terms

    def test_led_colour_is_a_constraint_only_when_named(self):
        assert spec_of("LED", LED_0805).value_terms == ()
        spec = spec_of("LED_Red", "LED_SMD:LED_0603_1608Metric")
        assert (spec.kind, spec.code, spec.value_terms) == (LED, "0603", (" RED",))

    def test_a_bare_chip_code_takes_the_class_from_the_value(self):
        assert spec_of("10k", "0805").kind == RESISTOR
        assert spec_of("100nF", "0805").kind == CAPACITOR
        assert read_value_spec("100n", "0805") is None  # unitless and classless

    @pytest.mark.parametrize(
        ("value", "footprint"),
        [
            ("10k", "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal"),
            ("10k", "Resistor_SMD:R_Array_Convex_4x0603"),  # a network, not a chip
            ("100nF", R_0805),  # value contradicts the footprint
            ("DNP", R_0805),
            ("SW_Push", "Button_Switch_Keyboard:SW_Cherry_MX_1.00u_PCB"),
            ("Pico", "MCU_RaspberryPi_and_Boards:RPi_Pico_SMD_TH"),
            ("10k", None),
            (None, R_0805),
        ],
    )
    def test_uncertain_lines_are_not_read(self, value, footprint):
        assert read_value_spec(value, footprint) is None


class TestLooksLikePartNumber:
    @pytest.mark.parametrize(
        "value", ["BSS138", "2N7002", "2n7002", "1n4148", "LM1117-3.3", "ATmega328P-AU", "NE555"]
    )
    def test_part_numbers(self, value):
        assert looks_like_part_number(value)

    @pytest.mark.parametrize(
        "value",
        [
            "10k",
            "4k7",
            "100n",
            "4u7",
            "LED",
            "Pico",
            "SW_Push",
            "Conn_01x01_Pin",
            "12MHz",
            "DNP",
            "",
        ],
    )
    def test_not_part_numbers(self, value):
        assert not looks_like_part_number(value)
