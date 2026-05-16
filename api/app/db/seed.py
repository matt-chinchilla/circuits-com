"""Seed script — populate categories, suppliers, category_suppliers, sponsors,
admin user, parts, part listings, price breaks, and revenue.

Run with:
    python -m app.db.seed

The script is idempotent: it uses get-or-create semantics keyed on slug (categories)
and name (suppliers/users), so it is safe to run multiple times.
"""

from __future__ import annotations

import random
import re
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional

import bcrypt
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


def get_or_create_category(
    db: Session,
    name: str,
    icon: str = "⚡",
    parent: Optional[Category] = None,
    sort_order: int = 0,
) -> Category:
    slug = slugify(name)
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


def get_or_create_supplier(
    db: Session,
    name: str,
    phone: Optional[str] = None,
    website: Optional[str] = None,
    email: Optional[str] = None,
    description: Optional[str] = None,
    logo_url: Optional[str] = None,
    contact_name: Optional[str] = None,
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
    category: Optional[Category] = None,
    keyword: Optional[str] = None,
    image_url: Optional[str] = None,
    description: Optional[str] = None,
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
    # 1. Categories and subcategories (15 top-level, 5 subs each)
    # ------------------------------------------------------------------
    # Format: (name, icon, [(sub_name, sub_icon), ...])
    category_data: list[tuple[str, str, list[tuple[str, str]]]] = [
        ("Power Management ICs (PMICs)", "⚡", [
            ("Voltage Regulators (LDOs)", "🔋"),
            ("DC-DC Converters (Buck/Boost)", "🔋"),
            ("Battery Management ICs (BMS)", "🔋"),
            ("Power Supervisors / Reset ICs", "⚡"),
            ("LED Drivers", "💡"),
        ]),
        ("Microcontrollers & Processors", "🖥️", [
            ("8-bit Microcontrollers", "💻"),
            ("32-bit Microcontrollers (ARM Cortex-M)", "💻"),
            ("Application Processors", "🖥️"),
            ("Digital Signal Processors (DSPs)", "📊"),
            ("System-on-Chip (SoC)", "🔲"),
        ]),
        ("Analog ICs", "〰️", [
            ("Operational Amplifiers (Op-Amps)", "📈"),
            ("Comparators", "⚖️"),
            ("Analog Multiplexers / Switches", "🔀"),
            ("Voltage References", "🎯"),
            ("Instrumentation Amplifiers", "📐"),
        ]),
        ("Interface ICs", "🔌", [
            ("UART / USART Transceivers", "🔌"),
            ("USB Interface ICs", "🔌"),
            ("I2C / SPI Interface ICs", "🔌"),
            ("CAN / LIN Transceivers", "🚗"),
            ("Level Shifters", "↕️"),
        ]),
        ("Memory ICs", "💾", [
            ("EEPROM", "💾"),
            ("NOR Flash", "💾"),
            ("NAND Flash", "💾"),
            ("SRAM", "💾"),
            ("DRAM", "💾"),
        ]),
        ("Logic ICs", "🧮", [
            ("Logic Gates (AND, OR, NOT, etc.)", "🔢"),
            ("Flip-Flops / Latches", "🔲"),
            ("Counters", "🔢"),
            ("Shift Registers", "➡️"),
            ("Programmable Logic (CPLDs / FPGAs)", "🔧"),
        ]),
        ("RF & Wireless ICs", "📡", [
            ("Bluetooth ICs", "📶"),
            ("Wi-Fi ICs", "📶"),
            ("RF Transceivers", "📻"),
            ("GPS / GNSS Receivers", "🛰️"),
            ("NFC / RFID ICs", "📱"),
        ]),
        ("Sensor ICs", "🌡️", [
            ("Temperature Sensors", "🌡️"),
            ("Accelerometers", "📐"),
            ("Gyroscopes", "🔄"),
            ("Pressure Sensors", "🔵"),
            ("Proximity / Light Sensors", "💡"),
        ]),
        ("Audio & Video ICs", "🔊", [
            ("Audio Amplifiers", "🔊"),
            ("CODECs (Audio/Video)", "🎵"),
            ("Video Processors", "🎬"),
            ("HDMI / Display Interface ICs", "🖥️"),
            ("Microphone Preamplifiers", "🎤"),
        ]),
        ("Clock & Timing ICs", "⏱️", [
            ("Oscillators", "〰️"),
            ("Real-Time Clocks (RTC)", "⏰"),
            ("Clock Generators", "⏱️"),
            ("PLL (Phase-Locked Loops)", "🔃"),
            ("Timer ICs", "⏱️"),
        ]),
        ("Motor & Motion Control ICs", "⚙️", [
            ("Motor Drivers (DC/Stepper/BLDC)", "⚙️"),
            ("Servo Controllers", "🎮"),
            ("Gate Drivers (MOSFET/IGBT)", "⚡"),
            ("Motion Control ICs", "🏃"),
            ("PWM Controllers", "📊"),
        ]),
        ("Data Conversion ICs", "🔄", [
            ("Analog-to-Digital Converters (ADC)", "📊"),
            ("Digital-to-Analog Converters (DAC)", "📉"),
            ("Sigma-Delta Converters", "📈"),
            ("Voltage-to-Frequency Converters", "〰️"),
            ("Touchscreen Controllers", "📱"),
        ]),
        ("Security & Authentication ICs", "🔒", [
            ("Secure Elements", "🔒"),
            ("Cryptographic Coprocessors", "🔐"),
            ("TPM (Trusted Platform Modules)", "🛡️"),
            ("Hardware Encryption ICs", "🔑"),
            ("ID / Authentication ICs", "🪪"),
        ]),
        ("Automotive ICs", "🚗", [
            ("Automotive PMICs", "⚡"),
            ("CAN / LIN Automotive ICs", "🔌"),
            ("ADAS Processing ICs", "🖥️"),
            ("Automotive Sensors", "🌡️"),
            ("Infotainment Processors", "🎵"),
        ]),
        ("Display & LED ICs", "💡", [
            ("LED Matrix Drivers", "💡"),
            ("LCD Drivers", "🖥️"),
            ("OLED Drivers", "✨"),
            ("Backlight Controllers", "🔆"),
            ("Display Timing Controllers (TCON)", "⏱️"),
        ]),
    ]

    cats: dict[str, Category] = {}
    for sort_order, (name, icon, subs) in enumerate(category_data):
        cat = get_or_create_category(db, name, icon=icon, sort_order=sort_order)
        cats[name] = cat
        for sub_order, (sub_name, sub_icon) in enumerate(subs):
            sub = get_or_create_category(
                db, sub_name, icon=sub_icon, parent=cat, sort_order=sub_order
            )
            cats[sub_name] = sub

    # ------------------------------------------------------------------
    # 2. Suppliers
    # ------------------------------------------------------------------
    supplier_data: list[dict] = [
        dict(
            name="Avnet",
            phone="480-643-2000",
            website="avnet.com",
            email="info@avnet.com",
            description="Global electronic components distributor",
        ),
        dict(
            name="Digi-Key Electronics",
            phone="800-344-4539",
            website="digikey.com",
            email="sales@digikey.com",
            description="Leading global electronic components distributor",
        ),
        dict(
            name="TTI",
            phone="800-888-8884",
            website="ttiinc.com",
            email="sales@ttiinc.com",
            description="Specialist distributor of electronic components",
        ),
        dict(
            name="Future Electronics",
            phone="800-388-8731",
            website="futureelectronics.com",
            email="info@futureelectronics.com",
            description="Global distributor of electronic components",
        ),
        dict(
            name="Kennedy Electronics",
            phone="631-555-5555",
            website="kennedyelectronics.com",
            email="info@kennedyelectronics.com",
            description="Semiconductor supplier based in Smithtown, NY",
        ),
        dict(
            name="Mouser Electronics",
            phone="800-346-6873",
            website="mouser.com",
            email="sales@mouser.com",
            description="Global authorized distributor",
        ),
        dict(
            name="Arrow Electronics",
            phone="800-777-2776",
            website="arrow.com",
            email="info@arrow.com",
            description="Global provider of electronic components",
        ),
        dict(
            name="Honeywell Sensing",
            phone="800-537-6945",
            website="automation.honeywell.com",
            email="sensing@honeywell.com",
            description="Global sensing and IoT solutions manufacturer",
        ),
        # Suppliers added via the prod admin UI (2026-05-05) — imported into
        # the seed so a fresh local environment matches prod state. Some are
        # smoke-test entries from when the team verified the add-supplier
        # form; they're admin-deletable now that the Delete button shipped.
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
    for sub_name in ["Voltage Regulators (LDOs)", "DC-DC Converters (Buck/Boost)",
                     "Battery Management ICs (BMS)", "Power Supervisors / Reset ICs", "LED Drivers"]:
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
    # 6. Parts, listings, price breaks
    # ------------------------------------------------------------------
    _seed_parts(db, cats, suppliers)

    # ------------------------------------------------------------------
    # 7. Revenue placeholder data (12 months)
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
_PART_CATALOG: list[tuple[str, list[tuple[str, str, str]]]] = [
    # Power Management ICs (PMICs)
    ("Voltage Regulators (LDOs)", [
        ("LM7805CT", "Texas Instruments", "5V 1.5A Linear Voltage Regulator"),
        ("LT3045", "Analog Devices", "20V 500mA Ultralow Noise LDO"),
    ]),
    ("DC-DC Converters (Buck/Boost)", [
        ("TPS65217C", "Texas Instruments", "Power Management IC for AM335x"),
        ("MP2307DN", "Monolithic Power", "3A 23V Step-Down Converter"),
    ]),
    ("Battery Management ICs (BMS)", [
        ("BQ24195", "Texas Instruments", "4.5A Single-Cell USB Charger IC"),
    ]),
    # Microcontrollers & Processors
    ("32-bit Microcontrollers (ARM Cortex-M)", [
        ("STM32F407VGT6", "STMicroelectronics", "ARM Cortex-M4 168MHz MCU"),
        ("RP2040", "Raspberry Pi", "Dual-Core ARM Cortex-M0+ MCU"),
    ]),
    ("8-bit Microcontrollers", [
        ("ATMEGA328P-PU", "Microchip", "8-bit AVR MCU 32KB Flash"),
        ("PIC18F4550", "Microchip", "USB 2.0 Full-Speed MCU"),
    ]),
    ("System-on-Chip (SoC)", [
        ("ESP32-WROOM-32E", "Espressif", "Wi-Fi+BT MCU Module"),
    ]),
    # Analog ICs
    ("Operational Amplifiers (Op-Amps)", [
        ("LM358N", "Texas Instruments", "Dual Operational Amplifier"),
        ("OPA2134PA", "Texas Instruments", "Audio Dual Op-Amp"),
        ("MCP6002", "Microchip", "1MHz Low-Power Dual Op-Amp"),
    ]),
    ("Instrumentation Amplifiers", [
        ("AD8221ARZ", "Analog Devices", "Precision Instrumentation Amplifier"),
    ]),
    ("Comparators", [
        ("LM393N", "Texas Instruments", "Dual Differential Comparator"),
    ]),
    # Interface ICs
    ("UART / USART Transceivers", [
        ("MAX232CPE", "Maxim Integrated", "Dual RS-232 Driver/Receiver"),
    ]),
    ("USB Interface ICs", [
        ("FT232RL", "FTDI", "USB to Serial UART IC"),
        ("CP2102N", "Silicon Labs", "USB to UART Bridge Controller"),
    ]),
    ("CAN / LIN Transceivers", [
        ("SN65HVD230", "Texas Instruments", "3.3V CAN Bus Transceiver"),
    ]),
    ("Level Shifters", [
        ("TXB0108PWR", "Texas Instruments", "8-Bit Bidirectional Level Shifter"),
    ]),
    # Memory ICs
    ("EEPROM", [
        ("AT24C256", "Microchip", "256Kbit I2C Serial EEPROM"),
    ]),
    ("NOR Flash", [
        ("W25Q128JV", "Winbond", "128Mbit Serial NOR Flash"),
        ("S25FL512S", "Infineon", "512Mbit SPI NOR Flash"),
    ]),
    ("SRAM", [
        ("IS62WV25616", "ISSI", "256K x 16 High-Speed SRAM"),
    ]),
    ("DRAM", [
        ("MT48LC16M16A2", "Micron", "256Mbit SDRAM"),
    ]),
    # Logic ICs
    ("Logic Gates (AND, OR, NOT, etc.)", [
        ("SN74LS00N", "Texas Instruments", "Quad 2-Input NAND Gate"),
        ("74HC245", "NXP", "Octal Bus Transceiver"),
        ("SN74HC138N", "Texas Instruments", "3-to-8 Line Decoder"),
    ]),
    ("Shift Registers", [
        ("SN74HC595N", "Texas Instruments", "8-Bit Shift Register"),
    ]),
    ("Counters", [
        ("CD4017BE", "Texas Instruments", "Decade Counter/Divider"),
    ]),
    # RF & Wireless ICs
    ("Bluetooth ICs", [
        ("CC2541F256", "Texas Instruments", "Bluetooth Low Energy SoC"),
    ]),
    ("RF Transceivers", [
        ("SI4463", "Silicon Labs", "High-Performance RF Transceiver"),
        ("NRF24L01P", "Nordic Semi", "2.4GHz RF Transceiver"),
        ("SX1276", "Semtech", "LoRa Long Range Transceiver"),
    ]),
    ("GPS / GNSS Receivers", [
        ("UBLOX-NEO-6M", "u-blox", "GPS Receiver Module"),
    ]),
    # Sensor ICs
    ("Temperature Sensors", [
        ("LM35DZ", "Texas Instruments", "Precision Temperature Sensor"),
        ("HIH6130-021-001", "Honeywell", "HumidIcon Digital Humidity/Temp Sensor"),
        ("HIH7120-021-001", "Honeywell", "HumidIcon Low-Power Humidity Sensor"),
    ]),
    ("Accelerometers", [
        ("MPU6050", "InvenSense", "6-Axis Accelerometer + Gyroscope"),
        ("ADXL345", "Analog Devices", "3-Axis Digital Accelerometer"),
    ]),
    ("Pressure Sensors", [
        ("BME280", "Bosch", "Humidity/Pressure/Temperature Sensor"),
        ("BMP390", "Bosch", "High-Performance Barometric Pressure Sensor"),
        ("MPRLS0025PA00001A", "Honeywell", "MicroPressure 25 PSI Absolute I2C Sensor"),
        ("MPRLS0015PA0000SAB", "Honeywell", "MicroPressure 15 PSI Abs SPI Breakout Board"),
        ("MPRLS0300YG00001BB", "Honeywell", "MicroPressure 300mmHg Gage I2C Breakout"),
        ("ASDXRRX015PGAA5", "Honeywell", "Amplified 15 PSI Gage Pressure Sensor"),
        ("SSCDANN015PGAA5", "Honeywell", "TruStability 15 PSI Digital Pressure Sensor"),
        ("ABPDANT015PGAA5", "Honeywell", "Basic Board Mount 15 PSI Pressure Sensor"),
        ("HSC-SANN015PG2A3", "Honeywell", "High Accuracy Compensated 15 PSI Pressure"),
    ]),
    # Audio & Video ICs
    ("Audio Amplifiers", [
        ("MAX98357A", "Maxim Integrated", "I2S Class D Mono Amplifier"),
        ("TPA3116D2", "Texas Instruments", "50W Stereo Class-D Amplifier"),
    ]),
    ("CODECs (Audio/Video)", [
        ("WM8731", "Cirrus Logic", "Portable Internet Audio CODEC"),
        ("PCM5102A", "Texas Instruments", "32-bit 384kHz DAC"),
    ]),
    ("Microphone Preamplifiers", [
        ("ICS43434", "TDK", "Multi-Mode Digital Microphone"),
    ]),
    # Clock & Timing ICs
    ("Real-Time Clocks (RTC)", [
        ("DS3231SN", "Maxim Integrated", "Extremely Accurate RTC"),
        ("DS1307Z", "Maxim Integrated", "64 x 8 Serial RTC"),
    ]),
    ("Clock Generators", [
        ("SI5351A", "Silicon Labs", "I2C Programmable Clock Generator"),
        ("LMK00105", "Texas Instruments", "1:5 LVCMOS Clock Buffer"),
    ]),
    ("Timer ICs", [
        ("NE555P", "Texas Instruments", "Precision Timer IC"),
    ]),
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

    for subcategory_name, parts_data in _PART_CATALOG:
        # Exact-match lookup against the subcategory's own name. The cats
        # dict is keyed by name for both top-level and child rows, so this
        # resolves directly to the subcategory we want — no parent_id filter,
        # no substring matching ambiguity.
        target_cat = cats.get(subcategory_name)
        if target_cat is None:
            raise RuntimeError(
                f"_PART_CATALOG references unknown subcategory '{subcategory_name}'. "
                f"Update category_data or fix the typo."
            )

        for sku, manufacturer, description in parts_data:
            part = Part(
                sku=sku,
                description=description,
                manufacturer_name=manufacturer,
                category_id=target_cat.id,
            )
            db.add(part)
            db.flush()

            # 2-4 distributor listings per part
            num_listings = random.randint(2, 4)
            chosen_suppliers = random.sample(
                supplier_list, min(num_listings, len(supplier_list))
            )
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
                    db.add(PriceBreak(
                        listing_id=listing.id,
                        min_quantity=qty,
                        unit_price=Decimal(str(round(float(base_price) * discount, 4))),
                    ))

    db.flush()
    print(f"Seed: {db.query(Part).count()} parts, {db.query(PartListing).count()} listings created.")


# ---------------------------------------------------------------------------
# Revenue placeholder (12 months)
# ---------------------------------------------------------------------------

def _seed_revenue(db: Session, suppliers: dict[str, Supplier]) -> None:
    if db.query(Revenue).first():
        return

    random.seed(99)
    today = date.today()
    supplier_list = list(suppliers.values())

    for months_ago in range(12, 0, -1):
        period_start = (today.replace(day=1) - timedelta(days=30 * months_ago)).replace(day=1)
        # Last day of month
        if period_start.month == 12:
            period_end = period_start.replace(year=period_start.year + 1, month=1, day=1) - timedelta(days=1)
        else:
            period_end = period_start.replace(month=period_start.month + 1, day=1) - timedelta(days=1)

        for sup in supplier_list:
            # Sponsorship revenue (not all suppliers every month)
            if random.random() > 0.4:
                db.add(Revenue(
                    supplier_id=sup.id,
                    type="sponsorship",
                    amount=Decimal(str(random.choice([250, 500, 750, 1000, 1500]))),
                    description=f"Monthly sponsorship - {sup.name}",
                    period_start=period_start,
                    period_end=period_end,
                ))
            # Listing fees (smaller, more frequent)
            if random.random() > 0.3:
                db.add(Revenue(
                    supplier_id=sup.id,
                    type="listing_fee",
                    amount=Decimal(str(random.choice([50, 100, 150, 200]))),
                    description=f"Listing fee - {sup.name}",
                    period_start=period_start,
                    period_end=period_end,
                ))

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
