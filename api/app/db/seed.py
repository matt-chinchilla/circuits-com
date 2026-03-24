"""Seed script — populate categories, suppliers, category_suppliers, and sponsors.

Run with:
    python -m app.db.seed

The script is idempotent: it uses get-or-create semantics keyed on slug (categories)
and name (suppliers), so it is safe to run multiple times.
"""

from __future__ import annotations

import re
from typing import Optional

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models import Category, CategorySupplier, Sponsor, Supplier


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
    for sup, rank in [(digikey, 1), (mouser, 2), (avnet, 3), (tti, 4)]:
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
    print("Seed completed successfully.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    db: Session = SessionLocal()
    try:
        seed(db)
    finally:
        db.close()
