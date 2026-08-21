"""THE privacy guard: lead data must be structurally unreachable from any
public surface (spec invariant 2). Real people's contact data rides these
tables — a failure here is a data leak, not a bug."""

from pathlib import Path

ROUTES = Path(__file__).parent.parent / "app" / "routes"
PUBLIC_ROUTERS = [
    "categories.py", "suppliers.py", "search.py", "forms.py", "sponsors.py",
    "sitemap.py", "checkout.py", "parts.py", "analytics.py", "manufacturers.py",
]


def test_no_public_router_touches_leads():
    for name in PUBLIC_ROUTERS:
        src = (ROUTES / name).read_text()
        assert "Lead" not in src, f"{name} references Lead"
        assert "lead_contacts" not in src, f"{name} references lead_contacts"


def test_supplier_public_surfaces_hide_manufacturer_id():
    from app.routes.suppliers import supplier_to_dict
    from app.schemas.supplier import SupplierResponse

    class FakeSupplier:
        def __init__(self):
            import uuid
            self.id = uuid.uuid4()
            self.name = "X"
            for attr in ("phone", "website", "email", "contact_name", "description",
                         "logo_url", "contact_role", "coverage_hours", "brand_primary",
                         "brand_secondary", "manufacturer_id"):
                setattr(self, attr, None)

    d = supplier_to_dict(FakeSupplier())
    assert "manufacturer_id" not in d, "supplier_to_dict leaks the bridge column"
    assert "manufacturer_id" not in SupplierResponse.model_fields


def test_leads_router_is_fully_gated():
    src = (ROUTES / "admin_leads.py").read_text()
    import re
    routes = re.findall(r"@router\.(get|post|patch|delete)[^\n]*\n(?:.*\n){1,12}?", src)
    # every def under a router decorator must depend on require_leads_access
    defs = re.split(r"@router\.", src)[1:]
    for block in defs:
        assert "require_leads_access" in block.split("def ", 2)[-1].split("@router")[0] or \
               "require_leads_access" in block, "an admin_leads route lacks the gate"


def test_dashboard_recent_leads_is_gated():
    src = (ROUTES / "dashboard.py").read_text()
    if "leads/recent" in src:
        assert "require_leads_access" in src, "dashboard leads endpoint lacks the demo read-gate"
