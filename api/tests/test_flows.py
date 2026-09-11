"""Sankey flows: /api/dashboard/flows/traffic + /parts and the pure bucketing
they are built on (services/traffic_flows).

The rules a partner-facing chart must keep: every session appears once per
column (conservation), bots are out of the human segment, a referrer is
bucketed by domain LABEL (never substring), and a part-page view that resolves
to no catalog part is DROPPED — a smoke-test slug can never become a node.
"""

from datetime import UTC, datetime, timedelta

from app.models import Category, OutboundClick, PageView, Part, Supplier
from app.services.traffic_flows import (
    DIRECT,
    LEFT,
    OTHER_BRANDS,
    OTHER_CATEGORIES,
    OTHER_PARTS,
    OTHER_SITES,
    OTHER_SUBCATEGORIES,
    PartRef,
    node_floor,
    page_floor,
    page_type,
    part_token,
    parts_flow,
    source_of,
    traffic_flow,
)

HUMAN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0"
BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"


# ── bucketing ────────────────────────────────────────────────────────────────


def test_referrers_bucket_by_domain_label_not_substring():
    assert source_of(None) == DIRECT
    # public input: a bracketed authority makes urlsplit raise — must bucket, not 500
    assert source_of("[") == DIRECT
    assert source_of("https://[foo]/x") == DIRECT
    assert source_of("") == DIRECT
    assert source_of("https://circuitcenter.ai/category/x") == DIRECT  # a reload of our own page
    assert source_of("https://www.google.com/") == "Google"
    assert source_of("https://www.google.co.kr/search?q=x") == "Google"
    assert source_of("android-app://com.reddit.frontpage") == "Reddit"
    assert source_of("https://old.reddit.com/r/x") == "Reddit"
    assert source_of("https://com.linkedin.android") == "LinkedIn"
    assert source_of("https://lnkd.in/abc") == "LinkedIn"
    assert source_of("https://t.co/xyz") == "X"
    assert source_of("https://checkout.stripe.com/c/pay") == "Stripe checkout"
    # substring traps: 't.co' inside another host, 'x.com' inside netflix.com
    assert source_of("https://product.co/") == OTHER_SITES
    assert source_of("https://netflix.com/") == OTHER_SITES


def test_page_types_and_part_tokens():
    assert page_type("/") == "Home"
    assert page_type("/index.html") == "Home"
    assert page_type("/category/power-management-ics") == "Category page"
    assert page_type("/part/lm7805ct?ref=x") == "Part page"
    assert page_type("/search?q=lm317") == "Search"
    assert page_type("/bom/s/abc") == "BOM tool"
    assert page_type("/pricing") == "Join"
    assert page_type("/partners") == "Other pages"  # a prefix match must stop at the segment
    assert part_token("/part/lm7805ct?ref=x") == "lm7805ct"
    assert part_token("/part/") is None
    assert part_token("/category/part") is None


def test_traffic_flow_conserves_every_session_across_columns():
    rows = [
        ("s1", 1, "/", "https://www.google.com/"),
        ("s1", 2, "/category/x", None),
        ("s2", 1, "/part/abc", None),
        ("s3", 1, "/part/abc", "android-app://com.reddit.frontpage"),
        ("s3", 2, "/search?q=abc", None),
    ] + [(f"g{i}", 1, "/", "https://www.google.com/") for i in range(5)]
    payload = traffic_flow(rows)
    assert payload["total"] == 8
    by_col = {}
    for link in payload["links"]:
        col = int(link["source"].split(":")[0])
        by_col[col] = by_col.get(col, 0) + link["value"]
    assert by_col == {0: 8, 1: 8}
    ids = {n["id"] for n in payload["nodes"]}
    # Reddit had ONE session — below the floor, folded into Other sites.
    assert "0:Reddit" not in ids and f"0:{OTHER_SITES}" in ids
    assert "0:Google" in ids and f"0:{DIRECT}" in ids
    assert f"2:{LEFT}" in ids and "2:Search" in ids
    # the same label lives in two columns under two ids
    assert "1:Part page" in ids
    labels = [n["label"] for n in payload["nodes"] if n["column"] == 0]
    assert labels[0] == "Google"  # largest first within a column


