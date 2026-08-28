"""The customer's catalog — the same rows the admin console shows, SCOPED.

Six read-only endpoints, all of them answering one question about the caller's
own company: what do I carry / make, where does it sit in the taxonomy, who do
I trade with, and who am I. The scoping is not re-derived here — every route
takes an :class:`AccountScope` and hands the predicate straight to the query,
so "what may this caller see" has exactly one home
(``app/services/account_scope.py``) and this module is only about shape.

Three things worth knowing before editing:

**The two directions of the same join are two different routes.** ``/parts``
answers both links at once (a distributor's shelf UNION a maker's products,
overlap once), but ``/manufacturers`` and ``/suppliers`` each answer ONE side:
the first is "whose products do I sell", which is meaningless without a
supplier link, and the second is "who sells my products", which is meaningless
without a manufacturer link. So those two gate on the link they are about and
return an empty list otherwise — deliberately NOT on ``parts_visible_to``,
which would let a maker's own parts leak into the list of makers they
distribute, and a distributor's shelf into the list of their resellers.

**Both links can be set at once and nothing here is an ``elif``.** Avnet
distributes and manufactures. An account holding both gets the union on
``/parts``, the distributor answer on ``/manufacturers``, the maker answer on
``/suppliers``, and a row from BOTH ``/my-*`` routes.

**A part serializes exactly one way on this site.** ``/parts`` returns
``routes.parts.part_to_dict`` and ``/my-supply`` returns
``routes.suppliers.supplier_to_dict`` — a second shape for the same row is how
a field ends up rendered on one page and missing on another (and, for
``supplier_to_dict``, how the CRM bridge column ``manufacturer_id`` would
escape the admin surface it is pinned to).
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import distinct, func, or_
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Category, Manufacturer, Part, PartListing, Supplier
from app.routes.parts import part_to_dict
from app.routes.suppliers import supplier_to_dict
from app.services.account_scope import AccountScope, account_scope, parts_visible_to

router = APIRouter(prefix="/api/account", tags=["account-catalog"])


def _uuid_or_404(value: str) -> uuid.UUID:
    """A malformed id is 'no such row', not a 500.

    Same three lines as ``routes.parts._to_uuid``; kept local rather than
    reaching for another router's private name.
    """
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError):
        raise HTTPException(404, "Not found") from None


def _manufacturer_row(m: Manufacturer, parts_count: int) -> dict:
    """The public facts about a maker, and nothing else.

    ``manufacturers`` is the Leads CRM's universe: the same table carries the
    outreach roster's canonical keys, merge candidates and aliases. A customer
    gets what the public site would show about a company plus their own count,
    so growing this dict is a privacy decision, not a convenience.
    """
    return {
        "id": str(m.id),
        "name": m.name,
        "slug": m.slug,
        "website": m.website,
        "logo_url": m.logo_url,
        "parts_count": parts_count,
    }


@router.get("/parts")
def list_my_parts(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    search: str | None = None,
    category_id: str | None = None,
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """The parts this caller may see, paginated.

    A distributor gets the parts they carry, a maker the parts they make, an
    account with both the union (each part once — the scope's clauses are row
    predicates on ``parts``, not joins that would duplicate the overlap), and a
    free account an EMPTY PAGE rather than the public catalog.

    ``search`` and ``category_id`` narrow WITHIN that set. They are applied on
    top of the scope predicate and can only ever remove rows: handing in the id
    of a category full of somebody else's parts returns nothing.
    """
    query = db.query(Part).filter(parts_visible_to(scope))

    if search:
        pattern = f"%{search}%"
        query = query.filter(or_(Part.sku.ilike(pattern), Part.description.ilike(pattern)))
    if category_id:
        query = query.filter(Part.category_id == _uuid_or_404(category_id))

    total = query.count()
    pages = max(1, (total + per_page - 1) // per_page)
    items = query.order_by(Part.sku).offset((page - 1) * per_page).limit(per_page).all()

    return {
        "items": [part_to_dict(p, db) for p in items],
        "total": total,
        "page": page,
        "pages": pages,
    }


@router.get("/categories")
def list_my_categories(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """The categories this caller's parts actually appear in, with a count.

    The count is the caller's SLICE of the category, never the category's own
    total: a distributor carrying three of a subcategory's four parts sees 3.
    Categories holding none of their parts are absent entirely rather than
    listed at zero — this is a "where is my catalog" list, not a taxonomy.

    Parts with no ``category_id`` are skipped: there is no category to name.
    """
    counts = dict(
        db.query(Part.category_id, func.count(Part.id))
        .filter(parts_visible_to(scope), Part.category_id.isnot(None))
        .group_by(Part.category_id)
        .all()
    )
    if not counts:
        return {"categories": [], "total": 0}

    cats = db.query(Category).filter(Category.id.in_(counts.keys())).all()
    parent_ids = {c.parent_id for c in cats if c.parent_id}
    parents = (
        {p.id: p for p in db.query(Category).filter(Category.id.in_(parent_ids)).all()}
        if parent_ids
        else {}
    )

    rows = []
    for c in cats:
        parent = parents.get(c.parent_id) if c.parent_id else None
        rows.append(
            {
                "id": str(c.id),
                "name": c.name,
                "slug": c.slug,
                "icon": c.icon,
                "parent_id": str(c.parent_id) if c.parent_id else None,
                "parent_name": parent.name if parent else None,
                "parent_slug": parent.slug if parent else None,
                "parts_count": int(counts[c.id]),
            }
        )
    rows.sort(key=lambda r: (-r["parts_count"], r["name"]))
    return {"categories": rows, "total": len(rows)}


@router.get("/manufacturers")
def list_my_manufacturers(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """The makers whose products this DISTRIBUTOR sells.

    Read across the caller's own shelf: ``part_listings`` (indexed on
    ``supplier_id``) into ``parts.manufacturer_id``. Empty for an account with
    no supplier link — including one that holds a manufacturer link, whose own
    company is ``/my-manufacturing`` and does not belong in a list of the
    makers they distribute.

    ``parts.manufacturer_id`` is nullable (production carried ~3,229 unresolved
    rows when the FK landed) and the join drops those rows rather than
    inventing a nameless maker.
    """
    if not scope.is_supplier:
        return {"manufacturers": [], "total": 0}

    rows = (
        db.query(Manufacturer, func.count(distinct(Part.id)))
        .join(Part, Part.manufacturer_id == Manufacturer.id)
        .join(PartListing, PartListing.part_id == Part.id)
        .filter(PartListing.supplier_id == scope.supplier_id)
        .group_by(Manufacturer.id)
        .all()
    )
    out = [_manufacturer_row(m, int(n)) for m, n in rows]
    out.sort(key=lambda r: (-r["parts_count"], r["name"]))
    return {"manufacturers": out, "total": len(out)}


@router.get("/suppliers")
def list_my_suppliers(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """The distributors selling this MANUFACTURER's products.

    The same join as ``/manufacturers``, read the other way, and gated on the
    other link: empty for an account with no manufacturer link, however much it
    carries as a distributor.

    ``parts_count`` is how many of the CALLER'S parts that distributor lists,
    not the size of their shelf.
    """
    if not scope.is_manufacturer:
        return {"suppliers": [], "total": 0}

    rows = (
        db.query(Supplier, func.count(distinct(Part.id)))
        .join(PartListing, PartListing.supplier_id == Supplier.id)
        .join(Part, Part.id == PartListing.part_id)
        .filter(Part.manufacturer_id == scope.manufacturer_id)
        .group_by(Supplier.id)
        .all()
    )
    out = [{**supplier_to_dict(s), "parts_count": int(n)} for s, n in rows]
    out.sort(key=lambda r: (-r["parts_count"], r["name"]))
    return {"suppliers": out, "total": len(out)}


@router.get("/my-supply")
def my_supply(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """This caller's own distributor row, or 404 when they have no such link.

    404 rather than an empty body: the console asks this to decide whether to
    render the distributor pages at all, and "no row" is the honest answer for
    a maker-only or free account.
    """
    supplier = (
        db.query(Supplier).filter(Supplier.id == scope.supplier_id).first()
        if scope.is_supplier
        else None
    )
    if supplier is None:
        raise HTTPException(404, "Not found")
    parts_count = (
        db.query(func.count(distinct(PartListing.part_id)))
        .filter(PartListing.supplier_id == supplier.id)
        .scalar()
    )
    return {**supplier_to_dict(supplier), "parts_count": int(parts_count or 0)}


@router.get("/my-manufacturing")
def my_manufacturing(
    db: Session = Depends(get_db),
    scope: AccountScope = Depends(account_scope),
):
    """This caller's own maker row, or 404 when they have no such link.

    ``parts_count`` here is the number of their parts in OUR catalog — the
    live count, not the ``catalog_part_count`` column the seed maintains and
    not the CSV's ``external_part_count``, which is somebody else's figure and
    must never be rendered as ours.
    """
    manufacturer = (
        db.query(Manufacturer).filter(Manufacturer.id == scope.manufacturer_id).first()
        if scope.is_manufacturer
        else None
    )
    if manufacturer is None:
        raise HTTPException(404, "Not found")
    parts_count = (
        db.query(func.count(Part.id)).filter(Part.manufacturer_id == manufacturer.id).scalar()
    )
    return _manufacturer_row(manufacturer, int(parts_count or 0))
