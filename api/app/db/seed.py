"""Seed script — populate categories, suppliers, category_suppliers, sponsors,
admin user, parts, part listings, price breaks, and revenue.

Run with:
    python -m app.db.seed

The script is idempotent: it uses get-or-create semantics keyed on slug (categories)
and name (suppliers/users), so it is safe to run multiple times.
"""

from __future__ import annotations

import json
import random
import re
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import bcrypt
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models import (
    Category,
    CategorySupplier,
    Part,
    PartListing,
    PriceBreak,
    Revenue,
    Sponsor,
    Supplier,
    User,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def slugify(text: str) -> str:
    """Convert a human-readable name to a URL-safe slug."""
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"[\s]+", "-", text.strip())
    text = re.sub(r"-+", "-", text)
    return text


def slugify_sku(sku: str) -> str:
    """Derive a URL-safe slug from a part SKU (e.g. ADP151AUJZ-3.3 -> adp151aujz-3-3)."""
    slug = sku.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = re.sub(r"-+", "-", slug)
    return slug.strip("-")


def get_or_create_category(
    db: Session,
    name: str,
    slug: str,
    icon: str = "lightning",
    parent: Category | None = None,
    sort_order: int = 0,
) -> Category:
    obj = db.query(Category).filter(Category.slug == slug).first()
    if obj is None:
        obj = Category(
            name=name,
            slug=slug,
            icon=icon,
            parent_id=parent.id if parent else None,
            sort_order=sort_order,
        )
        db.add(obj)
        db.flush()
    return obj


# Canonical taxonomy mirroring ui_kits/website/data.js (the website's
# authoritative slug source). Slugs are EXPLICIT per-row — slugify(name)
# would diverge (e.g. would produce 'voltage-regulators-ldos' instead of
# the canonical 'ldo-regulators'; 'motor-motion-control-ics' instead of
# 'motor-motion-ics'). The website's routes assume these short slugs; do
# not change without updating the website data.js in lockstep.
#
# Tuple shape: (name, slug, icon, [(sub_name, sub_slug, sub_icon), ...]).
# All icon strings are Phosphor Light names (rendered via the <Icon>
# wrapper at frontend/src/shared/components/Icon.tsx).
CATEGORY_DATA: list[tuple[str, str, str, list[tuple[str, str, str]]]] = [
    (
        "Power Management ICs (PMICs)",
        "power-management-ics-pmics",
        "lightning",
        [
            ("Voltage Regulators (LDOs)", "ldo-regulators", "battery-charging"),
            ("DC-DC Converters (Buck/Boost)", "dc-dc-converters", "battery-charging-vertical"),
            ("Battery Management ICs (BMS)", "battery-management", "battery-full"),
            ("Power Supervisors / Reset ICs", "power-supervisors", "shield-warning"),
            ("LED Drivers", "led-drivers", "lightbulb"),
        ],
    ),
    (
        "Microcontrollers & Processors",
        "microcontrollers-processors",
        "cpu",
        [
            ("8-bit Microcontrollers", "8bit-mcus", "cpu"),
            ("32-bit Microcontrollers (ARM Cortex-M)", "32bit-mcus", "cpu"),
            ("Application Processors", "app-processors", "computer-tower"),
            ("Digital Signal Processors (DSPs)", "dsps", "chart-line"),
            ("System-on-Chip (SoC)", "soc", "squares-four"),
        ],
    ),
    (
        "Analog ICs",
        "analog-ics",
        "wave-sine",
        [
            ("Operational Amplifiers (Op-Amps)", "op-amps", "trend-up"),
            ("Comparators", "comparators", "scales"),
            ("Analog Multiplexers / Switches", "analog-mux-switches", "shuffle"),
            ("Voltage References", "voltage-references", "target"),
            ("Instrumentation Amplifiers", "instrumentation-amps", "ruler"),
        ],
    ),
    (
        "Interface ICs",
        "interface-ics",
        "plugs-connected",
        [
            ("UART / USART Transceivers", "uart-usart", "arrows-left-right"),
            ("USB Interface ICs", "usb-interface", "usb"),
            ("I2C / SPI Interface ICs", "i2c-spi", "arrows-down-up"),
            ("CAN / LIN Transceivers", "can-lin", "car-simple"),
            ("Level Shifters", "level-shifters", "arrows-vertical"),
        ],
    ),
    (
        "Memory ICs",
        "memory-ics",
        "hard-drives",
        [
            ("EEPROM", "eeprom", "hard-drive"),
            ("NOR Flash", "nor-flash", "hard-drive"),
            ("NAND Flash", "nand-flash", "hard-drive"),
            ("SRAM", "sram", "hard-drive"),
            ("DRAM", "dram", "hard-drive"),
        ],
    ),
    (
        "Logic ICs",
        "logic-ics",
        "function",
        [
            ("Logic Gates (AND, OR, NOT, etc.)", "logic-gates", "function"),
            ("Flip-Flops / Latches", "flip-flops-latches", "squares-four"),
            ("Counters", "counters", "list-numbers"),
            ("Shift Registers", "shift-registers", "arrow-right"),
            ("Programmable Logic (CPLDs / FPGAs)", "cpld-fpga", "wrench"),
        ],
    ),
    (
        "RF & Wireless ICs",
        "rf-wireless-ics",
        "wifi-high",
        [
            ("Bluetooth ICs", "bluetooth", "bluetooth"),
            ("Wi-Fi ICs", "wifi", "wifi-high"),
            ("RF Transceivers", "rf-transceivers", "broadcast"),
            ("GPS / GNSS Receivers", "gps-gnss", "globe-hemisphere-west"),
            ("NFC / RFID ICs", "nfc-rfid", "device-mobile"),
        ],
    ),
    (
        "Sensor ICs",
        "sensor-ics",
        "thermometer",
        [
            ("Temperature Sensors", "temp-sensors", "thermometer"),
            ("Accelerometers", "accelerometers", "arrows-out-cardinal"),
            ("Gyroscopes", "gyroscopes", "arrows-clockwise"),
            ("Pressure Sensors", "pressure-sensors", "gauge"),
            ("Proximity / Light Sensors", "proximity-light", "eye"),
        ],
    ),
    (
        "Audio & Video ICs",
        "audio-video-ics",
        "speaker-high",
        [
            ("Audio Amplifiers", "audio-amps", "speaker-high"),
            ("CODECs (Audio/Video)", "codecs", "music-notes"),
            ("Video Processors", "video-processors", "film-strip"),
            ("HDMI / Display Interface ICs", "hdmi-display", "monitor"),
            ("Microphone Preamplifiers", "mic-preamps", "microphone"),
        ],
    ),
    (
        "Clock & Timing ICs",
        "clock-timing-ics",
        "clock",
        [
            ("Oscillators", "oscillators", "wave-sine"),
            ("Real-Time Clocks (RTC)", "rtc", "alarm"),
            ("Clock Generators", "clock-generators", "clock"),
            ("PLL (Phase-Locked Loops)", "pll", "arrows-counter-clockwise"),
            ("Timer ICs", "timer-ics", "timer"),
        ],
    ),
    (
        "Motor & Motion Control ICs",
        "motor-motion-ics",
        "gear",
        [
            ("Motor Drivers (DC/Stepper/BLDC)", "motor-drivers", "gear"),
            ("Servo Controllers", "servo-controllers", "game-controller"),
            ("Gate Drivers (MOSFET/IGBT)", "gate-drivers", "lightning"),
            ("Motion Control ICs", "motion-control", "person-simple-run"),
            ("PWM Controllers", "pwm-controllers", "wave-square"),
        ],
    ),
    (
        "Data Conversion ICs",
        "data-conversion-ics",
        "arrows-clockwise",
        [
            ("Analog-to-Digital Converters (ADC)", "adc", "chart-line"),
            ("Digital-to-Analog Converters (DAC)", "dac", "chart-line-down"),
            ("Sigma-Delta Converters", "sigma-delta", "trend-up"),
            ("Voltage-to-Frequency Converters", "vf-converters", "wave-sine"),
            ("Touchscreen Controllers", "touchscreen", "hand-pointing"),
        ],
    ),
    (
        "Security & Authentication ICs",
        "security-auth-ics",
        "lock-key",
        [
            ("Secure Elements", "secure-elements", "lock"),
            ("Cryptographic Coprocessors", "crypto-coprocessors", "lock-key"),
            ("TPM (Trusted Platform Modules)", "tpm", "shield"),
            ("Hardware Encryption ICs", "hw-encryption", "key"),
            ("ID / Authentication ICs", "id-auth", "identification-card"),
        ],
    ),
    (
        "Automotive ICs",
        "automotive-ics",
        "car",
        [
            ("Automotive PMICs", "auto-pmics", "lightning"),
            ("CAN / LIN Automotive ICs", "auto-can-lin", "plugs"),
            ("ADAS Processing ICs", "adas", "cpu"),
            ("Automotive Sensors", "auto-sensors", "thermometer"),
            ("Infotainment Processors", "infotainment", "music-notes"),
        ],
    ),
    (
        "Display & LED ICs",
        "display-led-ics",
        "monitor",
        [
            ("LED Matrix Drivers", "led-matrix", "grid-four"),
            ("LCD Drivers", "lcd-drivers", "monitor"),
            ("OLED Drivers", "oled-drivers", "sparkle"),
            ("Backlight Controllers", "backlight", "sun-dim"),
            ("Display Timing Controllers (TCON)", "tcon", "timer"),
        ],
    ),
]

