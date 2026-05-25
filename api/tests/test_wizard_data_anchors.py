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


# ── Source-level invariant tests ────────────────────────────────────────
# These check structural properties of the wizard's own TypeScript without
# spinning up a JSDOM runner. They're contract tests against the source —
# brittle in a useful way: if anyone refactors the wizard's behaviour they
# also have to update these, which means they have to think about why.


def _read(relative: str) -> str:
    return (_REPO_ROOT / relative).read_text(encoding="utf-8")


def test_spotlight_renders_click_blockers_around_target():
    """Bug 2026-05-24: users reported being able to click anywhere on the
    page during a tour, including buttons unrelated to the highlighted
    target. The spec is: clicks INSIDE the spotlight rect pass through to
    the spotlighted element; clicks OUTSIDE are swallowed.

    The implementation uses four `clickBlocker` divs positioned around
    the spotlight rect — top/left/right/bottom. The spotlight area itself
    has no overlay, so clicks reach the underlying button. This test
    enforces the structure so it can't regress to the old pointer-events:
    none-on-the-whole-dim approach (which let every click through).
    """
    spotlight_src = _read("frontend/src/admin/wizard/Spotlight.tsx")
    # Must use the click-blocker primitive when a spotlight rect exists.
    assert "clickBlocker" in spotlight_src, (
        "Spotlight.tsx must render <div className={styles.clickBlocker}> "
        "elements around the spotlight rect to block off-target clicks. "
        "Without these the wizard becomes a purely-decorative overlay and "
        "users can interact with anything on the page during a tour."
    )

    scss_src = _read("frontend/src/admin/wizard/Wizard.module.scss")
    assert "clickBlocker" in scss_src, (
        "Wizard.module.scss is missing the .clickBlocker class. The four "
        "rectangles surrounding the spotlight must be styled with "
        "pointer-events: auto so they actually swallow clicks."
    )
    # The blocker MUST have pointer-events: auto — that's the whole point.
    blocker_rule = re.search(
        r"\.clickBlocker\s*\{[^}]*pointer-events\s*:\s*auto[^}]*\}",
        scss_src,
        re.DOTALL,
    )
    assert blocker_rule, (
        ".clickBlocker rule must include `pointer-events: auto`. Without "
        "it the four rectangles around the spotlight would be invisible "
        "AND click-through — defeating the entire purpose."
    )


def test_preview_tip_swallows_click_propagation():
    """Bug 2026-05-24: clicking "Got it" in the live-site preview tip
    advanced the wizard TWICE — once via the button's onNext, once via
    the click bubbling up to .previewBackdrop whose onClick is bound to
    onClose (also wired to advance). Users skipped step 12 entirely and
    landed on step 13's confirm-delete spotlight, which felt confusing
    because the modal wasn't open yet.

    Root cause: .previewTip is a sibling of .previewFrame and didn't have
    a stopPropagation handler. .previewFrame does (so iframe clicks don't
    dismiss the modal), but the tip needs its own.

    This test enforces the stopPropagation handler exists on the tip so a
    future refactor can't silently reintroduce the double-advance.
    """
    src = _read("frontend/src/admin/wizard/LivePreviewModal.tsx")

    # Find the .previewTip className reference and inspect the window of
    # source immediately around it. A naive `<div ...>` regex breaks here
    # because the `=>` inside arrow-function attribute values contains a
    # `>` that ends the match prematurely. A 200-char window covers the
    # whole opening tag (className + optional onClick + any other attrs)
    # in any reasonable formatting.
    tip_marker_idx = src.find("styles.previewTip")
    assert tip_marker_idx != -1, (
        "LivePreviewModal.tsx must render a <div className={styles.previewTip}>. "
        "Missing this would break the preview modal's tooltip card entirely."
    )
    # Window: 30 chars back (catches the `<div className=` prefix) to 250
    # chars forward (covers any attribute set on the same opening tag).
    window = src[max(0, tip_marker_idx - 30) : tip_marker_idx + 250]
    assert "stopPropagation" in window, (
        "LivePreviewModal's .previewTip <div> must include "
        '`onClick={(e) => e.stopPropagation()}` (or equivalent). Without it, '
        "clicks on the 'Got it' button bubble to the .previewBackdrop whose "
        "onClick={onClose} fires a second advance() — the wizard skips step "
        "12 and lands on step 13's confirm-delete spotlight with no modal "
        "open. The matching guard lives at <div className={styles.previewFrame}>; "
        "the tip needs the same."
    )


def test_modal_advance_skips_grace_window():
    """Bug 2026-05-24: the 450ms grace window in useAdvance was making
    the wizard feel sluggish when the user clicked Delete — modal opened
    in ~50ms but the wizard waited 450ms + 220ms poll + 240ms onAdvance
    transition to react. Total ~900ms perceptual lag — users described
    step 12 as "doesn't auto-move".

    The grace existed to defend against stale-DOM false positives on
    value/predicate polls. For modal/modalGone kinds it's unnecessary —
    a confirm-delete modal only appears because the user EXPLICITLY
    clicked the spotlighted Delete button. No stale-DOM scenario.

    This test enforces that the modal branch fires WITHOUT consulting
    the grace gate.
    """
    src = _read("frontend/src/admin/wizard/useAdvance.ts")
    # Find both modal-kind branches (modal + modalGone). The regex captures
    # the function name called when the modal predicate matches. Non-greedy
    # `.+?` between the kind check and the call lets the predicate contain
    # arbitrary parens / nested punctuation without breaking the match.
    # Using `[^}]*` to grab the full branch body would silently miss any
    # future refactor that nested braces — targeting the call directly
    # keeps the assertion honest about what it's verifying.
    modal_call = re.search(
        r"advance\.kind\s*===\s*['\"]modal['\"]\s*\)\s*\{\s*if\s*\(.+?\)\s*(\w+)\(\);",
        src,
        re.DOTALL,
    )
    modal_gone_call = re.search(
        r"advance\.kind\s*===\s*['\"]modalGone['\"]\s*\)\s*\{\s*if\s*\(.+?\)\s*(\w+)\(\);",
        src,
        re.DOTALL,
    )
    assert modal_call, (
        "useAdvance.ts must contain a one-statement branch for "
        "advance.kind === 'modal' calling the advance function directly. "
        "Missing this means either the wizard's modal-detection polling is "
        "gone OR the structure was refactored beyond what this guard recognises."
    )
    assert modal_gone_call, (
        "useAdvance.ts must contain a one-statement branch for "
        "advance.kind === 'modalGone' calling the advance function directly."
    )
    # Both branches must call the grace-FREE advance function. The grace
    # was the canonical cause of the 2026-05-24 step-12 lag bug.
    grace_free = "fireImmediate"
    assert modal_call.group(1) == grace_free, (
        f"modal branch calls `{modal_call.group(1)}()` but must call "
        f"`{grace_free}()` — using the graced `fire()` reintroduces the "
        f"~900ms lag between clicking Delete and the spotlight moving to "
        f"the Confirm button."
    )
    assert modal_gone_call.group(1) == grace_free, (
        f"modalGone branch calls `{modal_gone_call.group(1)}()` but must "
        f"call `{grace_free}()` for the same reason."
    )
