"""Schema reshape for the sponsor tier boards (2026-06-11).

Locks the final field sets of the four response schemas the boards consume:
- SupplierResponse gains `contact_role`; sheds the vestigial `is_featured`/`rank`
  (CategorySupplier columns dropped in migration 011).
- SponsorResponse gains the joined supplier board fields.
- CategoryPartnersResponse swaps `partners` (supplier list) for a single
  `platinum` sponsor.
- CategoryDetailResponse gains a `silver` supplier list.
"""

from app.schemas import (
    CategoryDetailResponse,
    CategoryPartnersResponse,
    SponsorResponse,
    SupplierResponse,
)


def test_supplier_response_fields():
    fields = SupplierResponse.model_fields
    assert "contact_role" in fields
    # Vestigial since migration 011 — must be gone.
    assert "is_featured" not in fields
    assert "rank" not in fields


def test_sponsor_response_board_fields():
    fields = SponsorResponse.model_fields
    for name in (
        "logo_url",
        "contact_role",
        "coverage_hours",
        "brand_primary",
        "brand_secondary",
    ):
        assert name in fields, f"SponsorResponse.{name} missing"


def test_category_partners_response_is_single_platinum():
    fields = CategoryPartnersResponse.model_fields
    assert "platinum" in fields
    assert "partners" not in fields


def test_category_detail_response_has_silver():
    assert "silver" in CategoryDetailResponse.model_fields