# ---------------------------------------------------------------------------
# SEO descriptions for the 15 parent categories — keyed by slug.
# Seeded onto Category.description for search-engine visibility.
# ---------------------------------------------------------------------------
CATEGORY_DESCRIPTIONS: dict[str, str] = {
    "power-management-ics-pmics": (
        "Power Management ICs (PMICs) regulate, convert, and distribute electrical power"
        " within electronic systems. This category covers linear voltage regulators (LDOs),"
        " DC-DC converters including buck and boost topologies, battery management ICs for"
        " single-cell and multi-cell packs, power supervisors with reset outputs, and LED"
        " driver ICs. Common applications span portable devices, industrial automation,"
        " automotive ECUs, and server power rails. Leading manufacturers include Texas"
        " Instruments, Analog Devices, Monolithic Power Systems, ON Semiconductor,"
        " and STMicroelectronics. Compare datasheets, pricing, and stock across"
        " authorized distributors on Circuits.com."
    ),
    "microcontrollers-processors": (
        "Microcontrollers and processors form the computational heart of embedded systems."
        " Browse 8-bit MCUs from Microchip and Renesas, 32-bit ARM Cortex-M devices from"
        " STMicroelectronics, NXP, and Infineon, application processors for Linux-class"
        " workloads, digital signal processors (DSPs) for real-time audio and motor control,"
        " and highly integrated systems-on-chip (SoCs) with built-in wireless such as the"
        " Espressif ESP32 family. These components power IoT nodes, wearables, robotics,"
        " automotive control modules, and consumer electronics. Compare prices and lead"
        " times from authorized distributors."
    ),
    "analog-ics": (
        "Analog ICs process continuous signals in amplification, filtering, and signal"
        " conditioning applications. This category includes operational amplifiers (op-amps)"
        " ranging from general-purpose to precision and low-noise grades, voltage comparators,"
        " analog multiplexers and switches, precision voltage references, and instrumentation"
        " amplifiers for sensor front-ends. Key manufacturers are Texas Instruments, Analog"
        " Devices, Maxim Integrated, Microchip, and ON Semiconductor. Use Circuits.com to"
        " compare specifications, unit pricing at volume, and real-time stock levels across"
        " major distributors."
    ),
    "interface-ics": (
        "Interface ICs bridge communication between processors, peripherals, and external"
        " networks. This section covers UART and USART transceivers for legacy serial links,"
        " USB controllers and bridges (FTDI, Silicon Labs), I2C and SPI bus expanders,"
        " CAN and LIN transceivers for automotive and industrial fieldbus networks, and"
        " bidirectional level shifters for mixed-voltage designs. These devices are essential"
        " in automotive ECUs, industrial PLCs, medical instruments, and consumer gadgets."
        " Manufacturers include Texas Instruments, Maxim Integrated, NXP, Microchip, and"
        " STMicroelectronics."
    ),
    "memory-ics": (
        "Memory ICs store data and instructions for microcontrollers, processors, and FPGAs."
        " Browse EEPROMs for configuration storage, NOR flash for execute-in-place firmware,"
        " NAND flash for high-density data logging, SRAM for low-latency cache and buffers,"
        " and DRAM for large working-memory pools. Leading suppliers include Micron, Samsung,"
        " Winbond, ISSI, Infineon, and Microchip. Circuits.com lets you compare pricing across"
        " package types, densities, and speed grades from dozens of authorized distributors"
        " worldwide."
    ),
    "logic-ics": (
        "Logic ICs implement fundamental digital building blocks used in virtually every"
        " electronic design. This category spans basic gates (AND, OR, NAND, NOR, XOR),"
        " flip-flops and latches for state storage, counters for timing and sequencing,"
        " shift registers for serial-to-parallel conversion, and programmable logic devices"
        " including CPLDs and FPGAs. Major manufacturers are Texas Instruments, NXP, ON"
        " Semiconductor, Lattice, and AMD-Xilinx. Compare pricing, package options, and"
        " stock availability from top distributors."
    ),
    "rf-wireless-ics": (
        "RF and wireless ICs enable radio communication across Bluetooth, Wi-Fi, LoRa,"
        " cellular, and custom ISM-band protocols. Browse Bluetooth Low Energy SoCs,"
        " Wi-Fi transceivers, sub-GHz RF transceivers for IoT, GPS and GNSS receiver"
        " modules, and NFC/RFID reader ICs. These components are critical for connected"
        " devices, asset tracking, smart home systems, and wearable health monitors."
        " Key suppliers include Nordic Semiconductor, Espressif, Texas Instruments, Silicon"
        " Labs, Semtech, and u-blox. Compare module specs, sensitivity, and pricing."
    ),
    "sensor-ics": (
        "Sensor ICs convert physical phenomena into electrical signals for measurement"
        " and control. This category includes temperature sensors (analog and digital),"
        " MEMS accelerometers, gyroscopes, and IMUs for motion sensing, barometric and"
        " differential pressure sensors, and proximity and ambient-light detectors."
        " Applications range from industrial process monitoring and automotive ADAS to"
        " consumer wearables and environmental monitoring stations. Leading manufacturers"
        " are Bosch Sensortec, Honeywell, STMicroelectronics, TDK InvenSense, and TE"
        " Connectivity."
    ),
    "audio-video-ics": (
        "Audio and video ICs handle signal amplification, encoding, decoding, and"
        " transmission for multimedia applications. Browse Class-D and Class-AB audio"
        " amplifiers, audio and video CODECs, video processing and scaling ICs, HDMI"
        " and DisplayPort interface controllers, and microphone preamplifiers with"
        " digital output. These devices power Bluetooth speakers, soundbars, conferencing"
        " systems, automotive infotainment, and professional AV equipment. Key manufacturers"
        " include Texas Instruments, Cirrus Logic, Analog Devices, Maxim Integrated, and"
        " Realtek."
    ),
    "clock-timing-ics": (
        "Clock and timing ICs generate, distribute, and synchronize reference frequencies"
        " throughout electronic systems. This category covers crystal oscillators and MEMS"
        " oscillators, real-time clock (RTC) modules with battery backup, programmable"
        " clock generators and buffers, phase-locked loops (PLLs) for frequency synthesis,"
        " and classic timer ICs like the 555. Applications include telecom base stations,"
        " data-center switches, GPS receivers, and precision instrumentation. Key"
        " manufacturers are Silicon Labs, Texas Instruments, Microchip, Maxim Integrated,"
        " and Renesas."
    ),
    "motor-motion-ics": (
        "Motor and motion control ICs drive DC, stepper, and brushless DC motors in"
        " industrial, automotive, and consumer applications. This section covers integrated"
        " H-bridge motor drivers, servo controller ICs, MOSFET and IGBT gate drivers for"
        " high-power switching, dedicated motion-control processors, and PWM controller ICs."
        " These components are essential for robotics, CNC machines, electric vehicles,"
        " HVAC blowers, and home appliances. Major manufacturers include Texas Instruments,"
        " STMicroelectronics, Infineon, ON Semiconductor, and Allegro MicroSystems."
    ),
    "data-conversion-ics": (
        "Data conversion ICs translate signals between the analog and digital domains."
        " Browse analog-to-digital converters (ADCs) from successive-approximation to"
        " delta-sigma architectures, digital-to-analog converters (DACs) for audio and"
        " precision output, sigma-delta modulators, voltage-to-frequency converters, and"
        " capacitive touchscreen controllers. These devices are critical in test and"
        " measurement equipment, audio interfaces, medical imaging, and industrial control"
        " loops. Leading suppliers are Analog Devices, Texas Instruments, Microchip, and"
        " Maxim Integrated."
    ),
    "security-auth-ics": (
        "Security and authentication ICs protect data, firmware, and hardware identity"
        " in connected devices. This category includes secure element chips for key"
        " storage, cryptographic coprocessors implementing AES, ECC, and RSA, trusted"
        " platform modules (TPMs) for platform integrity, hardware encryption engines,"
        " and ID/authentication ICs for accessory and consumable verification. These"
        " components are deployed in payment terminals, IoT edge nodes, automotive ECUs,"
        " and enterprise servers. Key manufacturers are Microchip, Infineon, NXP, STMicro,"
        " and Maxim Integrated."
    ),
    "automotive-ics": (
        "Automotive ICs meet the stringent reliability and temperature requirements of"
        " vehicle electronics (AEC-Q100/Q200 qualified). Browse automotive-grade PMICs,"
        " CAN and LIN transceivers for in-vehicle networking, ADAS processing ICs for"
        " radar, lidar, and camera fusion, automotive sensor interfaces, and infotainment"
        " processors. These devices are used in powertrain control, body electronics,"
        " driver assistance systems, and in-cabin entertainment. Major suppliers include"
        " NXP, Infineon, Texas Instruments, STMicroelectronics, Renesas, and ON Semiconductor."
    ),
    "display-led-ics": (
        "Display and LED driver ICs control screens and lighting arrays across consumer,"
        " industrial, and automotive applications. This category includes LED matrix"
        " drivers for signage and indicators, LCD segment and TFT drivers, OLED driver"
        " ICs for wearables and phones, backlight controller ICs with dimming support,"
        " and display timing controllers (TCONs) for panels. These components enable"
        " everything from smart-watch faces to automotive instrument clusters. Key"
        " manufacturers include Texas Instruments, Maxim Integrated, Solomon Systech,"
        " Rohm, and STMicroelectronics."
    ),
}


