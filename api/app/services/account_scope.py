"""The single home for "what may this caller see".

Every scoped customer endpoint takes an :class:`AccountScope` rather than
re-deriving the filter from ``user.supplier_id`` / ``user.manufacturer_id``.
That is the entire point of the module: a visibility rule written once is a
rule that can be reviewed once, and a rule copied into eight routers is eight
chances to forget the second link, the NULL case, or the free account.

Three things here are structural, not stylistic.

**A caller with no company links matches NOTHING.** Not "no filter" — nothing.
The free browsing account is a real, common state (signup never sets either
link), and the natural way to write scoping by hand is to append a condition
per link, which for a free account appends none and hands back the whole
catalog. So the helpers never return ``None`` and never return a LIST that a
caller could splat into ``filter(*clauses)``; they always return exactly one
boolean SQL expression, and when there is nothing to permit that expression is
``false()``. Getting "unrestricted" out of this module requires not using it.

**Both links may be set at once.** Avnet distributes AND manufactures. There is
no type enum and there is no ``elif`` anywhere below: each link contributes a
clause and the clauses are OR-ed. An account holding both sees the union.

**A comparison against ``None`` is not "no match", it is ``IS NULL``.** SQLAlchemy
compiles ``Message.user_id == None`` to ``user_id IS NULL``, which is precisely
the shared staff inbox. So a clause is only ever built for a link that is
actually set, and :class:`AccountScope` refuses to be constructed without a
``user_id``.
"""

from dataclasses import dataclass
from uuid import UUID

from fastapi import Depends
from sqlalchemy import ColumnElement, false, or_, select

from app.models import (
    ActivityEvent,
    Expense,
    Lead,
    Message,
    OutboundClick,
    Part,
    PartListing,
    Revenue,
    Sponsor,
    SupplierFeed,
    User,
)
from app.services.auth_service import require_account_user


@dataclass(frozen=True, slots=True)
class AccountScope:
    """Who is asking, and which company rows that entitles them to.

    Frozen: a scope is resolved once per request from the authenticated user
    and is not a mutable bag a route can widen on its way to the query.
    """

    user_id: UUID
    supplier_id: UUID | None
    manufacturer_id: UUID | None

    def __post_init__(self) -> None:
        # See the module docstring: a scope with no user_id would let
        # ``messages_visible_to`` compile to ``user_id IS NULL`` and hand a
        # customer the staff inbox. Refuse it at construction so no caller can
        # produce one by accident.
        if self.user_id is None:
            raise ValueError("AccountScope requires a user_id")

    @classmethod
    def from_user(cls, user: User) -> "AccountScope":
        """The one place a User becomes a scope. Reads BOTH links, always."""
        return cls(
            user_id=user.id,
            supplier_id=user.supplier_id,
            manufacturer_id=user.manufacturer_id,
        )

    @property
    def is_supplier(self) -> bool:
        """Linked to a distributor — sees the parts it carries."""
        return self.supplier_id is not None

    @property
    def is_manufacturer(self) -> bool:
        """Linked to a maker — sees the parts it makes."""
        return self.manufacturer_id is not None

    @property
    def is_unlinked(self) -> bool:
        """A free browsing account: neither link. Sees none of its own rows —
        which is not the same as seeing nothing on the site, since the public
        catalog is public. This governs the CONSOLE only."""
        return not (self.is_supplier or self.is_manufacturer)


def account_scope(user: User = Depends(require_account_user)) -> AccountScope:
    """FastAPI dependency: the scope for this request.

    Depends on ``require_account_user`` — activation (D17) is the authorization
    boundary and it stays in one place. A scoped route asks for the scope and
    gets the gate for free; it cannot accidentally serve staff or an
    unactivated customer.
    """
    return AccountScope.from_user(user)


def _any_of(*clauses: ColumnElement[bool] | None) -> ColumnElement[bool]:
    """OR the clauses that exist; with none, a filter that matches nothing.

    The single chokepoint that makes "unlinked" safe by construction. Callers
    below hand in ``None`` for a link they do not hold, and never an empty list
    that could be splatted away into an absent WHERE clause.
    """
    present = [clause for clause in clauses if clause is not None]
    if not present:
        return false()
    if len(present) == 1:
        return present[0]
    return or_(*present)


def parts_visible_to(scope: AccountScope) -> ColumnElement[bool]:
    """Parts this caller may see, as a WHERE clause over ``Part``.

    A distributor sees the parts it carries (it has a ``part_listings`` row,
    reached by the indexed ``supplier_id``); a maker sees the parts it makes
    (``parts.manufacturer_id``); an account holding both sees the union, with
    the overlap appearing once because both halves are row predicates on
    ``parts`` rather than joins.
    """
    carried = (
        select(PartListing.id)
        .where(
            PartListing.part_id == Part.id,
            PartListing.supplier_id == scope.supplier_id,
        )
        .exists()
        if scope.is_supplier
        else None
    )
    made = Part.manufacturer_id == scope.manufacturer_id if scope.is_manufacturer else None
    return _any_of(carried, made)


