"""Sponsor brand-color columns + hex validation (spec 2026-07-10)."""

import pytest

from app.models.sponsor import Sponsor
from app.utils.color import validate_optional_hex_color


def test_hex_validator_accepts_none_and_valid():
    assert validate_optional_hex_color(None) is None
    assert validate_optional_hex_color("#1d3a8f") == "#1d3a8f"
    assert validate_optional_hex_color("#ABCDEF") == "#ABCDEF"


@pytest.mark.parametrize(
    "bad",
    [
        "1d3a8f",
        "#1d3a8",
        "#1d3a8f0",
        "#1d3a8f00",
        "red",
        "#12345g",
        "javascript:x",
        "#1d3a8f;}",
        "",
    ],
)
def test_hex_validator_rejects_invalid(bad):
    with pytest.raises(ValueError):
        validate_optional_hex_color(bad)


def test_sponsor_brand_columns_metadata():
    # SQLite ignores VARCHAR length — assert on metadata (CLAUDE.md pattern)
    for name in ("brand_primary", "brand_secondary"):
        column = Sponsor.__table__.c[name]
        assert column.nullable
        assert column.type.length >= 7


def _auth_header(client):
    resp = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "testpass123"},
    )
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_admin_sponsor_roundtrip_brand_colors(client, seeded_db, db):
    """POST a sponsor with brand colors, confirm roundtrip; PATCH with a bad
    hex value 422s (mirrors test_create_category_sponsor_then_list_shows_it's
    fixture/auth arrangement in test_admin_sponsors.py)."""
    headers = _auth_header(client)
    supplier = seeded_db["supplier1"]
    category = seeded_db["parent"]

    payload = {
        "supplier_id": str(supplier.id),
        "category_id": str(category.id),
        "tier": "Platinum",
        "amount": "750.00",
        "status": "Active",
    }
    payload["brand_primary"] = "#1d3a8f"
    payload["brand_secondary"] = "#9bb8ff"
    res = client.post("/api/admin/sponsors/", json=payload, headers=headers)
    assert res.status_code in (200, 201)
    body = res.json()
    assert body["brand_primary"] == "#1d3a8f"
    assert body["brand_secondary"] == "#9bb8ff"

    bad = client.patch(
        f"/api/admin/sponsors/{body['id']}", json={"brand_primary": "#zzz"}, headers=headers
    )
    assert bad.status_code == 422
