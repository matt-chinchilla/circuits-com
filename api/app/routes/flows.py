"""Sankey flows for the staff Reports page: /api/dashboard/flows/*.

Two reads, both require_staff (a viewer may read them — they are aggregate
traffic, no addresses), both cached client-side like the rest of Reports.
The aggregation itself lives in ``services/traffic_flows`` so the bucketing
rules are testable without a database; this module only fetches rows.
"""

from __future__ import annotations

import uuid as uuid_mod
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Category, OutboundClick, PageView, Part, Supplier
from app.routes.analytics import _window_segment
from app.services.auth_service import require_staff
from app.services.traffic_flows import PartRef, part_token, parts_flow, traffic_flow

router = APIRouter(
    prefix="/api/dashboard/flows",
    tags=["flows"],
    dependencies=[Depends(require_staff)],
)

Segment = Literal["humans", "bots", "all"]
# SQLite caps bound parameters per statement (999 on older builds); the
# resolver batches its IN lists well under it.
_IN_CHUNK = 400


def _cutoff(days: int) -> datetime:
    return datetime.now(UTC) - timedelta(days=days)


@router.get("/traffic")
def traffic(
    days: int = Query(30, ge=1, le=365),
    segment: Segment = "humans",
    db: Session = Depends(get_db),
):
    cutoff = _cutoff(days)
    _, seg = _window_segment(db, cutoff, segment)
    rank = (
        func.row_number()
        .over(partition_by=PageView.session_id, order_by=(PageView.created_at, PageView.id))
        .label("rank")
    )
    ranked = (
        db.query(PageView.session_id, rank, PageView.path, PageView.referrer)
        .filter(PageView.created_at >= cutoff, *seg)
        .subquery()
    )
    rows = (
        db.query(ranked.c.session_id, ranked.c.rank, ranked.c.path, ranked.c.referrer)
        .filter(ranked.c.rank <= 2)
        .all()
    )
    payload = traffic_flow(rows)
    payload.update(period_days=days, segment=segment)
    return payload


def _is_uuid(token: str) -> bool:
    try:
        uuid_mod.UUID(token)
        return True
    except (ValueError, AttributeError):
        return False


def _chunks(items: list, size: int = _IN_CHUNK):
    for i in range(0, len(items), size):
        yield items[i : i + size]


@router.get("/parts")
def parts(
    days: int = Query(30, ge=1, le=365),
    segment: Segment = "humans",
    limit: int = Query(12, ge=3, le=40),
    by: Literal["maker", "part"] = "maker",
    db: Session = Depends(get_db),
):
    cutoff = _cutoff(days)
    _, seg = _window_segment(db, cutoff, segment)
    rows = (
        db.query(PageView.path, func.count(PageView.id))
        .filter(PageView.created_at >= cutoff, PageView.path.like("/part/%"), *seg)
        .group_by(PageView.path)
        .all()
    )
    token_views: dict[str, int] = {}
    for path, n in rows:
        token = part_token(path)
        if token:
            token_views[token] = token_views.get(token, 0) + int(n)

    # Resolve tokens to catalog parts: a path may carry the slug OR the uuid
    # (both are canonical entry forms), and both must land on the same part.
    # Explicit COLUMNS, never ``db.query(Part)``: Part.listings and, through
    # them, price_breaks are lazy="selectin", so an entity query here would
    # hydrate every listing and rung of every viewed part (the trap
    # category_service documents and test_search_v2 guards).
    uuid_tokens = [t for t in token_views if _is_uuid(t)]
    slug_tokens = [t for t in token_views if not _is_uuid(t)]
    cols = (Part.id, Part.sku, Part.slug, Part.category_id, Part.sub_slug, Part.manufacturer_name)
    found: list = []
    for chunk in _chunks(uuid_tokens):
        found += db.query(*cols).filter(Part.id.in_([uuid_mod.UUID(t) for t in chunk])).all()
    for chunk in _chunks(slug_tokens):
        found += db.query(*cols).filter(Part.slug.in_(chunk)).all()

    categories = {
        str(c.id): (c.name, str(c.parent_id) if c.parent_id else None, c.slug)
        for c in db.query(Category.id, Category.name, Category.parent_id, Category.slug).all()
    }
    by_slug = {c[2]: cid for cid, c in categories.items()}

    def place(part) -> tuple[str, str]:
        cid = str(part.category_id) if part.category_id else None
        cat = categories.get(cid) if cid else None
        if cat is None:
            return ("Uncategorised", "Uncategorised")
        name, parent_id, _ = cat
        if parent_id and parent_id in categories:
            return (categories[parent_id][0], name)
        # Top-level part: the sub_slug names its child, else it is general.
        child_id = by_slug.get(part.sub_slug) if part.sub_slug else None
        if child_id and child_id in categories:
            return (name, categories[child_id][0])
        return (name, f"{name} (general)")

    parts_by_token: dict[str, PartRef] = {}
    for part in found:
        category, subcategory = place(part)
        ref = PartRef(
            part_id=str(part.id),
            sku=part.sku,
            manufacturer=part.manufacturer_name or "",
            category=category,
            subcategory=subcategory,
        )
        # slug is a non-unique index: the first row for a slug wins, which is
        # the same rule the public part page applies.
        parts_by_token.setdefault(str(part.id), ref)
        if part.slug:
            parts_by_token.setdefault(part.slug, ref)

    click_rows = (
        db.query(OutboundClick.part_id, OutboundClick.supplier_id, func.count(OutboundClick.id))
        .filter(OutboundClick.clicked_at >= cutoff, OutboundClick.part_id.isnot(None))
        .group_by(OutboundClick.part_id, OutboundClick.supplier_id)
        .all()
    )
    supplier_ids = {sid for _, sid, _ in click_rows}
    names = (
        {
            str(sid): name
            for sid, name in db.query(Supplier.id, Supplier.name)
            .filter(or_(*[Supplier.id == s for s in supplier_ids]))
            .all()
        }
        if supplier_ids
        else {}
    )
    clicks = [
        (str(pid), names.get(str(sid), "Unknown distributor"), int(n)) for pid, sid, n in click_rows
    ]

    payload = parts_flow(
        token_views, parts_by_token, clicks, limit=limit, subcategory_limit=limit, by=by
    )
    payload.update(period_days=days, segment=segment)
    return payload