def listings_visible_to(scope: AccountScope) -> ColumnElement[bool]:
    """Offers this caller may READ, as a WHERE clause over ``PartListing``.

    A distributor's own shelf, plus — for a maker — every distributor's offer
    on a part they make, which is the whole point of a manufacturer console:
    who is stocking my parts, at what price. Read only. For anything that
    WRITES a listing use :func:`listings_owned_by`.
    """
    own_shelf = PartListing.supplier_id == scope.supplier_id if scope.is_supplier else None
    on_my_parts = (
        select(Part.id)
        .where(
            Part.id == PartListing.part_id,
            Part.manufacturer_id == scope.manufacturer_id,
        )
        .exists()
        if scope.is_manufacturer
        else None
    )
    return _any_of(own_shelf, on_my_parts)


def listings_owned_by(scope: AccountScope) -> ColumnElement[bool]:
    """Offers this caller may WRITE, as a WHERE clause over ``PartListing``.

    Strictly the linked distributor's own rows. Deliberately NARROWER than
    :func:`listings_visible_to`: a manufacturer may look at a distributor's
    price on its part and must never be able to edit it. A maker-only or free
    account owns nothing.
    """
    return _any_of(PartListing.supplier_id == scope.supplier_id if scope.is_supplier else None)


def sponsorships_visible_to(scope: AccountScope) -> ColumnElement[bool]:
    """Placements this caller may see, as a WHERE clause over ``Sponsor``.

    ``sponsors.supplier_id`` is NOT NULL, so a placement is always a supplier's
    — a maker-only account has none and gets the matches-nothing filter rather
    than falling through to unrestricted.

    Answers WHOSE, never WHETHER IT IS LIVE: no status predicate here. Status
    is a separate question with its own trap (NULL counts as Active), and
    folding it in would silently hide a caller's own legacy rows from them.
    Callers that want only live placements add
    ``or_(Sponsor.status == "Active", Sponsor.status.is_(None))`` themselves.
    """
    return _any_of(Sponsor.supplier_id == scope.supplier_id if scope.is_supplier else None)


def messages_visible_to(scope: AccountScope) -> ColumnElement[bool]:
    """Messages this caller may see, as a WHERE clause over ``Message``.

    Keyed on the USER, not the company: an inbox belongs to the person.
    ``messages.user_id`` NULL is the shared staff inbox (every public form
    submission and every pre-043 row) and belongs to no customer — an equality
    test never matches NULL, which is why this must stay an equality test and
    never grow an ``or_(... .is_(None))`` convenience.
    """
    return Message.user_id == scope.user_id


def revenue_visible_to(scope: AccountScope) -> ColumnElement[bool]:
    """Revenue rows this caller may see, as a WHERE clause over ``Revenue``.

    ``revenue.supplier_id`` is NOT NULL and there is no maker column, so a
    manufacturer-only or free account gets the matches-nothing filter. The
    console renders that as an empty chart, which is the truth: we have booked
    nothing from them.
    """
    return _any_of(Revenue.supplier_id == scope.supplier_id if scope.is_supplier else None)


def clicks_visible_to(scope: AccountScope) -> ColumnElement[bool]:
    """Referral clicks this caller may see, as a WHERE clause over
    ``OutboundClick``.

    A click is recorded against the DISTRIBUTOR the visitor left for, so this
    is a supplier-only signal. A maker cannot claim the clicks that went to the
    distributors stocking their parts — those are somebody else's demand
    numbers, and attributing them here is how a chart starts lying.
    """
    return _any_of(OutboundClick.supplier_id == scope.supplier_id if scope.is_supplier else None)


def activity_visible_to(scope: AccountScope) -> ColumnElement[bool]:
    """Feed events this caller may see, as a WHERE clause over ``ActivityEvent``.

    ``activity_events.supplier_id`` is NULLABLE — a system event belongs to no
    company, and the supplier-delete cascade NULLs the column rather than
    destroying history. So this must stay a clause built only for a link that
    is actually set: ``supplier_id == None`` compiles to ``IS NULL`` and would
    hand every customer the whole system's unattributed audit trail.
    """
    return _any_of(ActivityEvent.supplier_id == scope.supplier_id if scope.is_supplier else None)


def feeds_visible_to(scope: AccountScope) -> ColumnElement[bool]:
    """The caller's feed configuration row, as a WHERE clause over
    ``SupplierFeed``.

    Row selection only. WHAT may be read out of that row is a separate rule the
    endpoint owns, and a strict one: ``api_key`` and ``feed_url`` never leave
    the server.
    """
    return _any_of(SupplierFeed.supplier_id == scope.supplier_id if scope.is_supplier else None)


def expenses_owned_by(scope: AccountScope) -> ColumnElement[bool]:
    """Cost rows this caller owns, as a WHERE clause over ``Expense``.

    Keyed on the USER, not the company — a cost book belongs to the person who
    keeps it, exactly like :func:`messages_visible_to`. ``expenses.user_id``
    NULL is CIRCUIT CENTER'S OWN operating cost (every seed row, every cost-sync
    row, every admin entry), so this must stay an equality test: an
    ``or_(... .is_(None))`` convenience would publish the company's AWS bill to
    every customer console.
    """
    return Expense.user_id == scope.user_id


def leads_owned_by(scope: AccountScope) -> ColumnElement[bool]:
    """Prospects this caller owns, as a WHERE clause over ``Lead``.

    Same shape and same trap as :func:`expenses_owned_by`: ``leads.user_id``
    NULL is Circuit Center's own outreach roster — real collected names, phone
    numbers and call outcomes — and an equality test is the only thing keeping
    it out of a customer's CRM.
    """
    return Lead.user_id == scope.user_id
