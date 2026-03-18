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
    # 1. Top-level categories
    # ------------------------------------------------------------------
    top_level: list[tuple[str, str]] = [
        ("Integrated Circuits (ICs)", "⚡"),
        ("Electromechanical Components", "⚙️"),
        ("Optoelectronic Devices", "💡"),
        ("Circuit Protection Devices", "🛡️"),
        ("Power Supply Products", "🔋"),
        ("RF & Wireless", "📡"),
        ("Sensors", "🌡️"),
        ("Passive Components", "📐"),
        ("Discrete Semiconductors", "🔌"),
        ("Memory", "💾"),
        ("Test & Measurement", "🔬"),
        ("Cables & Wire", "🔗"),
        ("Development Tools", "🛠️"),
        ("Industrial Automation", "🏭"),
    ]

    cats: dict[str, Category] = {}
    for sort_order, (name, icon) in enumerate(top_level):
        cat = get_or_create_category(db, name, icon=icon, sort_order=sort_order)
        cats[name] = cat

    # ------------------------------------------------------------------
    # 2. Subcategories
    # ------------------------------------------------------------------

    # Integrated Circuits (ICs) — level 1
    ic_subs: list[tuple[str, str]] = [
        ("Clock and Timing", "⏱️"),
        ("Data Converter ICs", "🔄"),
        ("Embedded Processors and Controllers", "💻"),
        ("Interface and Transceiver ICs", "🔁"),
    ]
    ic_sub_cats: dict[str, Category] = {}
    for sort_order, (name, icon) in enumerate(ic_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=cats["Integrated Circuits (ICs)"], sort_order=sort_order
        )
        ic_sub_cats[name] = cat
        cats[name] = cat

    # Clock and Timing — level 2
    clock_timing_subs: list[tuple[str, str]] = [
        ("Clock Buffers", "🔲"),
        ("Clock Drivers", "🔳"),
        ("Oscillators", "〰️"),
        ("PLLs", "🔃"),
    ]
    for sort_order, (name, icon) in enumerate(clock_timing_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=ic_sub_cats["Clock and Timing"], sort_order=sort_order
        )
        cats[name] = cat

    # Data Converter ICs — level 2
    data_converter_subs: list[tuple[str, str]] = [
        ("ADCs", "📊"),
        ("DACs", "📉"),
    ]
    for sort_order, (name, icon) in enumerate(data_converter_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=ic_sub_cats["Data Converter ICs"], sort_order=sort_order
        )
        cats[name] = cat

    # Electromechanical Components — level 1
    em_subs: list[tuple[str, str]] = [
        ("Audio Products", "🔊"),
        ("Motors and Drives", "⚙️"),
        ("Relays", "🔌"),
        ("Electromechanical Switches", "🔘"),
        ("Connectors", "🔗"),
        ("Accessories", "🧩"),
    ]
    for sort_order, (name, icon) in enumerate(em_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=cats["Electromechanical Components"], sort_order=sort_order
        )
        cats[name] = cat

    # Optoelectronic Devices — level 1
    opto_subs: list[tuple[str, str]] = [
        ("Display Modules", "🖥️"),
        ("Fiber Optic Components", "💡"),
        ("Electric Lamp Components", "💡"),
        ("Laser Device Components", "🔴"),
        ("Optocoupler Relay Devices", "🔁"),
    ]
    for sort_order, (name, icon) in enumerate(opto_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=cats["Optoelectronic Devices"], sort_order=sort_order
        )
        cats[name] = cat

    # Circuit Protection Devices — level 1
    cp_subs: list[tuple[str, str]] = [
        ("Circuit Breaker Parts", "⚡"),
        ("ESD Protection Diodes", "🛡️"),
        ("IC ESD Protection Circuit", "🛡️"),
        ("Fuses", "🔥"),
        ("PTC Resettable Fuses", "♻️"),
        ("TVS Diodes", "🔌"),
    ]
    for sort_order, (name, icon) in enumerate(cp_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=cats["Circuit Protection Devices"], sort_order=sort_order
        )
        cats[name] = cat

    # Power Supply Products — level 1
    ps_subs: list[tuple[str, str]] = [
        ("AC-DC Converters", "🔋"),
        ("DC-DC Converters", "🔋"),
        ("Voltage Regulators", "⚡"),
        ("Power Management ICs", "💡"),
    ]
    for sort_order, (name, icon) in enumerate(ps_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=cats["Power Supply Products"], sort_order=sort_order
        )
        cats[name] = cat

    # RF & Wireless — level 1
    rf_subs: list[tuple[str, str]] = [
        ("Antennas", "📡"),
        ("RF Amplifiers", "📶"),
        ("RF Transceivers", "📻"),
        ("RF Filters", "🔍"),
    ]
    for sort_order, (name, icon) in enumerate(rf_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=cats["RF & Wireless"], sort_order=sort_order
        )
        cats[name] = cat

    # Sensors — level 1
    sensor_subs: list[tuple[str, str]] = [
        ("Temperature Sensors", "🌡️"),
        ("Pressure Sensors", "🔵"),
        ("Motion Sensors", "🏃"),
        ("Proximity Sensors", "📍"),
    ]
    for sort_order, (name, icon) in enumerate(sensor_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=cats["Sensors"], sort_order=sort_order
        )
        cats[name] = cat

    # Passive Components — level 1
    passive_subs: list[tuple[str, str]] = [
        ("Capacitors", "⚡"),
        ("Resistors", "🔴"),
        ("Inductors", "🌀"),
        ("Transformers", "🔄"),
    ]
    for sort_order, (name, icon) in enumerate(passive_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=cats["Passive Components"], sort_order=sort_order
        )
        cats[name] = cat

    # Discrete Semiconductors — level 1
    discrete_subs: list[tuple[str, str]] = [
        ("Diodes", "🔌"),
        ("Transistors", "🔧"),
        ("Thyristors", "⚡"),
        ("MOSFETs", "💡"),
    ]
    for sort_order, (name, icon) in enumerate(discrete_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=cats["Discrete Semiconductors"], sort_order=sort_order
        )
        cats[name] = cat

    # Memory — level 1
    memory_subs: list[tuple[str, str]] = [
        ("DRAM", "💾"),
        ("Flash Memory", "💾"),
        ("SRAM", "💾"),
        ("EEPROM", "💾"),
    ]
    for sort_order, (name, icon) in enumerate(memory_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=cats["Memory"], sort_order=sort_order
        )
        cats[name] = cat

    # Test & Measurement — level 1
    tm_subs: list[tuple[str, str]] = [
        ("Oscilloscopes", "🔬"),
        ("Multimeters", "📏"),
        ("Signal Generators", "📡"),
        ("Logic Analyzers", "🔍"),
    ]
    for sort_order, (name, icon) in enumerate(tm_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=cats["Test & Measurement"], sort_order=sort_order
        )
        cats[name] = cat

    # Cables & Wire — level 1
    cable_subs: list[tuple[str, str]] = [
        ("Cable Assemblies", "🔗"),
        ("Wire", "〰️"),
        ("Coaxial Cables", "📡"),
        ("Fiber Optic Cables", "💡"),
    ]
    for sort_order, (name, icon) in enumerate(cable_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=cats["Cables & Wire"], sort_order=sort_order
        )
        cats[name] = cat

    # Development Tools — level 1
    devtools_subs: list[tuple[str, str]] = [
        ("Dev Boards", "🛠️"),
        ("Debuggers", "🐛"),
        ("Programmers", "💻"),
        ("Software Tools", "🔧"),
    ]
    for sort_order, (name, icon) in enumerate(devtools_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=cats["Development Tools"], sort_order=sort_order
        )
        cats[name] = cat

    # Industrial Automation — level 1
    ia_subs: list[tuple[str, str]] = [
        ("PLCs", "🏭"),
        ("HMIs", "🖥️"),
        ("Motor Controllers", "⚙️"),
        ("Industrial Sensors", "🌡️"),
    ]
    for sort_order, (name, icon) in enumerate(ia_subs):
        cat = get_or_create_category(
            db, name, icon=icon, parent=cats["Industrial Automation"], sort_order=sort_order
        )
        cats[name] = cat

    # ------------------------------------------------------------------
    # 3. Suppliers
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
    # 4. CategorySupplier associations
    # ------------------------------------------------------------------
    # Every top-level category gets at least 3 suppliers.
    # Kennedy Electronics is featured in "Integrated Circuits (ICs)" and its subcategories.

    # Integrated Circuits (ICs)
    ic = cats["Integrated Circuits (ICs)"]
    for sup, featured, rank in [
        (kennedy, True, 1),
        (digikey, False, 2),
        (mouser, False, 3),
        (avnet, False, 4),
        (arrow, False, 5),
    ]:
        get_or_create_category_supplier(db, ic, sup, is_featured=featured, rank=rank)

    # Kennedy featured in IC subcategories
    for sub_name in ["Clock and Timing", "Data Converter ICs", "Embedded Processors and Controllers", "Interface and Transceiver ICs"]:
        sub_cat = cats[sub_name]
        get_or_create_category_supplier(db, sub_cat, kennedy, is_featured=True, rank=1)
        get_or_create_category_supplier(db, sub_cat, digikey, is_featured=False, rank=2)
        get_or_create_category_supplier(db, sub_cat, mouser, is_featured=False, rank=3)

    # Clock and Timing sub-subcategories
    for sub_name in ["Clock Buffers", "Clock Drivers", "Oscillators", "PLLs"]:
        sub_cat = cats[sub_name]
        get_or_create_category_supplier(db, sub_cat, kennedy, is_featured=True, rank=1)
        get_or_create_category_supplier(db, sub_cat, digikey, is_featured=False, rank=2)

    # Electromechanical Components
    em = cats["Electromechanical Components"]
    for sup, rank in [(digikey, 1), (mouser, 2), (avnet, 3), (tti, 4)]:
        get_or_create_category_supplier(db, em, sup, rank=rank)

    # Optoelectronic Devices
    opto = cats["Optoelectronic Devices"]
    for sup, rank in [(digikey, 1), (mouser, 2), (future, 3), (arrow, 4)]:
        get_or_create_category_supplier(db, opto, sup, rank=rank)

    # Circuit Protection Devices
    cp = cats["Circuit Protection Devices"]
    for sup, rank in [(avnet, 1), (digikey, 2), (tti, 3), (mouser, 4)]:
        get_or_create_category_supplier(db, cp, sup, rank=rank)

    # Power Supply Products
    ps = cats["Power Supply Products"]
    for sup, rank in [(avnet, 1), (arrow, 2), (digikey, 3), (future, 4)]:
        get_or_create_category_supplier(db, ps, sup, rank=rank)

    # RF & Wireless
    rf = cats["RF & Wireless"]
    for sup, rank in [(mouser, 1), (digikey, 2), (avnet, 3), (arrow, 4)]:
        get_or_create_category_supplier(db, rf, sup, rank=rank)

    # Sensors
    sensors_cat = cats["Sensors"]
    for sup, rank in [(digikey, 1), (mouser, 2), (avnet, 3), (tti, 4)]:
        get_or_create_category_supplier(db, sensors_cat, sup, rank=rank)

    # Passive Components
    passive = cats["Passive Components"]
    for sup, rank in [(digikey, 1), (mouser, 2), (tti, 3), (avnet, 4)]:
        get_or_create_category_supplier(db, passive, sup, rank=rank)

    # Discrete Semiconductors
    discrete = cats["Discrete Semiconductors"]
    for sup, rank in [(arrow, 1), (avnet, 2), (digikey, 3), (future, 4)]:
        get_or_create_category_supplier(db, discrete, sup, rank=rank)

    # Memory
    memory_cat = cats["Memory"]
    for sup, rank in [(avnet, 1), (arrow, 2), (future, 3), (digikey, 4)]:
        get_or_create_category_supplier(db, memory_cat, sup, rank=rank)

    # Test & Measurement
    tm_cat = cats["Test & Measurement"]
    for sup, rank in [(digikey, 1), (mouser, 2), (avnet, 3)]:
        get_or_create_category_supplier(db, tm_cat, sup, rank=rank)

    # Cables & Wire
    cables_cat = cats["Cables & Wire"]
    for sup, rank in [(tti, 1), (digikey, 2), (mouser, 3), (avnet, 4)]:
        get_or_create_category_supplier(db, cables_cat, sup, rank=rank)

    # Development Tools
    devtools_cat = cats["Development Tools"]
    for sup, rank in [(digikey, 1), (mouser, 2), (arrow, 3), (avnet, 4)]:
        get_or_create_category_supplier(db, devtools_cat, sup, rank=rank)

    # Industrial Automation
    ia_cat = cats["Industrial Automation"]
    for sup, rank in [(avnet, 1), (arrow, 2), (future, 3), (digikey, 4)]:
        get_or_create_category_supplier(db, ia_cat, sup, rank=rank)

    # Also associate Kennedy with Capacitors subcategory (for sponsor context below)
    get_or_create_category_supplier(db, cats["Capacitors"], avnet, rank=1)

    # ------------------------------------------------------------------
    # 5. Sponsors
    # ------------------------------------------------------------------
    # Kennedy Electronics — gold sponsor for "Clock and Timing" category
    get_or_create_sponsor(
        db,
        supplier=kennedy,
        category=cats["Clock and Timing"],
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