def get_or_create_supplier(
    db: Session,
    name: str,
    phone: str | None = None,
    website: str | None = None,
    email: str | None = None,
    description: str | None = None,
    logo_url: str | None = None,
    contact_name: str | None = None,
) -> Supplier:
    obj = db.query(Supplier).filter(Supplier.name == name).first()
    if obj is None:
        obj = Supplier(
            name=name,
            phone=phone,
            website=website,
            email=email,
            description=description,
            logo_url=logo_url,
            contact_name=contact_name,
        )
        db.add(obj)
        db.flush()
    return obj


def get_or_create_category_supplier(
    db: Session,
    category: Category,
    supplier: Supplier,
    is_featured: bool = False,
    rank: int = 0,
) -> CategorySupplier:
    obj = (
        db.query(CategorySupplier)
        .filter(
            CategorySupplier.category_id == category.id,
            CategorySupplier.supplier_id == supplier.id,
        )
        .first()
    )
    if obj is None:
        obj = CategorySupplier(
            category_id=category.id,
            supplier_id=supplier.id,
            is_featured=is_featured,
            rank=rank,
        )
        db.add(obj)
        db.flush()
    return obj


def get_or_create_sponsor(
    db: Session,
    supplier: Supplier,
    category: Category | None = None,
    keyword: str | None = None,
    image_url: str | None = None,
    description: str | None = None,
    tier: str = "gold",
) -> Sponsor:
    query = db.query(Sponsor).filter(Sponsor.supplier_id == supplier.id)
    if category is not None:
        query = query.filter(Sponsor.category_id == category.id)
    elif keyword is not None:
        query = query.filter(Sponsor.keyword == keyword)
    obj = query.first()
    if obj is None:
        obj = Sponsor(
            supplier_id=supplier.id,
            category_id=category.id if category else None,
            keyword=keyword,
            image_url=image_url,
            description=description,
            tier=tier,
        )
        db.add(obj)
        db.flush()
    return obj


# ---------------------------------------------------------------------------
# Main seed function
# ---------------------------------------------------------------------------