def test_parts_flow_drops_unresolved_tokens_and_pools_the_tail():
    """The third column is the BRAND: each brand node carries its top parts as
    the tooltip hint, the tail pools into "Other brands", and a token that
    resolves to no catalog part is never a node."""
    makers = ["TI", "ST", "ADI", "Molex", "Microchip"]
    parts = {
        f"sku{i}": PartRef(f"p{i}", f"SKU{i}", makers[i - 1], "Semis", "MCUs") for i in range(1, 6)
    }
    parts["p1-uuid"] = parts["sku1"]  # the uuid form of part 1 merges into it
    views = {f"sku{i}": 10 * i for i in range(1, 6)}
    views["p1-uuid"] = 7
    views["fake-part-1"] = 99  # never a node
    payload = parts_flow(views, parts, clicks=[("p5", "Digi-Key", 3), ("p1", "Mouser", 1)], limit=3)
    ids = {n["id"] for n in payload["nodes"]}
    assert not any("fake" in i for i in ids)
    assert payload["total"] == sum(views[k] for k in views if k != "fake-part-1")
    assert payload["columns"] == ["Category", "Subcategory", "Brand"] and payload["by"] == "maker"
    assert {"2:Microchip", "2:Molex", "2:ADI", f"2:{OTHER_BRANDS}"} <= ids
    assert "2:TI" not in ids  # below the top 3 → pooled
    pooled = next(link for link in payload["links"] if link["target"] == f"2:{OTHER_BRANDS}")
    assert pooled["value"] == 10 + 7 + 20  # TI (both forms) and ST
    third = [n["label"] for n in payload["nodes"] if n["column"] == 2]
    assert third[-1] == OTHER_BRANDS  # the pool sits last, whatever its size
    microchip = next(n for n in payload["nodes"] if n["id"] == "2:Microchip")
    assert microchip["hint"] == "Top: SKU5"
    assert payload["clicks_total"] == 4
    assert {"3:Digi-Key", "3:Mouser"} == {n["id"] for n in payload["distributor_nodes"]}
    assert any(
        link["source"] == f"2:{OTHER_BRANDS}" and link["target"] == "3:Mouser"
        for link in payload["distributor_links"]
    )


def test_parts_flow_can_still_be_asked_for_parts():
    parts = {
        "a": PartRef("p1", "SKU-A", "TI", "Semis", "MCUs"),
        "b": PartRef("p2", "SKU-B", "ST", "Semis", "MCUs"),
    }
    payload = parts_flow({"a": 5, "b": 3}, parts, clicks=[], limit=1, by="part")
    ids = {n["id"] for n in payload["nodes"]}
    assert payload["columns"][2] == "Part" and payload["by"] == "part"
    assert "2:SKU-A" in ids and f"2:{OTHER_PARTS}" in ids and "2:SKU-B" not in ids
    assert next(n for n in payload["nodes"] if n["id"] == "2:SKU-A")["hint"] == "TI"


def test_parts_flow_caps_the_category_column():
    parts = {f"s{i}": PartRef(f"p{i}", f"SKU{i}", "TI", f"Cat{i}", f"Sub{i}") for i in range(1, 14)}
    views = {f"s{i}": 100 - i for i in range(1, 14)}
    payload = parts_flow(views, parts, clicks=[], limit=12, subcategory_limit=12, category_limit=10)
    cats = [n["label"] for n in payload["nodes"] if n["column"] == 0]
    assert cats[:10] == [f"Cat{i}" for i in range(1, 11)] and cats[-1] == OTHER_CATEGORIES
    assert len(cats) == 11
    assert payload["total"] == sum(views.values())


# ── routes ───────────────────────────────────────────────────────────────────


def _view(db, session_id, path, referrer=None, ua=HUMAN_UA, minutes_ago=10):
    db.add(
        PageView(
            path=path,
            referrer=referrer,
            user_agent=ua,
            session_id=session_id,
            created_at=datetime.now(UTC) - timedelta(minutes=minutes_ago),
        )
    )


def test_flows_are_staff_only(client, db, seeded_db):
    assert client.get("/api/dashboard/flows/traffic").status_code == 401
    assert client.get("/api/dashboard/flows/parts").status_code == 401


def test_traffic_route_excludes_bots_by_default(client, db, seeded_db, auth_header):
    _view(db, "h1", "/", "https://www.google.com/", minutes_ago=20)
    _view(db, "h1", "/category/x", minutes_ago=19)
    _view(db, "h2", "/part/lm7805ct", None)
    _view(db, "b1", "/", "https://www.google.com/", ua=BOT_UA)
    db.commit()
    r = client.get("/api/dashboard/flows/traffic?days=7", headers=auth_header())
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 2 and body["unit"] == "sessions" and body["kind"] == "traffic"
    assert body["columns"] == ["Source", "Landing page", "Next step"]
    assert any(
        link["source"] == "1:Home" and link["target"] == "2:Category page" and link["value"] == 1
        for link in body["links"]
    )
    assert any(
        link["source"] == "1:Part page" and link["target"] == f"2:{LEFT}" for link in body["links"]
    )
    all_ = client.get(
        "/api/dashboard/flows/traffic?days=7&segment=all", headers=auth_header()
    ).json()
    assert all_["total"] == 3


