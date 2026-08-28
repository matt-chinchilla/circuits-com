"""Customer-owned expenses and leads must never surface in the STAFF dashboard.

Migration 045 gave both tables a user_id (no FK — reseed safety); the admin
list/by-id endpoints already filter it (test_outbound_clicks.py). These pin
the two aggregate doors the schema pass flagged but could not reach:

  * GET /api/dashboard/leads/recent — the Leads panel feed joins LeadContact
    to Lead; without the filter a customer's own prospects surface in the
    company's feed.
  * GET /api/dashboard/expenses/breakdown (and the P&L series behind
    _company_rows) — summing expenses company-wide would add a customer's
    private cost lines to Circuit Center's own spend. Wrong as accounting
    before it is wrong as privacy.

Mutation-proven 2026-08-27: removing the Lead.user_id filter from
recent_lead_contacts reddens the first test; removing _company_rows from the
breakdown query reddens the second.
"""

import uuid
from datetime import date

from app.models import Expense, Lead, LeadContact, User


def _customer(db, email="private_rows@test.example"):
    u = User(username=email, email=email, password_hash="x", role="user")
    db.add(u)
    db.flush()
    return u


def test_a_customers_lead_contacts_stay_out_of_the_staff_feed(
    client, db, seeded_db, auth_header
):
    customer = _customer(db)
    company_lead = Lead(
        id=uuid.uuid4(), source_key="ours|acme", company_name="Acme (company row)",
        company_slug="acme-company-row",
    )
    customer_lead = Lead(
        id=uuid.uuid4(),
        source_key="theirs|globex",
        company_name="Globex (customer row)",
        company_slug="globex-customer-row",
        user_id=customer.id,
    )
    db.add_all([company_lead, customer_lead])
    db.flush()
    db.add_all(
        [
            LeadContact(lead_id=company_lead.id, outcome="maybe"),
            LeadContact(lead_id=customer_lead.id, outcome="maybe"),
        ]
    )
    db.commit()

    body = client.get("/api/dashboard/leads/recent", headers=auth_header()).json()
    companies = [c["company_name"] for c in body["contacts"]]
    assert "Acme (company row)" in companies
    assert "Globex (customer row)" not in companies


def test_a_customers_expenses_stay_out_of_the_company_books(
    client, db, seeded_db, auth_header
):
    customer = _customer(db)
    month = date(2026, 8, 1)
    db.add_all(
        [
            Expense(
                category="infrastructure", vendor="AWS - Circuit Center",
                amount=100, period_start=month, period_end=date(2026, 8, 31),
            ),
            Expense(
                category="infrastructure", vendor="Their Private Vendor",
                amount=77, period_start=month, period_end=date(2026, 8, 31),
                user_id=customer.id,
            ),
        ]
    )
    db.commit()

    body = client.get(
        "/api/dashboard/expenses/breakdown?month=2026-08", headers=auth_header()
    ).json()
    vendors = {
        v["vendor"] for row in body["categories"] for v in row["vendors"] if v["vendor"]
    }
    assert "AWS - Circuit Center" in vendors
    assert "Their Private Vendor" not in vendors
    infra = [r for r in body["categories"] if r["category"] == "infrastructure"]
    assert infra and float(infra[0]["amount"]) == 100.0
    assert float(body["total"]) == 100.0


def test_a_customers_lead_contacts_stay_out_of_the_rep_activity_feed(
    client, db, seeded_db, auth_header
):
    """The third door (found by review, 2026-08-27): /api/admin/leads/reps/{u}
    joins LeadContact to Lead by recorded_by with no owner filter, so a
    contact recorded against a customer-owned lead surfaced in the staff rep
    feed. Mutation-proven: dropping the Lead.user_id.is_(None) join filter in
    rep_activity reddens this."""
    customer = _customer(db, email="rep_feed@test.example")
    ours = Lead(id=uuid.uuid4(), source_key="ours|acme2",
                company_name="Acme Two", company_slug="acme-two")
    theirs = Lead(id=uuid.uuid4(), source_key="theirs|globex2",
                  company_name="Globex Two", company_slug="globex-two",
                  user_id=customer.id)
    db.add_all([ours, theirs])
    db.flush()
    db.add_all([
        LeadContact(lead_id=ours.id, outcome="maybe", recorded_by="matthew"),
        LeadContact(lead_id=theirs.id, outcome="maybe", recorded_by="matthew"),
    ])
    db.commit()

    body = client.get("/api/admin/leads/reps/matthew", headers=auth_header()).json()
    names = [c.get("company_name") for c in body.get("contacts", [])]
    assert "Acme Two" in names
    assert "Globex Two" not in names