def seed(db: Session) -> None:
    # ------------------------------------------------------------------
    # 1. Categories and subcategories — driven by module-level CATEGORY_DATA
    # ------------------------------------------------------------------
    # Slugs are EXPLICIT per row (canonical with ui_kits/website/data.js);
    # see CATEGORY_DATA's docstring. cats dict is keyed by NAME for both
    # top-level and subcategory rows so _DEMO_CATALOG can look up via the
    # subcategory name without ambiguity.
    cats: dict[str, Category] = {}
    for sort_order, (name, slug, icon, subs) in enumerate(CATEGORY_DATA):
        cat = get_or_create_category(db, name, slug, icon=icon, sort_order=sort_order)
        if slug in CATEGORY_DESCRIPTIONS and not cat.description:
            cat.description = CATEGORY_DESCRIPTIONS[slug]
            db.flush()
        cats[name] = cat
        for sub_order, (sub_name, sub_slug, sub_icon) in enumerate(subs):
            sub = get_or_create_category(
                db, sub_name, sub_slug, icon=sub_icon, parent=cat, sort_order=sub_order
            )
            cats[sub_name] = sub

    # ------------------------------------------------------------------
    # 2. Suppliers
    # ------------------------------------------------------------------
    # ---- Demo / smoke-test suppliers (pre-existing) ----
    _demo_suppliers: list[dict] = [
        dict(
            name="Kennedy Electronics",
            phone="631-555-5555",
            website="kennedyelectronics.com",
            email="info@kennedyelectronics.com",
            description="Semiconductor supplier based in Smithtown, NY",
        ),
        dict(
            name="Honeywell Sensing",
            phone="800-537-6945",
            website="automation.honeywell.com",
            email="sensing@honeywell.com",
            description="Global sensing and IoT solutions manufacturer",
        ),
        dict(
            name="Oneonta Electronics",
            phone="16314950445",
            website="www.electronics.com",
            email="abc@oneontaelectronics.com",
            description="Leftly",
            contact_name="Ed Pitlack",
        ),
        dict(
            name="Thunder Electronics",
            phone="631 472-1592",
            email="Jedi4425@gmail.com",
            contact_name="John King",
        ),
        dict(
            name="States Electronics",
            phone="5555551212",
            website="https://www.tesla.com",
            email="blue@gmail.com",
            description="none",
            contact_name="John Romano",
        ),
        dict(
            name="Mike's Electric",
            phone="16317086040",
            website="www.circuits.com",
            email="1859charlesdarwin@gmail.com",
            description="Helloooooooooooo",
        ),
        dict(
            name="Jo Jo's Circuits Circus",
            phone="16317086040",
            website="www.espn.com",
            email="1859charlesdarwin@gmail.com",
            description="A Circus of Circuits.",
        ),
    ]

    # ---- Real distributors (user's top-50 list + existing broad-line) ----
    _real_suppliers: list[dict] = [
        dict(
            name="Digi-Key Electronics",
            phone="800-344-4539",
            website="digikey.com",
            email="sales@digikey.com",
            description="Leading global electronic components distributor, 13.4M+ products in stock",
        ),
        dict(
            name="Mouser Electronics",
            phone="800-346-6873",
            website="mouser.com",
            email="sales@mouser.com",
            description="Global authorized distributor, 6.8M+ products from 1,200+ manufacturers",
        ),
        dict(
            name="Arrow Electronics",
            phone="800-777-2776",
            website="arrow.com",
            email="info@arrow.com",
            description="Global provider of electronic components and enterprise computing solutions",
        ),
        dict(
            name="Avnet",
            phone="480-643-2000",
            website="avnet.com",
            email="info@avnet.com",
            description="Global electronic components distributor and technology solutions provider",
        ),
        dict(
            name="TTI",
            phone="800-888-8884",
            website="ttiinc.com",
            email="sales@ttiinc.com",
            description="Specialist distributor of passive, connector, electromechanical, and discrete components",
        ),
        dict(
            name="Future Electronics",
            phone="800-388-8731",
            website="futureelectronics.com",
            email="info@futureelectronics.com",
            description="Global distributor of electronic components, full-service solutions",
        ),
        dict(
            name="Newark",
            phone="800-463-9275",
            website="newark.com",
            email="sales@newark.com",
            description="Broad-line distributor of electronic and industrial components, an Avnet company",
        ),
        dict(
            name="Farnell",
            phone="+44-330-587-1000",
            website="farnell.com",
            email="sales@farnell.com",
            description="European broad-line distributor of electronic components, an Avnet company",
        ),
        dict(
            name="RS",
            phone="+44-1536-444000",
            website="rs-online.com",
            email="sales@rs-online.com",
            description="Global distributor of electronics, electrical, and industrial components",
        ),
        dict(
            name="RS Americas",
            phone="866-433-5722",
            website="us.rs-online.com",
            email="sales@rsamericas.com",
            description="RS Group Americas division, formerly Allied Electronics & Automation",
        ),
        dict(
            name="RS APAC",
            phone="+65-6214-9933",
            website="rs-online.com",
            email="sales@rs-apac.com",
            description="RS Group Asia-Pacific division, broad-line distribution",
        ),
        dict(
            name="element14 APAC",
            phone="+65-6877-8787",
            website="element14.com",
            email="sales@element14.com",
            description="Asia-Pacific electronics distributor, a Premier Farnell / Avnet company",
        ),
        dict(
            name="DigiKey Marketplace",
            phone="800-344-4539",
            website="digikey.com/marketplace",
            email="marketplace@digikey.com",
            description="Third-party seller platform on Digi-Key for specialty and surplus components",
        ),
        dict(
            name="TME",
            phone="+48-42-235-9000",
            website="tme.eu",
            email="sales@tme.eu",
            description="Transfer Multisort Elektronik, major European electronic components distributor",
        ),
        dict(
            name="Conrad",
            phone="+49-9604-40-8787",
            website="conrad.com",
            email="info@conrad.com",
            description="European electronics and technology distributor based in Germany",
        ),
        dict(
            name="Distrelec",
            phone="+41-44-944-9911",
            website="distrelec.com",
            email="info@distrelec.com",
            description="Northern European high-service electronic components distributor",
        ),
        dict(
            name="Anglia",
            phone="+44-1945-474747",
            website="anglia-live.com",
            email="sales@anglia.com",
            description="UK-based electronic components distributor, strong in automotive and industrial",
        ),
        dict(
            name="Avnet Abacus",
            phone="+49-8121-777-02",
            website="avnet.com",
            email="abacus@avnet.com",
            description="Avnet European passive, interconnect, and electromechanical division",
        ),
        dict(
            name="Avnet Silica",
            phone="+49-8121-777-01",
            website="avnet.com",
            email="silica@avnet.com",
            description="Avnet European semiconductor distribution division",
        ),
        dict(
            name="EBV Elektronik",
            phone="+49-8121-774-0",
            website="ebv.com",
            email="info@ebv.com",
            description="European semiconductor specialist distributor, an Avnet company",
        ),
        dict(
            name="CoreStaff",
            phone="+81-3-3514-8400",
            website="corestaff.co.jp",
            email="info@corestaff.co.jp",
            description="Japanese electronic components distributor for the Asia-Pacific market",
        ),
        dict(
            name="Electro Sonic",
            phone="800-563-4795",
            website="e-sonic.com",
            email="sales@e-sonic.com",
            description="Canadian electronic components distributor, broad-line inventory",
        ),
        dict(
            name="TTI Asia",
            phone="+852-2375-2722",
            website="ttiasia.com",
            email="sales@ttiasia.com",
            description="TTI Asia-Pacific division specializing in passives, connectors, and discretes",
        ),
        dict(
            name="TTI Europe",
            phone="+49-8141-6102-0",
            website="ttieurope.com",
            email="sales@ttieurope.com",
            description="TTI European division, passive and connector specialist",
        ),
        dict(
            name="Heilind Europe",
            phone="+49-89-904-802-0",
            website="heilind.eu",
            email="sales@heilind.eu",
            description="European interconnect and electromechanical specialist distributor",
        ),
        dict(
            name="Galco",
            phone="800-575-5562",
            website="galco.com",
            email="sales@galco.com",
            description="Industrial electronics and automation distributor based in Madison Heights, MI",
        ),
        dict(
            name="Sager Electronics",
            phone="800-724-3780",
            website="sager.com",
            email="sales@sager.com",
            description="North American power and electromechanical components distributor",
        ),
        dict(
            name="Sager Power Systems",
            phone="800-724-3780",
            website="sager.com/power-systems",
            email="power@sager.com",
            description="Sager division specializing in power supplies, converters, and UPS systems",
        ),
        dict(
            name="Master Electronics",
            phone="800-346-6873",
            website="masterelectronics.com",
            email="sales@masterelectronics.com",
            description="Broad-line distributor specializing in mil-spec and hard-to-find components",
        ),
        dict(
            name="RFMW",
            phone="408-414-1450",
            website="rfmw.com",
            email="sales@rfmw.com",
            description="RF, microwave, and millimeter-wave component specialty distributor",
        ),
        dict(
            name="Richardson RFPD",
            phone="800-737-6937",
            website="richardsonrfpd.com",
            email="sales@richardsonrfpd.com",
            description="RF, wireless, power, and IoT specialty distributor, an Arrow company",
        ),
        dict(
            name="Pasternack",
            phone="949-261-1920",
            website="pasternack.com",
            email="sales@pasternack.com",
            description="RF, microwave, and millimeter-wave connector and component specialist",
        ),
        dict(
            name="PEI-Genesis",
            phone="800-734-4363",
            website="peigenesis.com",
            email="sales@peigenesis.com",
            description="Connector specialist: mil-spec, industrial, harsh-environment interconnect",
        ),
        dict(
            name="Powell Electronics",
            phone="800-235-7880",
            website="powellelectronics.com",
            email="sales@powellelectronics.com",
            description="Connector and relay specialist distributor for mil/aero and industrial",
        ),
        dict(
            name="FDH Electronics",
            phone="800-966-1014",
            website="fdhelectronics.com",
            email="sales@fdhelectronics.com",
            description="Military, aerospace, and hi-rel electronic components distributor",
        ),
        dict(
            name="Carlton-Bates",
            phone="800-643-7195",
            website="carlton-bates.com",
            email="sales@carlton-bates.com",
            description="Interconnect and passive component distributor, a Sonepar company",
        ),
        dict(
            name="Hawk Electronics",
            phone="800-432-7150",
            website="hawkelectronics.com",
            email="sales@hawkelectronics.com",
            description="Regional authorized distributor focused on design-in support",
        ),
        dict(
            name="Hisco",
            phone="800-444-7261",
            website="hisco.com",
            email="sales@hisco.com",
            description="Industrial and electronic supply distributor, adhesives and specialty materials",
        ),
        dict(
            name="IEC Supply",
            phone="800-323-3242",
            website="iecsupply.com",
            email="sales@iecsupply.com",
            description="Industrial and electronic component supply distributor",
        ),
        dict(
            name="MRO Supply",
            phone="800-541-3120",
            website="mrosupply.com",
            email="sales@mrosupply.com",
            description="Maintenance, repair, and operations supply distributor for industrial electronics",
        ),
        dict(
            name="Verical",
            phone="480-308-7004",
            website="verical.com",
            email="sales@verical.com",
            description="Online marketplace for electronic components, an Arrow Electronics company",
        ),
        dict(
            name="Onlinecomponents.com",
            phone="800-778-2028",
            website="onlinecomponents.com",
            email="sales@onlinecomponents.com",
            description="Authorized online distributor for electronic connectors and components",
        ),
        dict(
            name="Walker Industrial",
            phone="800-879-2553",
            website="walkerindustrial.com",
            email="sales@walkerindustrial.com",
            description="Electrical and industrial automation distributor",
        ),
        dict(
            name="Zoro",
            phone="855-289-9676",
            website="zoro.com",
            email="sales@zoro.com",
            description="Online industrial and electronic supply distributor, a Grainger company",
        ),
        dict(
            name="Tequipment",
            phone="800-832-4866",
            website="tequipment.net",
            email="sales@tequipment.net",
            description="Test and measurement equipment distributor",
        ),
        dict(
            name="TSI Solutions",
            phone="800-874-2004",
            website="tsisolutions.us",
            email="sales@tsisolutions.us",
            description="Electronic and electromechanical component distributor",
        ),
        dict(
            name="Omnical",
            phone="+1-514-336-3070",
            website="omnical.com",
            email="sales@omnical.com",
            description="Canadian electronic components distributor",
        ),
        dict(
            name="Airline Hydraulics",
            phone="800-999-7378",
            website="airlinehyd.com",
            email="sales@airlinehyd.com",
            description="Fluid power and motion control distributor with electronic sensing products",
        ),
        dict(
            name="Analog Devices",
            phone="781-329-4700",
            website="analog.com",
            email="sales@analog.com",
            description="Semiconductor manufacturer with direct sales of precision analog, mixed-signal, and DSP ICs",
        ),
        dict(
            name="Microchip Direct",
            phone="800-262-1640",
            website="microchipdirect.com",
            email="sales@microchipdirect.com",
            description="Factory-direct sales of Microchip MCUs, analog, FPGA, and connectivity ICs",
        ),
    ]

    supplier_data: list[dict] = _demo_suppliers + _real_suppliers

    suppliers: dict[str, Supplier] = {}
    for data in supplier_data:
        sup = get_or_create_supplier(db, **data)
        suppliers[data["name"]] = sup

    avnet = suppliers["Avnet"]
    digikey = suppliers["Digi-Key Electronics"]
    tti = suppliers["TTI"]
    future = suppliers["Future Electronics"]
    kennedy = suppliers["Kennedy Electronics"]
    mouser = suppliers["Mouser Electronics"]
    arrow = suppliers["Arrow Electronics"]
    honeywell = suppliers["Honeywell Sensing"]

    # ------------------------------------------------------------------
    # 3. CategorySupplier associations
    # ------------------------------------------------------------------
    # Every top-level category gets 3-5 suppliers.
    # Kennedy Electronics is featured in PMICs and Microcontrollers.

    # Power Management ICs — Kennedy featured
    pmic = cats["Power Management ICs (PMICs)"]
    for sup, featured, rank in [
        (kennedy, True, 1),
        (digikey, False, 2),
        (mouser, False, 3),
        (avnet, False, 4),
        (arrow, False, 5),
    ]:
        get_or_create_category_supplier(db, pmic, sup, is_featured=featured, rank=rank)

    # Kennedy featured in PMIC subcategories
    for sub_name in [
        "Voltage Regulators (LDOs)",
        "DC-DC Converters (Buck/Boost)",
        "Battery Management ICs (BMS)",
        "Power Supervisors / Reset ICs",
        "LED Drivers",
    ]:
        sub_cat = cats[sub_name]
        get_or_create_category_supplier(db, sub_cat, kennedy, is_featured=True, rank=1)
        get_or_create_category_supplier(db, sub_cat, digikey, is_featured=False, rank=2)
        get_or_create_category_supplier(db, sub_cat, mouser, is_featured=False, rank=3)

    # Microcontrollers & Processors — Kennedy featured
    mcu = cats["Microcontrollers & Processors"]
    for sup, featured, rank in [
        (kennedy, True, 1),
        (digikey, False, 2),
        (mouser, False, 3),
        (arrow, False, 4),
    ]:
        get_or_create_category_supplier(db, mcu, sup, is_featured=featured, rank=rank)

    # Analog ICs
    analog = cats["Analog ICs"]
    for sup, rank in [(digikey, 1), (mouser, 2), (avnet, 3), (arrow, 4)]:
        get_or_create_category_supplier(db, analog, sup, rank=rank)

    # Interface ICs
    interface = cats["Interface ICs"]
    for sup, rank in [(digikey, 1), (mouser, 2), (avnet, 3), (tti, 4)]:
        get_or_create_category_supplier(db, interface, sup, rank=rank)

    # Memory ICs
    memory = cats["Memory ICs"]
    for sup, rank in [(avnet, 1), (arrow, 2), (future, 3), (digikey, 4)]:
        get_or_create_category_supplier(db, memory, sup, rank=rank)

    # Logic ICs
    logic = cats["Logic ICs"]
    for sup, rank in [(digikey, 1), (mouser, 2), (avnet, 3), (arrow, 4)]:
        get_or_create_category_supplier(db, logic, sup, rank=rank)

    # RF & Wireless ICs
    rf = cats["RF & Wireless ICs"]
    for sup, rank in [(mouser, 1), (digikey, 2), (avnet, 3), (arrow, 4)]:
        get_or_create_category_supplier(db, rf, sup, rank=rank)

    # Sensor ICs
    sensor = cats["Sensor ICs"]
    for sup, rank in [(digikey, 1), (mouser, 2), (avnet, 3), (tti, 4), (honeywell, 5)]:
        get_or_create_category_supplier(db, sensor, sup, rank=rank)

    # Audio & Video ICs
    av = cats["Audio & Video ICs"]
    for sup, rank in [(digikey, 1), (mouser, 2), (future, 3), (arrow, 4)]:
        get_or_create_category_supplier(db, av, sup, rank=rank)

    # Clock & Timing ICs
    clock = cats["Clock & Timing ICs"]
    for sup, rank in [(digikey, 1), (mouser, 2), (avnet, 3), (tti, 4)]:
        get_or_create_category_supplier(db, clock, sup, rank=rank)

    # Motor & Motion Control ICs
    motor = cats["Motor & Motion Control ICs"]
    for sup, rank in [(avnet, 1), (arrow, 2), (digikey, 3), (tti, 4)]:
        get_or_create_category_supplier(db, motor, sup, rank=rank)

    # Data Conversion ICs
    dataconv = cats["Data Conversion ICs"]
    for sup, rank in [(digikey, 1), (mouser, 2), (avnet, 3), (arrow, 4)]:
        get_or_create_category_supplier(db, dataconv, sup, rank=rank)

    # Security & Authentication ICs
    security = cats["Security & Authentication ICs"]
    for sup, rank in [(avnet, 1), (digikey, 2), (mouser, 3), (future, 4)]:
        get_or_create_category_supplier(db, security, sup, rank=rank)

    # Automotive ICs
    auto = cats["Automotive ICs"]
    for sup, rank in [(avnet, 1), (arrow, 2), (future, 3), (digikey, 4)]:
        get_or_create_category_supplier(db, auto, sup, rank=rank)

    # Display & LED ICs
    display = cats["Display & LED ICs"]
    for sup, rank in [(digikey, 1), (mouser, 2), (arrow, 3), (avnet, 4)]:
        get_or_create_category_supplier(db, display, sup, rank=rank)

    # ------------------------------------------------------------------
    # 4. Sponsors
    # ------------------------------------------------------------------
    # Kennedy Electronics — gold sponsor for "Power Management ICs (PMICs)"
    get_or_create_sponsor(
        db,
        supplier=kennedy,
        category=cats["Power Management ICs (PMICs)"],
        image_url="/images/sponsors/kennedy.jpg",
        description="Your premier semiconductor supplier in the Northeast",
        tier="gold",
    )

    # Avnet — silver sponsor for keyword "capacitors"
    get_or_create_sponsor(
        db,
        supplier=avnet,
        keyword="capacitors",
        image_url="/images/sponsors/avnet.jpg",
        description="Industry-leading capacitor selection",
        tier="silver",
    )

    db.commit()
    print("Seed: categories, suppliers, sponsors done.")

    # ------------------------------------------------------------------
    # 5. Admin user
    # ------------------------------------------------------------------
    _seed_admin_user(db)

    # ------------------------------------------------------------------
    # 6. Demo parts (59 synthetic entries)
    # ------------------------------------------------------------------
    _seed_parts(db, cats, suppliers)

    # ------------------------------------------------------------------
    # 7. Real catalog from JSON data files
    # ------------------------------------------------------------------
    _seed_real_catalog(db, cats, suppliers)

    # ------------------------------------------------------------------
    # 8. Revenue placeholder data (12 months)
    # ------------------------------------------------------------------
    _seed_revenue(db, suppliers)

    db.commit()
    print("Seed completed successfully.")


