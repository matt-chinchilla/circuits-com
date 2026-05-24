"""Pattern guard: every data-tour / data-field anchor referenced by the
admin wizard flows must exist somewhere in the React admin tree.

# Why this exists

The wizard's flow definitions (frontend/src/admin/wizard/flows.tsx) target
DOM elements by `data-tour="..."` and `data-field="..."` attributes. If a
flow step references an anchor that doesn't exist anywhere in the admin
tree, the wizard will silently hang at that step — the spotlight will
never materialize and the user will be stuck waiting.

This test enumerates every anchor the flows expect to find, then greps
the admin TSX tree to confirm each one is actually present. Adding a new
flow step that references an unwired anchor will fail this test with a
specific message pointing at the missing selector.

Pure file-scan; runs in milliseconds and needs no frontend tooling.
"""

import re
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[2]
_ADMIN_ROOT = _REPO_ROOT / "frontend" / "src" / "admin"


# Anchors that the 7 wizard flows currently reference. If you change
# flows.tsx, update this list — it IS the contract.
EXPECTED_DATA_TOUR = {
    # Sidebar nav
    "side-suppliers",
    "side-parts",
    "side-messages",
    "side-import",
    # Page CTAs
    "add-supplier",
    "add-part",
    "submit-supplier",
    "submit-part",
    "submit-sponsor",
    "delete-supplier",
    "delete-part",
    # Supplier-detail Quick Actions strip
    "qa-add-part",
    "qa-import-csv",
    "qa-add-sponsorship",
    # Supplier card on list page
    "supplier-card",
    # Import-CSV flow. Note: import-step-mapping and import-step-review
    # are emitted dynamically via `data-tour={active ? \`import-step-${key}\`
    # : undefined}` in import/index.tsx — the regex can't see them
    # statically. They're intentionally NOT in this set; the wizard
    # gracefully falls back to manual Next when those polls don't resolve.
    "csv-dropzone",
    "import-continue",
    "import-stepper",
    "import-step-done",
    "import-done-summary",
    # Messages flow
    "reply-text",
    "reply-send",
}

EXPECTED_DATA_FIELD = {
    # Supplier form
    "name",
    "description",
    "contact_name",
    "website",
    "phone",
    "email",
    # Part form
    "sku",
    "manufacturer_name",
    "category_id",
    "initial_unit_price",
    # Sponsor form
    "tier",
    "amount",
}


def _collect_attr_values(attr: str) -> set[str]:
    """Find every occurrence of `data-<attr>="<value>"` across admin TSX.

    Two patterns are recognised:
      1. Literal JSX attribute: `data-tour="side-suppliers"`
      2. Config-object property: `tour: 'side-suppliers'` (sidebar uses
         a SidebarLink[] config that the renderLink helper expands into
         `data-tour={link.tour}` dynamically — the literal value lives
         on the config row, not on the JSX element).

    Excludes the wizard's own flows.tsx because that file uses the same
    `data-tour="..."` syntax INSIDE CSS-selector strings (e.g.
    `document.querySelector('[data-tour="csv-dropzone"]')`). Scanning it
    would yield false positives — the test would pass for selectors that
    have no matching JSX attribute anywhere else in the tree.
    """
    literal_pattern = re.compile(rf'data-{re.escape(attr)}\s*=\s*"([^"]+)"')
    # Config-object form only makes sense for the `tour` namespace —
    # `field`/`modal`/`modal-confirm` are always inline literal JSX attrs.
    config_pattern = (
        re.compile(r"""\btour\s*:\s*['"]([^'"]+)['"]""") if attr == "tour" else None
    )
    found: set[str] = set()
    for tsx in _ADMIN_ROOT.rglob("*.tsx"):
        if tsx.name == "flows.tsx":
            continue
        text = tsx.read_text(encoding="utf-8", errors="ignore")
        for match in literal_pattern.finditer(text):
            found.add(match.group(1))
        if config_pattern:
            for match in config_pattern.finditer(text):
                found.add(match.group(1))
    return found


def test_every_wizard_data_tour_exists_in_admin_tree():
    found = _collect_attr_values("tour")
    missing = sorted(EXPECTED_DATA_TOUR - found)
    assert not missing, (
        "Wizard flows reference `data-tour` anchors that don't exist in "
        "frontend/src/admin/**/*.tsx. The wizard would hang at the step "
        "expecting these.\n\n"
        f"Missing: {missing}\n\n"
        "Either add the data-tour attribute to the appropriate JSX, or "
        "remove the step from frontend/src/admin/wizard/flows.tsx."
    )


def test_every_wizard_data_field_exists_in_admin_tree():
    found = _collect_attr_values("field")
    missing = sorted(EXPECTED_DATA_FIELD - found)
    assert not missing, (
        "Wizard flows reference `data-field` anchors that don't exist in "
        "frontend/src/admin/**/*.tsx. The autofill chips + spotlight on "
        "form steps would target nothing.\n\n"
        f"Missing: {missing}\n\n"
        "Add data-field=\"<name>\" to the field wrapper div in the "
        "matching form's TSX, or drop the step from flows.tsx."
    )


def test_modal_literal_selectors_present():
    """The wizard's modal-advance kind polls for [data-modal="confirm-delete"]
    (the backdrop) and [data-modal-confirm="true"] (the danger button).

    CSS Modules hash className values at build, so a global `.modal-backdrop`
    selector wouldn't survive. The literal data-* attrs are the wizard's
    only stable anchor across the supplier-detail and part-detail confirm
    modals.
    """
    modal_anchors = _collect_attr_values("modal")
    assert "confirm-delete" in modal_anchors, (
        "Delete-confirmation modals need `data-modal=\"confirm-delete\"` on "
        "the backdrop. Without it the wizard's modal-advance polls would "
        "never resolve and the delete tutorial steps would hang."
    )

    confirm_anchors = _collect_attr_values("modal-confirm")
    assert "true" in confirm_anchors, (
        "Delete-confirm buttons need `data-modal-confirm=\"true\"` so the "
        "wizard can find the confirm-cleanup target inside the modal."
    )
