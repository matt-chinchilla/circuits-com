"""Leads API — gate, outcomes, denorms, rep pages."""

import csv

import pytest

from app.db.seed_leads import seed_leads
from app.models import Lead, LeadContact
from app.services.leads import record_outcome
from tests.test_leads_seed import HEADERS, ROWS


@pytest.fixture
def leads_db(db, seeded_db, tmp_path):
    p = tmp_path / "leads.csv"
    with open(p, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=HEADERS)
        w.writeheader()
        for r in ROWS:
            w.writerow({h: r.get(h, "") for h in HEADERS})
    seed_leads(db, csv_path=p)
    db.commit()
    return db


def _demo_header(client, db):
    """A live demo session — requires the demo user row (fixture pattern from
    test_demo_read_only)."""
    import bcrypt

    from app.models import User

    if db.query(User).filter_by(username="demo").first() is None:
        db.add(User(
            username="demo",
            password_hash=bcrypt.hashpw(b"demo", bcrypt.gensalt()).decode(),
            role="admin",
            email="demo@circuitcenter.ai",
        ))
        db.commit()
    body = client.post("/api/auth/demo").json()
    return {"Authorization": f"Bearer {body['token']}"}


class TestGate:
    def test_anonymous_401(self, client, leads_db):
        assert client.get("/api/admin/leads/").status_code in (401, 403)

    def test_demo_refused_on_reads(self, client, leads_db):
        h = _demo_header(client, leads_db)
        resp = client.get("/api/admin/leads/", headers=h)
        assert resp.status_code == 403
        assert resp.json()["detail"] == "demo_account_no_leads"

    def test_demo_refused_on_detail_and_reps(self, client, leads_db):
        h = _demo_header(client, leads_db)
        lead = leads_db.query(Lead).first()
        assert client.get(f"/api/admin/leads/{lead.id}", headers=h).status_code == 403
        assert client.get("/api/admin/leads/reps/admin", headers=h).status_code == 403

    def test_forced_password_change_blocks_reads_and_writes(self, client, leads_db, auth_header):
        """The leads router was the ONE admin surface that skipped the forced-reset
        gate: it depended on `get_authenticated_user`, where the flag is only
        enforced by `get_current_user`. A flagged staffer could read the roster
        and PATCH a lead while every other admin page 403'd them."""
        from app.models import User

        h = auth_header()
        user = leads_db.query(User).filter_by(username="admin").first()
        user.must_change_password = True
        leads_db.commit()
        lead = leads_db.query(Lead).first()

        read = client.get("/api/admin/leads/", headers=h)
        assert read.status_code == 403
        assert read.json()["detail"] == "password_change_required"

        write = client.patch(
            f"/api/admin/leads/{lead.id}", json={"notes": "nope"}, headers=h
        )
        assert write.status_code == 403
        assert write.json()["detail"] == "password_change_required"

    def test_admin_sees_data(self, client, leads_db, auth_header):
        resp = client.get("/api/admin/leads/", headers=auth_header())
        assert resp.status_code == 200
        assert resp.json()["total"] == 5


class TestListFilters:
    def test_enrichment_filter(self, client, leads_db, auth_header):
        body = client.get("/api/admin/leads/?needs_enrichment=true", headers=auth_header()).json()
        assert body["total"] == 1
        assert body["leads"][0]["contact_name"] is None

    def test_outcome_none_filter(self, client, leads_db, auth_header):
        body = client.get("/api/admin/leads/?outcome=none", headers=auth_header()).json()
        assert body["total"] == 5