# ---------------------------------------------------------------------------
# Admin user
# ---------------------------------------------------------------------------


def _seed_admin_user(db: Session) -> None:
    admin_users = [
        ("matthew", "admin"),
        ("mike", "admin"),
        ("john", "admin"),
    ]
    created = 0
    for username, password in admin_users:
        existing = db.query(User).filter(User.username == username).first()
        if existing:
            continue
        hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
        db.add(User(username=username, password_hash=hashed, role="admin"))
        created += 1
    db.flush()
    if created:
        print(f"Seed: {created} admin user(s) created.")


# ---------------------------------------------------------------------------
# Parts and listings
# ---------------------------------------------------------------------------

# Realistic IC part numbers keyed by the EXACT subcategory name (matches the
# entries in `category_data` above). This drives per-subcategory placement
# so /category/<sub-slug> pages show the parts that belong there, and the
# PartPage breadcrumb resolves a full Parent → Subcategory → SKU lineage.
#
# 2026-05-16: switched from top-level keys ("Power Management", "Sensor"…)
# to subcategory keys. The old layout placed all 59 parts on top-level
# categories, leaving every subcategory page empty.
_DEMO_CATALOG: list[tuple[str, list[tuple[str, str, str]]]] = [
    # Power Management ICs (PMICs)
    (
        "Voltage Regulators (LDOs)",
        [
            ("LM7805CT", "Texas Instruments", "5V 1.5A Linear Voltage Regulator"),
            ("LT3045", "Analog Devices", "20V 500mA Ultralow Noise LDO"),
        ],
    ),
    (
        "DC-DC Converters (Buck/Boost)",
        [
            ("TPS65217C", "Texas Instruments", "Power Management IC for AM335x"),
            ("MP2307DN", "Monolithic Power", "3A 23V Step-Down Converter"),
        ],
    ),
    (
        "Battery Management ICs (BMS)",
        [
            ("BQ24195", "Texas Instruments", "4.5A Single-Cell USB Charger IC"),
        ],
    ),
    # Microcontrollers & Processors
    (
        "32-bit Microcontrollers (ARM Cortex-M)",
        [
            ("STM32F407VGT6", "STMicroelectronics", "ARM Cortex-M4 168MHz MCU"),
            ("RP2040", "Raspberry Pi", "Dual-Core ARM Cortex-M0+ MCU"),
        ],
    ),
    (
        "8-bit Microcontrollers",
        [
            ("ATMEGA328P-PU", "Microchip", "8-bit AVR MCU 32KB Flash"),
            ("PIC18F4550", "Microchip", "USB 2.0 Full-Speed MCU"),
        ],
    ),
    (
        "System-on-Chip (SoC)",
        [
            ("ESP32-WROOM-32E", "Espressif", "Wi-Fi+BT MCU Module"),
        ],
    ),
    # Analog ICs
    (
        "Operational Amplifiers (Op-Amps)",
        [
            ("LM358N", "Texas Instruments", "Dual Operational Amplifier"),
            ("OPA2134PA", "Texas Instruments", "Audio Dual Op-Amp"),
            ("MCP6002", "Microchip", "1MHz Low-Power Dual Op-Amp"),
        ],
    ),
    (
        "Instrumentation Amplifiers",
        [
            ("AD8221ARZ", "Analog Devices", "Precision Instrumentation Amplifier"),
        ],
    ),
    (
        "Comparators",
        [
            ("LM393N", "Texas Instruments", "Dual Differential Comparator"),
        ],
    ),
    # Interface ICs
    (
        "UART / USART Transceivers",
        [
            ("MAX232CPE", "Maxim Integrated", "Dual RS-232 Driver/Receiver"),
        ],
    ),
    (
        "USB Interface ICs",
        [
            ("FT232RL", "FTDI", "USB to Serial UART IC"),
            ("CP2102N", "Silicon Labs", "USB to UART Bridge Controller"),
        ],
    ),
    (
        "CAN / LIN Transceivers",
        [
            ("SN65HVD230", "Texas Instruments", "3.3V CAN Bus Transceiver"),
        ],
    ),
    (
        "Level Shifters",
        [
            ("TXB0108PWR", "Texas Instruments", "8-Bit Bidirectional Level Shifter"),
        ],
    ),
    # Memory ICs
    (
        "EEPROM",
        [
            ("AT24C256", "Microchip", "256Kbit I2C Serial EEPROM"),
        ],
    ),
    (
        "NOR Flash",
        [
            ("W25Q128JV", "Winbond", "128Mbit Serial NOR Flash"),
            ("S25FL512S", "Infineon", "512Mbit SPI NOR Flash"),
        ],
    ),
    (
        "SRAM",
        [
            ("IS62WV25616", "ISSI", "256K x 16 High-Speed SRAM"),
        ],
    ),
    (
        "DRAM",
        [
            ("MT48LC16M16A2", "Micron", "256Mbit SDRAM"),
        ],
    ),
    # Logic ICs
    (
        "Logic Gates (AND, OR, NOT, etc.)",
        [
            ("SN74LS00N", "Texas Instruments", "Quad 2-Input NAND Gate"),
            ("74HC245", "NXP", "Octal Bus Transceiver"),
            ("SN74HC138N", "Texas Instruments", "3-to-8 Line Decoder"),
        ],
    ),
    (
        "Shift Registers",
        [
            ("SN74HC595N", "Texas Instruments", "8-Bit Shift Register"),
        ],
    ),
    (
        "Counters",
        [
            ("CD4017BE", "Texas Instruments", "Decade Counter/Divider"),
        ],
    ),
    # RF & Wireless ICs
    (
        "Bluetooth ICs",
        [
            ("CC2541F256", "Texas Instruments", "Bluetooth Low Energy SoC"),
        ],
    ),
    (
        "RF Transceivers",
        [
            ("SI4463", "Silicon Labs", "High-Performance RF Transceiver"),
            ("NRF24L01P", "Nordic Semi", "2.4GHz RF Transceiver"),
            ("SX1276", "Semtech", "LoRa Long Range Transceiver"),
        ],
    ),
    (
        "GPS / GNSS Receivers",
        [
            ("UBLOX-NEO-6M", "u-blox", "GPS Receiver Module"),
        ],
    ),
    # Sensor ICs
    (
        "Temperature Sensors",
        [
            ("LM35DZ", "Texas Instruments", "Precision Temperature Sensor"),
            ("HIH6130-021-001", "Honeywell", "HumidIcon Digital Humidity/Temp Sensor"),
            ("HIH7120-021-001", "Honeywell", "HumidIcon Low-Power Humidity Sensor"),
        ],
    ),
    (
        "Accelerometers",
        [
            ("MPU6050", "InvenSense", "6-Axis Accelerometer + Gyroscope"),
            ("ADXL345", "Analog Devices", "3-Axis Digital Accelerometer"),
        ],
    ),
    (
        "Pressure Sensors",
        [
            ("BME280", "Bosch", "Humidity/Pressure/Temperature Sensor"),
            ("BMP390", "Bosch", "High-Performance Barometric Pressure Sensor"),
            ("MPRLS0025PA00001A", "Honeywell", "MicroPressure 25 PSI Absolute I2C Sensor"),
            ("MPRLS0015PA0000SAB", "Honeywell", "MicroPressure 15 PSI Abs SPI Breakout Board"),
            ("MPRLS0300YG00001BB", "Honeywell", "MicroPressure 300mmHg Gage I2C Breakout"),
            ("ASDXRRX015PGAA5", "Honeywell", "Amplified 15 PSI Gage Pressure Sensor"),
            ("SSCDANN015PGAA5", "Honeywell", "TruStability 15 PSI Digital Pressure Sensor"),
            ("ABPDANT015PGAA5", "Honeywell", "Basic Board Mount 15 PSI Pressure Sensor"),
            ("HSC-SANN015PG2A3", "Honeywell", "High Accuracy Compensated 15 PSI Pressure"),
        ],
    ),
    # Audio & Video ICs
    (
        "Audio Amplifiers",
        [
            ("MAX98357A", "Maxim Integrated", "I2S Class D Mono Amplifier"),
            ("TPA3116D2", "Texas Instruments", "50W Stereo Class-D Amplifier"),
        ],
    ),
    (
        "CODECs (Audio/Video)",
        [
            ("WM8731", "Cirrus Logic", "Portable Internet Audio CODEC"),
            ("PCM5102A", "Texas Instruments", "32-bit 384kHz DAC"),
        ],
    ),
    (
        "Microphone Preamplifiers",
        [
            ("ICS43434", "TDK", "Multi-Mode Digital Microphone"),
        ],
    ),
    # Clock & Timing ICs
    (
        "Real-Time Clocks (RTC)",
        [
            ("DS3231SN", "Maxim Integrated", "Extremely Accurate RTC"),
            ("DS1307Z", "Maxim Integrated", "64 x 8 Serial RTC"),
        ],
    ),
    (
        "Clock Generators",
        [
            ("SI5351A", "Silicon Labs", "I2C Programmable Clock Generator"),
            ("LMK00105", "Texas Instruments", "1:5 LVCMOS Clock Buffer"),
        ],
    ),
    (
        "Timer ICs",
        [
            ("NE555P", "Texas Instruments", "Precision Timer IC"),
        ],
    ),
]


