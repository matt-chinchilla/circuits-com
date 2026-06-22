"""Image columns must hold base64 data-URLs (no 500-char cap).

SQLite ignores String(N) length, so a length-based DB test can't catch the
regression — assert the SQLAlchemy column TYPE is Text (length is None) and
prove a long value round-trips through the ORM.
"""
import uuid

from sqlalchemy import Text

from app.models import Sponsor, Supplier


def test_sponsor_image_url_is_text():
    col = Sponsor.__table__.c.image_url
    assert isinstance(col.type, Text)
    assert getattr(col.type, "length", None) is None


def test_supplier_logo_url_is_text():
    col = Supplier.__table__.c.logo_url
    assert isinstance(col.type, Text)
    assert getattr(col.type, "length", None) is None


def test_long_data_url_round_trips(db):
    big = "data:image/webp;base64," + ("A" * 4000)
    sup = Supplier(id=uuid.uuid4(), name="LogoCo", logo_url=big)
    db.add(sup)
    db.flush()
    db.refresh(sup)
    assert sup.logo_url == big
    assert len(sup.logo_url) > 500