def test_parts_route_resolves_slug_and_uuid_paths_and_drops_ghosts(
    client, db, seeded_db, auth_header
):
    parent = Category(name="Semiconductors", slug="flow-semis")
    db.add(parent)
    db.flush()
    child = Category(name="Voltage regulators", slug="flow-regs", parent_id=parent.id)
    db.add(child)
    db.flush()
    part = Part(
        sku="FLOW-7805",
        slug="flow-7805",
        manufacturer_name="Texas Instruments",
        category_id=child.id,
    )
    db.add(part)
    db.flush()
    supplier = db.query(Supplier).first()
    _view(db, "a", f"/part/{part.slug}")
    _view(db, "b", f"/part/{part.id}")
    _view(db, "c", "/part/fake-part-1")
    _view(db, "d", f"/part/{part.slug}", ua=BOT_UA)  # a crawler on the REAL part
    db.add(OutboundClick(part_id=part.id, supplier_id=supplier.id))
    db.commit()
    r = client.get("/api/dashboard/flows/parts?days=7", headers=auth_header())
    assert r.status_code == 200
    body = r.json()
    # slug + uuid forms merge, the ghost drops, the crawler is out of "humans"
    assert body["unit"] == "views" and body["total"] == 2
    ids = {n["id"] for n in body["nodes"]}
    assert {"0:Semiconductors", "1:Voltage regulators", "2:Texas Instruments"} <= ids
    assert not any("fake" in i.lower() for i in ids)
    brand = next(n for n in body["nodes"] if n["id"] == "2:Texas Instruments")
    assert brand["hint"] == "Top: FLOW-7805"
    assert body["clicks_total"] == 1
    assert body["distributor_links"][0]["target"] == f"3:{supplier.name}"
    everyone = client.get(
        "/api/dashboard/flows/parts?days=7&segment=all", headers=auth_header()
    ).json()
    assert everyone["total"] == 3
    by_part = client.get("/api/dashboard/flows/parts?days=7&by=part", headers=auth_header()).json()
    assert "2:FLOW-7805" in {n["id"] for n in by_part["nodes"]}


def test_parts_flow_pools_the_subcategory_tail_too():
    """Sixty subcategories with views is a barcode, not a chart: past the cap
    the tail becomes one pooled node, placed last, and every view still
    reaches the part column through it."""
    parts = {
        f"sku{i}": PartRef(f"p{i}", f"SKU{i}", "Maker", "Semis", f"Sub{i}") for i in range(1, 8)
    }
    views = {f"sku{i}": 100 - i for i in range(1, 8)}
    payload = parts_flow(views, parts, clicks=[], limit=3, subcategory_limit=4)
    subs = [n["label"] for n in payload["nodes"] if n["column"] == 1]
    assert subs == ["Sub1", "Sub2", "Sub3", "Sub4", OTHER_SUBCATEGORIES]
    pooled_in = sum(
        link["value"] for link in payload["links"] if link["target"] == f"1:{OTHER_SUBCATEGORIES}"
    )
    pooled_out = sum(
        link["value"] for link in payload["links"] if link["source"] == f"1:{OTHER_SUBCATEGORIES}"
    )
    assert pooled_in == pooled_out == sum(views[f"sku{i}"] for i in (5, 6, 7))
    assert payload["total"] == sum(views.values())


def test_the_fold_floor_scales_with_the_window():
    """Five sessions is the floor for a small window; a twelve-month window
    folds anything under 1% so hairline nodes never collide."""
    assert node_floor(8) == 5
    assert node_floor(499) == 5
    assert node_floor(1640) == 16
    # page types have no absolute floor: a tiny window keeps every type
    assert page_floor(8) == 1
    assert page_floor(1640) == 16
    rows = [(f"d{i}", 1, "/", None) for i in range(1000)]  # Direct → Home
    rows += [(f"g{i}", 1, "/", "https://www.google.com/") for i in range(20)]
    rows += [(f"b{i}", 1, "/bom", "https://www.bing.com/") for i in range(6)]  # under 1% of 1026
    payload = traffic_flow(rows)
    ids = {n["id"] for n in payload["nodes"]}
    assert "0:Google" in ids and "0:Bing" not in ids and "0:Other sites" in ids
    assert "1:BOM tool" not in ids and "1:Other pages" in ids
    assert (
        sum(link["value"] for link in payload["links"] if link["source"].startswith("0:")) == 1026
    )