def _seed_parts(
    db: Session,
    cats: dict[str, Category],
    suppliers: dict[str, Supplier],
) -> None:
    if db.query(Part).first():
        return

    random.seed(42)  # reproducible placeholder data
    supplier_list = list(suppliers.values())

    for subcategory_name, parts_data in _DEMO_CATALOG:
        # Exact-match lookup against the subcategory's own name. The cats
        # dict is keyed by name for both top-level and child rows, so this
        # resolves directly to the subcategory we want — no parent_id filter,
        # no substring matching ambiguity.
        target_cat = cats.get(subcategory_name)
        if target_cat is None:
            raise RuntimeError(
                f"_DEMO_CATALOG references unknown subcategory '{subcategory_name}'. "
                f"Update category_data or fix the typo."
            )

        for sku, manufacturer, description in parts_data:
            part = Part(
                sku=sku,
                slug=slugify_sku(sku),
                description=description,
                manufacturer_name=manufacturer,
                category_id=target_cat.id,
            )
            db.add(part)
            db.flush()

            # 2-4 distributor listings per part
            num_listings = random.randint(2, 4)
            chosen_suppliers = random.sample(supplier_list, min(num_listings, len(supplier_list)))
            for sup in chosen_suppliers:
                base_price = Decimal(str(round(random.uniform(0.15, 45.00), 4)))
                listing = PartListing(
                    part_id=part.id,
                    supplier_id=sup.id,
                    sku=f"{sup.name[:3].upper()}-{sku}",
                    stock_quantity=random.randint(0, 50000),
                    lead_time_days=random.choice([0, 1, 3, 7, 14, 21]),
                    unit_price=base_price,
                )
                db.add(listing)
                db.flush()

                # Price breaks: qty 10, 100, 1000
                for qty, discount in [(10, 0.95), (100, 0.85), (1000, 0.70)]:
                    db.add(
                        PriceBreak(
                            listing_id=listing.id,
                            min_quantity=qty,
                            unit_price=Decimal(str(round(float(base_price) * discount, 4))),
                        )
                    )

    db.flush()
    print(
        f"Seed: {db.query(Part).count()} parts, {db.query(PartListing).count()} listings created."
    )


