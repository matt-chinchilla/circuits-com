"""Match a visiting organization against the sales data we already hold.

The panel's whole point is turning "someone visited" into "someone I am
ALREADY PURSUING visited", so a network name resolved from an IP is matched
against the Leads CRM and the manufacturer universe.

MATCHING IS CANON-EXACT, DELIBERATELY. `manufacturer_canon.canon` is this
repo's single normalization home (it folds case, punctuation and legal
suffixes, so "Cirrus Logic Inc." and "CIRRUS LOGIC" agree), and nothing
looser is applied on top. The asymmetry that decides this: a MISSED match
costs a badge the owner can still find by reading the row, while a WRONG
match tells him a stranger is a live prospect. "Verizon Business" must never
light up because someone once added a lead called "Verizon".

The AS organization name is a REGISTRY string, not a brand — "Amazon.com,
Inc.", "Sachem Central School District" — so the canon of it is compared as
a whole. No leading-token rule: that is exactly what would make every
"Applied ..." company match every other one.

`kind` is an OPEN string union on purpose. A LinkedIn-connections import
(the owner exports Connections.csv; LinkedIn exposes no API for this) would
add `"linkedin"` as another source here and change nothing else.
"""

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models import Manufacturer, ManufacturerAlias
from app.models.lead import Lead
from app.services.manufacturer_canon import canon


@dataclass(frozen=True)
class OrgMatch:
    """What a visiting organization turned out to be. `kind` is open: today
    "lead" or "manufacturer", tomorrow whatever else we can import."""

    kind: str
    name: str
    id: str | None = None


class OrgMatcher:
    """Canon → match, built from ONE bulk read per source.

    Never a per-organization probe: the seed-perf lesson (2026-08-20) applies
    to any table this repo reads in a loop, and an analytics panel listing 200
    organizations would otherwise issue 600 queries.
    """

    def __init__(self, by_canon: dict[str, OrgMatch]):
        self._by_canon = by_canon

    @classmethod
    def build(cls, db: Session) -> "OrgMatcher":
        by_canon: dict[str, OrgMatch] = {}

        # Manufacturers first, then aliases, then LEADS LAST so a lead wins a
        # collision: a company on the call list is the more actionable fact,
        # and it is the one the owner asked to see.
        for mid, name, key in db.query(
            Manufacturer.id, Manufacturer.name, Manufacturer.canonical_key
        ):
            if key:
                by_canon.setdefault(key, OrgMatch("manufacturer", name, str(mid)))

        for mid, name, alias_canon in db.query(
            ManufacturerAlias.manufacturer_id,
            ManufacturerAlias.alias,
            ManufacturerAlias.alias_canon,
        ):
            if alias_canon:
                by_canon.setdefault(alias_canon, OrgMatch("manufacturer", name, str(mid)))

        for lid, company, slug in db.query(Lead.id, Lead.company_name, Lead.company_slug):
            # `company_slug` is already the paren-stripped canon of the
            # company, which is what makes this a dict lookup rather than a
            # scan; canon(company_name) is added too because the slug drops a
            # trailing parenthetical the network name might still carry.
            for key in (slug, canon(company or "")):
                if key:
                    by_canon[key] = OrgMatch("lead", company, str(lid))

        return cls(by_canon)

    def match(self, network_name: str | None) -> OrgMatch | None:
        if not network_name:
            return None
        return self._by_canon.get(canon(network_name))
