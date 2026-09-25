"""Lead profile photos (migration 059, owner ask 2026-09-25).

The picture is stored the way every admin image is — a raster data-URL from
the cropper, or a pasted http(s) URL — and validated on write by the ONE rule
(utils.image_url). It is roster data, so it must reach only the staff CRM.
"""

import base64
from pathlib import Path

import pytest

from app.db.session import Base
from app.models import Lead
from tests.test_admin_leads import leads_db  # noqa: F401 — the seeded roster fixture

URL = "/api/admin/leads/"
MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "059_lead_photo.py"

# A real (1×1) PNG, so a "round trip" is bytes a browser would draw.
PNG_1PX = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
WEBP_DATA = "data:image/webp;base64," + ("A" * 12_000)  # the size of a real cropped headshot

HOSTILE = [
    "javascript:alert(1)",
    "data:image/svg+xml;base64," + base64.b64encode(b"<svg onload=alert(1)/>").decode(),
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "not a url",
]


def _placeholder(db) -> Lead:
    return db.query(Lead).filter(Lead.needs_enrichment.is_(True)).first()


class TestColumn:
    def test_photo_url_is_nullable_text(self):
        col = Base.metadata.tables["leads"].c.photo_url
        assert col.nullable
        # TEXT, not VARCHAR(n): a data-URL headshot is tens of KB (the 017
        # widening of sponsors.image_url, for the same reason).
        assert getattr(col.type, "length", None) is None
        assert not col.foreign_keys

    def test_migration_is_the_next_head_and_backfills_nothing(self):
        src = MIGRATION.read_text()
        assert 'revision = "059"' in src and 'down_revision = "058"' in src
        assert 'sa.Column("photo_url", sa.Text(), nullable=True)' in src
        assert "UPDATE" not in src.upper().replace("UPDATED", "")


class TestRoundTrip:
    def test_patch_sets_then_clears_the_photo(self, client, leads_db, auth_header):  # noqa: F811
        lead = _placeholder(leads_db)
        h = auth_header()
        r = client.patch(f"{URL}{lead.id}", json={"photo_url": PNG_1PX}, headers=h)
        assert r.status_code == 200, r.text
        assert r.json()["photo_url"] == PNG_1PX
        assert client.get(f"{URL}{lead.id}", headers=h).json()["photo_url"] == PNG_1PX

        # The list row carries it too — the call list draws it beside the name.
        rows = client.get(URL, params={"per_page": 100}, headers=h).json()["leads"]
        assert next(x for x in rows if x["id"] == str(lead.id))["photo_url"] == PNG_1PX

        cleared = client.patch(f"{URL}{lead.id}", json={"photo_url": None}, headers=h)
        assert cleared.status_code == 200
        assert cleared.json()["photo_url"] is None

    def test_an_empty_string_clears_rather_than_422s(self, client, leads_db, auth_header):  # noqa: F811
        lead = _placeholder(leads_db)
        h = auth_header()
        client.patch(f"{URL}{lead.id}", json={"photo_url": WEBP_DATA}, headers=h)
        r = client.patch(f"{URL}{lead.id}", json={"photo_url": "  "}, headers=h)
        assert r.status_code == 200
        assert r.json()["photo_url"] is None

    def test_a_patch_without_the_key_keeps_the_photo(self, client, leads_db, auth_header):  # noqa: F811
        lead = _placeholder(leads_db)
        h = auth_header()
        client.patch(f"{URL}{lead.id}", json={"photo_url": WEBP_DATA}, headers=h)
        r = client.patch(f"{URL}{lead.id}", json={"notes": "called back"}, headers=h)
        assert r.json()["photo_url"] == WEBP_DATA

    def test_a_photo_patch_does_not_rekey_the_lead(self, client, leads_db, auth_header):  # noqa: F811
        lead = _placeholder(leads_db)
        key = lead.source_key
        client.patch(f"{URL}{lead.id}", json={"photo_url": WEBP_DATA}, headers=auth_header())
        leads_db.expire_all()
        assert leads_db.get(Lead, lead.id).source_key == key

    def test_create_takes_a_photo(self, client, leads_db, auth_header):  # noqa: F811
        r = client.post(
            URL,
            json={
                "company_name": "Photon Parts",
                "contact_name": "Ada Pix",
                "photo_url": WEBP_DATA,
            },
            headers=auth_header(),
        )
        assert r.status_code == 201, r.text
        assert r.json()["photo_url"] == WEBP_DATA

    def test_create_without_a_photo_stores_null(self, client, leads_db, auth_header):  # noqa: F811
        r = client.post(URL, json={"company_name": "No Face Co"}, headers=auth_header())
        assert r.status_code == 201
        assert r.json()["photo_url"] is None

    def test_a_hosted_url_is_accepted(self, client, leads_db, auth_header):  # noqa: F811
        lead = _placeholder(leads_db)
        r = client.patch(
            f"{URL}{lead.id}",
            json={"photo_url": "https://cdn.example.com/people/ada.jpg"},
            headers=auth_header(),
        )
        assert r.status_code == 200


class TestRefusals:
    @pytest.mark.parametrize("value", HOSTILE)
    def test_patch_refuses_a_non_image(self, client, leads_db, auth_header, value):  # noqa: F811
        lead = _placeholder(leads_db)
        r = client.patch(f"{URL}{lead.id}", json={"photo_url": value}, headers=auth_header())
        assert r.status_code == 422
        leads_db.expire_all()
        assert leads_db.get(Lead, lead.id).photo_url is None

    @pytest.mark.parametrize("value", HOSTILE)
    def test_create_refuses_a_non_image(self, client, leads_db, auth_header, value):  # noqa: F811
        r = client.post(
            URL, json={"company_name": "Hostile Pixels", "photo_url": value}, headers=auth_header()
        )
        assert r.status_code == 422
        assert r.json()["detail"][0]["loc"][-1] == "photo_url"
        assert leads_db.query(Lead).filter(Lead.company_name == "Hostile Pixels").count() == 0

    def test_an_oversized_blob_is_refused(self, client, leads_db, auth_header):  # noqa: F811
        lead = _placeholder(leads_db)
        huge = "data:image/png;base64," + ("A" * 250_000)
        r = client.patch(f"{URL}{lead.id}", json={"photo_url": huge}, headers=auth_header())
        assert r.status_code == 422


class TestStaffOnly:
    def test_a_viewer_cannot_read_or_set_a_photo(self, client, leads_db, auth_header):  # noqa: F811
        from app.models import User

        lead = _placeholder(leads_db)
        admin = leads_db.query(User).filter_by(username="admin").first()
        admin.role = "viewer"
        leads_db.commit()
        h = auth_header()
        assert client.get(f"{URL}{lead.id}", headers=h).status_code == 403
        assert (
            client.patch(f"{URL}{lead.id}", json={"photo_url": PNG_1PX}, headers=h).status_code
            == 403
        )

    def test_the_other_lead_feeds_do_not_carry_the_photo(self):
        """The dashboard's recent-calls feed, the rep page and the customer's
        own leads summary are hand-built dicts; none of them names the photo,
        and none needs it. If one starts to, decide it on purpose here."""
        routes = Path(__file__).resolve().parents[1] / "app" / "routes"
        for name in ("dashboard.py", "account_dashboard.py", "account.py"):
            assert "photo_url" not in (routes / name).read_text(), name
