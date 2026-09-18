"""The one place a payload asks "what badge does this supplier show". Every reader of
`founder` (a DERIVED flag since 055) or `badge` (the look the boards render) goes through
here, so the rule "enabled founder-family row, else nothing" is written once."""

from app.models.badge import FOUNDER_FAMILY, Badge, SupplierBadge
from app.models.supplier import Supplier


def founder_row(supplier: Supplier | None) -> SupplierBadge | None:
    if supplier is None:
        return None
    for row in supplier.badges:
        if row.family == FOUNDER_FAMILY and row.enabled:
            return row
    return None


def badge_look(row: SupplierBadge) -> dict:
    return {
        "key": row.badge.key,
        "scheme": row.scheme,
        "intensity": float(row.intensity),
        "opacity": float(row.opacity),
        "sparks": bool(row.sparks),
    }


def is_founder(supplier: Supplier | None) -> bool:
    """The DERIVED flag on its own — for the payloads that want the bool and
    nothing else, so they stop building and discarding a `badge_look` dict."""
    return founder_row(supplier) is not None


def supplier_badge_fields(supplier: Supplier | None) -> dict:
    row = founder_row(supplier)
    return {"founder": row is not None, "badge": badge_look(row) if row else None}


def serialize_badge_def(b: Badge) -> dict:
    return {
        "id": str(b.id),
        "key": b.key,
        "family": b.family,
        "label": b.label,
        "available": bool(b.available),
        "sort_order": int(b.sort_order),
    }


def serialize_supplier_badge(row: SupplierBadge) -> dict:
    return {
        "id": str(row.id),
        "supplier_id": str(row.supplier_id),
        **badge_look(row),
        "family": row.family,
        "label": row.badge.label,
        "available": bool(row.badge.available),
        "enabled": bool(row.enabled),
        "granted_at": row.granted_at.isoformat() if row.granted_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
