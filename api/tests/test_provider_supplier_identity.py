"""One supplier row per provider — the assumption the whole feed surface rests on.

`match_provider` keys on a DOMAIN FRAGMENT of `Supplier.website`, which is
deliberately loose so `mouser.com`, `https://www.mouser.com/` and a subdomain
all resolve alike. The cost of that looseness is that a fragment can match more
than one row, and nothing used to notice.

It happened for real, twice over, on 2026-08-24:

  * `DigiKey Marketplace` (`digikey.com/marketplace`) matched the same
    `digikey` fragment as the distributor. Marketplace is third-party sellers
    with different prices — writing Product Information pricing onto that row
    would publish one company's price under another's name.
  * Renaming the distributor row to "Digi-Key" in /admin did not move it. The
    seed keys `get_or_create_supplier` on NAME, so the next container start
    re-created "Digi-Key Electronics" beside it, and both matched.

Neither is a code bug in isolation; both are the same missing invariant.

THE STAKES WENT UP ON 2026-08-24. The BOM tool's `price_source` label (see
`bom_match._offers_for_part`) is built on this same fragment match: a supplier
whose website matches a provider slug we hold a key for is published to buyers
as `live`. So a fragment collision no longer just means "a feed run writes the
wrong row" — it means we also TELL BUYERS that row's prices are refreshed by a
distributor API that has never touched it. `DigiKey Marketplace` is exactly the
shape of row that would inherit the claim.

Measured on the local catalog the same day: only two suppliers match a fragment
at all (`Mouser Electronics` -> mouser.com, 130,728 listings; `Digi-Key
Electronics` -> digikey.com, 0 listings), the other 57 hold 37,095 listings and
read `static`, and exactly one supplier has a NULL website (`Thunder
Electronics`, 3 listings) — which is why `match_provider` must stay
None-guarded rather than `.lower()`-ing straight through.
"""

from app.db import seed as seed_module
from app.services.part_feed.registry import _PROVIDERS


def _seeded_suppliers() -> list[dict]:
    """Every supplier dict the seed would create, across both of its lists."""
    import inspect
    import re

    source = (
        inspect.getsource(seed_module.seed_suppliers_and_categories)
        if hasattr(seed_module, "seed_suppliers_and_categories")
        else inspect.getsource(seed_module)
    )
    return [
        {"name": n, "website": w}
        for n, w in re.findall(r'name="([^"]+)",\s*\n\s*website="([^"]+)"', source)
    ]


def test_no_seeded_supplier_pair_shares_a_provider_fragment():
    """Two seeded rows matching one provider means a feed run can land on
    either, and which one it picks is not something any test would catch."""
    seeded = _seeded_suppliers()
    for fragment, _provider_cls in _PROVIDERS:
        matching = [s for s in seeded if fragment in (s["website"] or "").lower()]
        assert len(matching) <= 1, (
            f"provider {fragment!r} matches {len(matching)} seeded suppliers "
            f"{[s['name'] for s in matching]} — a feed run would write real "
            "prices onto whichever the query happened to return"
        )


def test_each_provider_name_matches_a_supplier_the_seed_creates():
    """`_get_or_create_supplier` looks the provider's `supplier_name` up by
    NAME and CREATES it when absent. A provider whose name differs from the
    seed's by a single word therefore mints a duplicate on first use — silently,
    and with a website that matches the same fragment."""
    seeded_names = {s["name"] for s in _seeded_suppliers()}
    for _fragment, provider_cls in _PROVIDERS:
        assert provider_cls.supplier_name in seeded_names, (
            f"{provider_cls.__name__}.supplier_name = "
            f"{provider_cls.supplier_name!r} is not a name the seed creates, so "
            "fill_category would create a second row for this distributor"
        )
