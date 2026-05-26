# Real Catalog Population — Design Spec

## Purpose
Populate circuits.com with real electronic component data so the site functions as a genuine price comparison engine: one Part → many PartListings (per distributor) → volume PriceBreaks.

## Data Volume
- ~5,500-6,500 real parts across 75 subcategories (100+ for mainstream, 30-60 for niche)
- ~55,000-75,000 PartListing rows (10-15 distributors per popular part)
- ~200,000-300,000 PriceBreak rows (3-5 tiers per listing)
- ~55 Supplier rows (current 7 real + ~43 new from user's 50-distributor list)

## Architecture

### Data files
`api/app/db/catalog_data/` — 15 JSON files, one per top-level category:
```
power-management-ics-pmics.json
microcontrollers-processors.json
analog-ics.json
interface-ics.json
memory-ics.json
logic-ics.json
rf-wireless-ics.json
sensor-ics.json
audio-video-ics.json
clock-timing-ics.json
motor-motion-ics.json
data-conversion-ics.json
security-auth-ics.json
automotive-ics.json
display-led-ics.json
```

### JSON schema per file
```json
{
  "subcategory_slug": [
    {
      "sku": "STM32F103C8T6",
      "manufacturer": "STMicroelectronics",
      "description": "ARM Cortex-M3 72MHz MCU, 64KB Flash, 20KB SRAM, LQFP-48",
      "datasheet_url": "https://www.st.com/resource/en/datasheet/stm32f103c8.pdf",
      "lifecycle": "active",
      "price_cents": 350
    }
  ]
}
```

### Seed function changes
- `_PART_CATALOG` → `_DEMO_CATALOG` (renamed, kept for wizard demos)
- New `_seed_real_catalog(db, cats, suppliers)` reads JSON files → creates Part/PartListing/PriceBreak rows
- Listing generation: each part gets 8-15 distributor listings with ±15-25% price variation
- Price breaks at qty 10/100/1000 with 5%/15%/30% discounts (vary per distributor)

### Distributor tiers
- **Broad-line** (DigiKey, Mouser, Arrow, Avnet, Newark, Farnell, RS, element14, Future, TTI): carry everything
- **Specialty RF** (RFMW, Richardson RFPD, Pasternack): RF/Wireless ICs only
- **Power/Industrial** (Sager, Galco, Walker): PMICs, Motor, Sensors
- **Connectors** (PEI-Genesis, Powell): Interface, Automotive
- **Regional** (TME, Distrelec, Conrad, Anglia, EBV, Heilind, Electro Sonic, CoreStaff): carry most categories, smaller stock

### Manufacturer list (50)
Abracon, Amphenol, Analog Devices, Bourns, Diodes Inc., Honeywell, Infineon, KEMET, KYOCERA AVX, Lattice, Littelfuse, Microchip, Molex, Murata, Nexperia, NXP, Omron, onsemi, Panasonic, Phoenix Contact, Renesas, Samsung, Samtec, Sensata, STMicroelectronics, TDK, TE Connectivity, Texas Instruments, Vishay, Wurth Elektronik, Xilinx, Yageo, and others.

## Execution
1. Infrastructure: expand suppliers, build JSON reader + seed function
2. Data generation: 15 parallel agents, one per category JSON file
3. Integration: run seed, verify counts
4. Deploy
