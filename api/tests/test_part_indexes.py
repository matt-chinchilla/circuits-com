"""Regression guard for alembic 012: the five hot query columns must be indexed.

These columns drive the category-page query path: the per-page WHERE on
Part.category_id, the denormalized Part.sub_slug filter, and the batched
price-break joins (PartListing.part_id, PriceBreak.listing_id,
PriceBreak.min_quantity). SQLite (used by the test suite) ignores index
*performance*, but the SQLAlchemy column `index` flag is dialect-agnostic and
pins the schema regardless of DB engine — same approach as the icon-length
metadata guard in test_categories.py.
"""

import pytest

from app.models.part import Part
from app.models.part_listing import PartListing, PriceBreak

# (model, column_name) pairs that MUST carry index=True after migration 012.
INDEXED_HOT_COLUMNS = [
    (Part, "category_id"),
    (Part, "sub_slug"),
    (PartListing, "part_id"),
    (PriceBreak, "listing_id"),
    (PriceBreak, "min_quantity"),
]


@pytest.mark.parametrize("model, column_name", INDEXED_HOT_COLUMNS)
def test_hot_column_is_indexed(model, column_name):
    """Each hot query column declares index=True in the model metadata."""
    column = model.__table__.c[column_name]
    assert column.index is True, (
        f"{model.__name__}.{column_name} must declare index=True "
        f"(got index={column.index!r}). Add index=True to the model column and "
        "a matching CREATE INDEX in alembic migration 012."
    )