class TestOutcomes:
    def test_record_via_api_stamps_logged_in_user(self, client, leads_db, auth_header):
        lead = leads_db.query(Lead).filter(Lead.contact_name == "Kim Ray").one()
        resp = client.post(
            f"/api/admin/leads/{lead.id}/contacts",
            json={"outcome": "converted", "sale_tier": "gold", "note": "great call"},
            headers=auth_header(),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["last_outcome"] == "converted"
        assert body["contact_attempts"] == 1
        assert body["contacts"][0]["recorded_by"] == "admin"
        assert body["contacts"][0]["sale_tier"] == "gold"

    def test_invalid_outcome_422(self, client, leads_db, auth_header):
        lead = leads_db.query(Lead).first()
        resp = client.post(
            f"/api/admin/leads/{lead.id}/contacts",
            json={"outcome": "ghosted"}, headers=auth_header(),
        )
        assert resp.status_code == 422

    def test_recontact_appends_history(self, client, leads_db, auth_header):
        lead = leads_db.query(Lead).filter(Lead.contact_name == "Kim Ray").one()
        h = auth_header()
        client.post(f"/api/admin/leads/{lead.id}/contacts", json={"outcome": "maybe"}, headers=h)
        client.post(f"/api/admin/leads/{lead.id}/contacts", json={"outcome": "converted"}, headers=h)
        body = client.get(f"/api/admin/leads/{lead.id}", headers=h).json()
        assert body["contact_attempts"] == 2
        assert [c["outcome"] for c in body["contacts"]] == ["converted", "maybe"]

    def test_denorm_service_direct(self, leads_db):
        lead = leads_db.query(Lead).filter(Lead.contact_name == "Pat Doe").one()
        record_outcome(leads_db, lead, "rejected", None, None, "daniel")
        assert lead.last_outcome == "rejected"
        assert lead.contact_attempts == 1
        assert leads_db.query(LeadContact).filter_by(lead_id=lead.id).count() == 1

    def test_sale_tier_writes_no_sponsor_row(self, client, leads_db, auth_header):
        from app.models import Sponsor
        before = leads_db.query(Sponsor).count()
        lead = leads_db.query(Lead).filter(Lead.contact_name == "Kim Ray").one()
        client.post(
            f"/api/admin/leads/{lead.id}/contacts",
            json={"outcome": "converted", "sale_tier": "platinum"}, headers=auth_header(),
        )
        assert leads_db.query(Sponsor).count() == before


class TestRepPage:
    def test_rep_activity(self, client, leads_db, auth_header):
        h = auth_header()
        lead = leads_db.query(Lead).filter(Lead.contact_name == "Kim Ray").one()
        client.post(f"/api/admin/leads/{lead.id}/contacts", json={"outcome": "maybe"}, headers=h)
        body = client.get("/api/admin/leads/reps/admin", headers=h).json()
        assert body["outcome_mix"] == {"maybe": 1}
        assert body["contacts"][0]["company_name"] == "Lumissil"


class TestEnrichmentEdit:
    def test_patch_clears_enrichment(self, client, leads_db, auth_header):
        lead = leads_db.query(Lead).filter(Lead.needs_enrichment.is_(True)).one()
        resp = client.patch(
            f"/api/admin/leads/{lead.id}",
            json={"contact_name": "Found Person", "contact_title": "Buyer"},
            headers=auth_header(),
        )
        assert resp.status_code == 200
        assert resp.json()["needs_enrichment"] is False


class TestSortNulls:
    def test_desc_sort_keeps_nulls_last(self, client, leads_db, auth_header):
        """Review finding: Postgres floats NULLs FIRST on DESC — 'Newest first'
        must never rank never-contacted rows above contacted ones."""
        from app.models import Lead
        from app.services.leads import record_outcome

        lead = leads_db.query(Lead).filter(Lead.contact_name == "Kim Ray").one()
        record_outcome(leads_db, lead, "maybe", None, None, "admin")
        body = client.get(
            "/api/admin/leads/?sort=contacted&desc=true", headers=auth_header()
        ).json()
        assert body["leads"][0]["contact_name"] == "Kim Ray"
        assert body["leads"][0]["last_contacted_at"] is not None

    def test_rep_contacts_carry_recorded_by(self, client, leads_db, auth_header):
        from app.models import Lead
        from app.services.leads import record_outcome

        lead = leads_db.query(Lead).filter(Lead.contact_name == "Kim Ray").one()
        record_outcome(leads_db, lead, "converted", None, None, "admin")
        body = client.get("/api/admin/leads/reps/admin", headers=auth_header()).json()
        assert body["contacts"][0]["recorded_by"] == "admin"