# ---------------------------------------------------------------------------
# Real catalog from JSON files
# ---------------------------------------------------------------------------

# Distributor tiers — determines which suppliers get listings for which
# category families. "broad" distributors carry everything; specialty
# distributors only carry their mapped category slugs.
_DISTRIBUTOR_TIERS: dict[str, list[str] | str] = {
    "Digi-Key Electronics": "broad",
    "Mouser Electronics": "broad",
    "Arrow Electronics": "broad",
    "Avnet": "broad",
    "Newark": "broad",
    "Farnell": "broad",
    "RS": "broad",
    "RS Americas": "broad",
    "element14 APAC": "broad",
    "Future Electronics": "broad",
    "TME": "broad",
    "Conrad": "broad",
    "Distrelec": "broad",
    "Anglia": "broad",
    "Avnet Abacus": "broad",
    "Avnet Silica": "broad",
    "EBV Elektronik": "broad",
    "CoreStaff": "broad",
    "Electro Sonic": "broad",
    "TTI": "broad",
    "TTI Asia": "broad",
    "TTI Europe": "broad",
    "Master Electronics": "broad",
    "Verical": "broad",
    "DigiKey Marketplace": "broad",
    "Onlinecomponents.com": "broad",
    "Omnical": "broad",
    "RFMW": ["rf-wireless-ics"],
    "Richardson RFPD": ["rf-wireless-ics", "power-management-ics-pmics"],
    "Pasternack": ["rf-wireless-ics"],
    "PEI-Genesis": ["interface-ics", "automotive-ics"],
    "Powell Electronics": ["interface-ics", "automotive-ics", "motor-motion-ics"],
    "Heilind Europe": ["interface-ics", "sensor-ics", "automotive-ics"],
    "Galco": ["power-management-ics-pmics", "motor-motion-ics", "sensor-ics"],
    "Sager Electronics": ["power-management-ics-pmics", "motor-motion-ics", "sensor-ics"],
    "Sager Power Systems": ["power-management-ics-pmics"],
    "Carlton-Bates": ["interface-ics", "sensor-ics"],
    "FDH Electronics": [
        "memory-ics",
        "logic-ics",
        "microcontrollers-processors",
        "data-conversion-ics",
    ],
    "Hawk Electronics": ["analog-ics", "power-management-ics-pmics", "microcontrollers-processors"],
    "Walker Industrial": ["motor-motion-ics", "sensor-ics", "power-management-ics-pmics"],
    "MRO Supply": ["sensor-ics", "motor-motion-ics"],
    "Zoro": ["sensor-ics", "motor-motion-ics"],
    "Hisco": ["sensor-ics"],
    "IEC Supply": ["power-management-ics-pmics", "sensor-ics"],
    "Tequipment": ["data-conversion-ics", "sensor-ics"],
    "TSI Solutions": ["power-management-ics-pmics", "motor-motion-ics"],
    "Airline Hydraulics": ["sensor-ics"],
    "Analog Devices": [
        "analog-ics",
        "data-conversion-ics",
        "power-management-ics-pmics",
        "sensor-ics",
    ],
    "Microchip Direct": [
        "microcontrollers-processors",
        "analog-ics",
        "memory-ics",
        "interface-ics",
    ],
}

# Stock magnitude by distributor size
_STOCK_TIERS: dict[str, tuple[int, int]] = {
    "Digi-Key Electronics": (5000, 150000),
    "Mouser Electronics": (3000, 120000),
    "Arrow Electronics": (5000, 200000),
    "Avnet": (5000, 200000),
    "Newark": (2000, 80000),
    "Farnell": (2000, 80000),
    "RS": (1000, 60000),
    "Future Electronics": (3000, 100000),
    "TME": (2000, 100000),
}
_DEFAULT_STOCK = (500, 30000)


