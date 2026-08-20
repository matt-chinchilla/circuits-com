"""Dashboard leads feed + manufacturers_count — the second privacy door."""

from app.models import Lead
from app.services.leads import record_outcome
from tests.test_admin_leads import _demo_header, leads_db  # noqa: F401 (fixture reuse)


def test_stats_has_manufacturers_count(client, seeded_db, auth_header):
    body = client.get("/api/dashboard/stats", headers=auth_header()).json()
    assert "manufacturers_count" in body


def test_recent_feed_order_and_shape(client, leads_db, auth_header):
    h = auth_header()
    leads = leads_db.query(Lead).filter(Lead.contact_name.isnot(None)).limit(3).all()
    for i, lead in enumerate(leads):
        record_outcome(leads_db, lead, ["converted", "maybe", "rejected"][i], None, None, "admin")
    body = client.get("/api/dashboard/leads/recent?limit=2", headers=h).json()
    assert len(body["contacts"]) == 2
    assert body["contacts"][0]["outcome"] == "rejected"  # most recent first
    assert body["contacts"][0]["recorded_by"] == "admin"


def test_recent_feed_refuses_demo(client, leads_db):
    h = _demo_header(client, leads_db)
    resp = client.get("/api/dashboard/leads/recent", headers=h)
    assert resp.status_code == 403
    assert resp.json()["detail"] == "demo_account_no_leads"


def test_limit_capped(client, leads_db, auth_header):
    resp = client.get("/api/dashboard/leads/recent?limit=9999", headers=auth_header())
    assert resp.status_code == 200
