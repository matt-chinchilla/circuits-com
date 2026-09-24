"""Lead identity — the ONE home for how a roster row is keyed and grouped.

Two writers create company leads: the roster import (`db/seed_leads.py`, on
every api start) and staff through `POST /api/admin/leads/`. They MUST derive
the same `source_key` for the same person, or a lead typed into the console
and the same lead in leads.csv become two rows — the seed's INSERT-IF-ABSENT
would no longer recognise it. So both call these two functions and neither
keeps a copy (test_lead_identity.py pins seed-then-API and API-then-seed to
ONE row).

Pure string rules, no DB: the canon key is `manufacturer_canon.canon`, the
same case/punctuation/legal-suffix fold the manufacturer merge uses. The
roster's "ENRICHMENT NEEDED" placeholder is NOT handled here — it is a CSV
convention, and the seed turns it into `contact=None` before calling in.
"""

from __future__ import annotations

from app.services.manufacturer_canon import canon, split_branch

# The contact half of a company-only row's key, fed THROUGH canon — which
# reads `_` as a separator and then folds "company" off the end as a legal
# suffix, so a company-only key is literally "acme|". That is the rule every
# existing row was keyed by (leads.csv since migration 036); it must not be
# "tidied", or the next api start re-inserts the whole roster beside itself.
# (test_admin_leads_create.py::TestIdentity pins the exact strings.)
_COMPANY_ONLY = "__company__"

SOURCE_KEY_MAX = 300  # leads.source_key VARCHAR(300)
COMPANY_SLUG_MAX = 220  # leads.company_slug VARCHAR(220)
BRANCH_LABEL_MAX = 80  # leads.branch_label VARCHAR(80)


def lead_source_key(company: str, contact: str | None) -> str:
    """The idempotency key behind `uq_leads_source_key`: one row per
    (company, person), or per company when no person is known yet.

    Both halves are stripped first: canon folds INNER whitespace, but a
    space left against the `|` would split it off into its own token. (The
    seed always stripped before calling, so existing keys are unchanged.)
    """
    person = (contact or "").strip() or _COMPANY_ONLY
    return canon(f"{company.strip()}|{person}")[:SOURCE_KEY_MAX]


def lead_company_parts(company: str) -> tuple[str, str | None]:
    """`"Bisco Industries (Bohemia)"` → `("bisco industries", "Bohemia")`.

    The slug is the paren-stripped canon that groups a company's branches
    (and links a lead to a `Manufacturer` by `canonical_key`); the branch
    label keeps its original casing for display.
    """
    head, branch = split_branch(company)
    return canon(head)[:COMPANY_SLUG_MAX], (branch[:BRANCH_LABEL_MAX] if branch else None)