def _eligible_suppliers(
    suppliers: dict[str, Supplier],
    parent_slug: str,
) -> list[Supplier]:
    """Return suppliers eligible to carry parts in a given top-level category."""
    eligible = []
    for name, sup in suppliers.items():
        tier = _DISTRIBUTOR_TIERS.get(name)
        if tier is None:
            continue
        if tier == "broad" or parent_slug in tier:
            eligible.append(sup)
    return eligible


def _seed_real_catalog(
    db: Session,
    cats: dict[str, Category],
    suppliers: dict[str, Supplier],
) -> None:
    """Seed real parts from JSON catalog files in catalog_data/."""
    catalog_dir = Path(__file__).parent / "catalog_data"
    if not catalog_dir.exists():
        print("Seed: catalog_data/ not found, skipping real catalog.")
        return

    json_files = sorted(catalog_dir.glob("*.json"))
    if not json_files:
        print("Seed: no JSON files in catalog_data/, skipping real catalog.")
        return

    random.seed(7500)
    slug_to_parent: dict[str, str] = {}
    for cat_name, slug, cat_icon, subs in CATEGORY_DATA:
        del cat_name, cat_icon
        for sub_name, ss, sub_icon in subs:
            del sub_name, sub_icon
            slug_to_parent[ss] = slug

    total_parts = 0
    total_listings = 0

    for jf in json_files:
        data = json.loads(jf.read_text())
        for sub_slug, parts_list in data.items():
            target_cat = None
            for cat in cats.values():
                if str(cat.slug) == sub_slug:
                    target_cat = cat
                    break
            if target_cat is None:
                print(f"  WARNING: subcategory slug '{sub_slug}' not found, skipping.")
                continue

            parent_slug = slug_to_parent.get(sub_slug, "")
            eligible = _eligible_suppliers(suppliers, parent_slug)
            if not eligible:
                eligible = list(suppliers.values())[:10]

            for p in parts_list:
                existing = db.query(Part).filter(Part.sku == p["sku"]).first()
                if existing:
                    continue

                part = Part(
                    sku=p["sku"],
                    slug=slugify_sku(p["sku"]),
                    description=p.get("description", ""),
                    manufacturer_name=p.get("manufacturer", ""),
                    category_id=target_cat.id,
                    sub_slug=sub_slug,
                    datasheet_url=p.get("datasheet_url"),
                    lifecycle_status=p.get("lifecycle", "active"),
                )
                db.add(part)
                db.flush()
                total_parts += 1

                base_cents = p.get("price_cents", 500)
                base_price = Decimal(base_cents) / 100

                num_listings = min(random.randint(8, 15), len(eligible))
                chosen = random.sample(eligible, num_listings)

                for sup in chosen:
                    spread = Decimal(str(round(random.uniform(0.80, 1.25), 4)))
                    unit_price = max(
                        Decimal("0.01"),
                        (base_price * spread).quantize(Decimal("0.0001")),
                    )
                    stock_lo, stock_hi = _STOCK_TIERS.get(str(sup.name), _DEFAULT_STOCK)
                    listing = PartListing(
                        part_id=part.id,
                        supplier_id=sup.id,
                        sku=f"{sup.name[:3].upper()}-{p['sku']}",
                        stock_quantity=random.randint(stock_lo, stock_hi),
                        lead_time_days=random.choice([0, 0, 0, 1, 3, 7, 14]),
                        unit_price=unit_price,
                    )
                    db.add(listing)
                    db.flush()
                    total_listings += 1

                    for qty, discount in [(10, 0.95), (100, 0.85), (1000, 0.70), (5000, 0.58)]:
                        db.add(
                            PriceBreak(
                                listing_id=listing.id,
                                min_quantity=qty,
                                unit_price=max(
                                    Decimal("0.01"),
                                    (unit_price * Decimal(str(discount))).quantize(
                                        Decimal("0.0001")
                                    ),
                                ),
                            )
                        )

                if total_parts % 500 == 0:
                    db.flush()
                    print(f"  ... {total_parts} parts seeded so far")

    db.flush()
    print(f"Seed: {total_parts} real parts, {total_listings} listings created from catalog JSON.")


# ---------------------------------------------------------------------------
# Revenue placeholder (12 months)
# ---------------------------------------------------------------------------

_DEMO_SUPPLIER_NAMES = frozenset(
    [
        "Kennedy Electronics",
        "Honeywell Sensing",
        "Oneonta Electronics",
        "Thunder Electronics",
        "States Electronics",
        "Mike's Electric",
        "Jo Jo's Circuits Circus",
    ]
)


def _month_bounds(today: date, months_ago: int) -> tuple[date, date]:
    period_start = (today.replace(day=1) - timedelta(days=30 * months_ago)).replace(day=1)
    if period_start.month == 12:
        period_end = period_start.replace(year=period_start.year + 1, month=1, day=1) - timedelta(
            days=1
        )
    else:
        period_end = period_start.replace(month=period_start.month + 1, day=1) - timedelta(days=1)
    return period_start, period_end


def _seed_revenue(db: Session, suppliers: dict[str, Supplier]) -> None:
    if db.query(Revenue).first():
        return

    random.seed(99)
    today = date.today()

    listing_counts = {
        str(row[0]): row[1]
        for row in db.query(PartListing.supplier_id, func.count(PartListing.id))
        .group_by(PartListing.supplier_id)
        .all()
    }

    # (min_listings, sponsor_amounts, listing_amounts, sponsor_prob, listing_prob)
    _REVENUE_TIERS: list[tuple[int, list[int], list[int], float, float]] = [
        (1000, [2000, 3000, 4000, 5000], [500, 750, 1000, 1500], 0.85, 0.95),
        (500, [1000, 1500, 2000, 2500], [300, 500, 750], 0.75, 0.9),
        (100, [500, 750, 1000], [100, 200, 300], 0.5, 0.8),
        (0, [100, 250, 500], [50, 75, 100], 0.3, 0.6),
    ]
    _DEMO_TIER = ([250, 500, 750, 1000, 1500], [50, 100, 150, 200], 0.6, 0.7)

    all_suppliers = list(suppliers.values())
    for months_ago in range(12, 0, -1):
        period_start, period_end = _month_bounds(today, months_ago)

        for sup in all_suppliers:
            lc = listing_counts.get(str(sup.id), 0)

            if str(sup.name) in _DEMO_SUPPLIER_NAMES:
                sponsor_amounts, listing_amounts, sponsor_prob, listing_prob = _DEMO_TIER
            else:
                fallback = _REVENUE_TIERS[-1]
                sponsor_amounts, listing_amounts, sponsor_prob, listing_prob = (
                    fallback[1],
                    fallback[2],
                    fallback[3],
                    fallback[4],
                )
                for min_lc, s_amts, l_amts, s_prob, l_prob in _REVENUE_TIERS:
                    if lc >= min_lc:
                        sponsor_amounts, listing_amounts, sponsor_prob, listing_prob = (
                            s_amts,
                            l_amts,
                            s_prob,
                            l_prob,
                        )
                        break

            if random.random() < sponsor_prob:
                db.add(
                    Revenue(
                        supplier_id=sup.id,
                        type="sponsorship",
                        amount=Decimal(str(random.choice(sponsor_amounts))),
                        description=f"Monthly sponsorship - {sup.name}",
                        period_start=period_start,
                        period_end=period_end,
                    )
                )
            if random.random() < listing_prob:
                db.add(
                    Revenue(
                        supplier_id=sup.id,
                        type="listing_fee",
                        amount=Decimal(str(random.choice(listing_amounts))),
                        description=f"Listing fee - {sup.name}",
                        period_start=period_start,
                        period_end=period_end,
                    )
                )

    db.flush()
    print(f"Seed: {db.query(Revenue).count()} revenue records created.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    db: Session = SessionLocal()
    try:
        seed(db)
    finally:
        db.close()
