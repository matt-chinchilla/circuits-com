import pathlib
from datetime import UTC, datetime

from app.models import Message, Sponsor, Supplier, User
from app.services.auth_service import hash_password

PW = "Analytical1!"


def _activated(db, supplier_id=None):
    u = User(username="c@test.example", email="c@test.example",
             password_hash=hash_password(PW), role="user",
             first_name="James", supplier_id=supplier_id,
             email_verified_at=datetime.now(UTC), activated_at=datetime.now(UTC))
    db.add(u)
    db.flush()
    return u


def _login(client, email="c@test.example", password=PW):
    r = client.post("/api/auth/login", json={"email": email, "password": password})
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_self_delete_requires_the_current_password(client, db):
    _activated(db)
    db.commit()
    h = _login(client)
    r = client.request("DELETE", "/api/account/me",
                       json={"password": "Wrong1!aa"}, headers=h)
    assert r.status_code == 401
    assert db.query(User).filter(User.email == "c@test.example").count() == 1


def test_self_delete_removes_the_login_and_their_messages(client, db):
    u = _activated(db)
    db.add(Message(id="m1", type="welcome", status="new", seq=9001,
                           user_id=u.id, payload={}))
    db.add(Message(id="m2", type="signup", status="new", seq=9002,
                           user_id=None, payload={}))
    db.commit()
    h = _login(client)
    r = client.request("DELETE", "/api/account/me", json={"password": PW}, headers=h)
    assert r.status_code == 200
    db.expire_all()
    assert db.query(User).filter(User.email == "c@test.example").count() == 0
    assert db.query(Message).filter(Message.id == "m1").count() == 0
    # The staff-inbox row is NOT theirs and must survive.
    assert db.query(Message).filter(Message.id == "m2").count() == 1


def test_self_delete_never_touches_the_company(client, db, seeded_db):
    supplier = db.query(Supplier).first()
    sponsors_before = db.query(Sponsor).filter(
        Sponsor.supplier_id == supplier.id).count()
    _activated(db, supplier_id=supplier.id)
    db.commit()
    h = _login(client)
    r = client.request("DELETE", "/api/account/me", json={"password": PW}, headers=h)
    db.expire_all()
    # The delete has to have HAPPENED for the rest of this to mean anything —
    # without these two lines every assertion below passes on a route that does
    # nothing at all (mutation-verified).
    assert r.status_code == 200
    assert db.query(User).filter(User.email == "c@test.example").count() == 0
    # An account is a key to the building, not the building. Deleting a login
    # must never pull a paid ad off a board.
    assert db.query(Supplier).filter(Supplier.id == supplier.id).count() == 1
    assert db.query(Sponsor).filter(
        Sponsor.supplier_id == supplier.id).count() == sponsors_before


def test_a_live_placement_outlives_the_account_that_bought_it(client, db, seeded_db):
    """The paid-inventory case, spelled out.

    The test above takes whichever Supplier comes back first, which is the one
    holding NO sponsorships — so its sponsor assertion is 0 == 0. This one picks
    the company that actually has a placement on a public board and proves the
    row is still there, unchanged, after its buyer closes their sign-in.
    """
    supplier = seeded_db["supplier2"]
    sponsor_id = seeded_db["sponsor"].id
    assert db.query(Sponsor).filter(Sponsor.supplier_id == supplier.id).count() == 1

    _activated(db, supplier_id=supplier.id)
    db.commit()
    h = _login(client)
    # The tier is DERIVED from that live placement, so it is visible right up
    # until the moment the account goes.
    assert client.get("/api/account/me", headers=h).json()["tier"] == "gold"

    r = client.request("DELETE", "/api/account/me", json={"password": PW}, headers=h)
    assert r.status_code == 200
    db.expire_all()
    assert db.query(User).filter(User.email == "c@test.example").count() == 0

    survivor = db.query(Sponsor).filter(Sponsor.id == sponsor_id).one()
    assert survivor.supplier_id == supplier.id
    assert survivor.category_id == seeded_db["child"].id
    assert survivor.tier == "gold"
    assert db.query(Supplier).filter(Supplier.id == supplier.id).one().name == (
        "Kennedy Electronics"
    )


def test_the_session_dies_with_the_account(client, db):
    _activated(db)
    db.commit()
    h = _login(client)
    assert client.request(
        "DELETE", "/api/account/me", json={"password": PW}, headers=h
    ).status_code == 200
    # The token is still cryptographically valid; the user behind it is not.
    assert client.get("/api/account/me", headers=h).status_code == 401


def test_staff_cannot_use_the_customer_danger_zone(client, db, seeded_db, auth_header):
    """require_account_user, not get_current_user: this router is the CUSTOMER's
    own account. An admin destroying a row here would bypass /api/admin/users."""
    h = auth_header()
    assert client.get("/api/account/me", headers=h).status_code == 403
    r = client.request("DELETE", "/api/account/me",
                       json={"password": "testpass123"}, headers=h)
    assert r.status_code == 403
    assert r.json()["detail"] == "staff_only"
    db.expire_all()
    assert db.query(User).filter(User.email == "admin@test.example").count() == 1


def test_deletion_reaches_nothing_outside_this_database():
    """Closing an account must never cancel a subscription.

    A live placement keeps billing because billing is not this route's business:
    the money is cancelled by a human at the desk, deliberately, after somebody
    decides the placement is over. Asserted on the module's IMPORTS rather than
    a text grep, so the docstring that explains the rule cannot trip it.
    """
    import ast

    from app.routes import account

    tree = ast.parse(pathlib.Path(account.__file__).read_text())
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            # BOTH halves: `from app.services import stripe_checkout` hides the
            # interesting name in `names`, not in `module`.
            imported.add(node.module)
            imported.update(f"{node.module}.{a.name}" for a in node.names)
    assert not [m for m in imported if "stripe" in m.lower()], imported
    # No outbound HTTP of any kind, either.
    assert not [m for m in imported if m.split(".")[0] in
                {"httpx", "requests", "urllib", "http", "aiohttp"}], imported


def test_me_reports_tier_and_activation(client, db):
    _activated(db)
    db.commit()
    r = client.get("/api/account/me", headers=_login(client))
    assert r.status_code == 200
    body = r.json()
    assert body["tier"] == "free"
    assert body["activated"] is True


def test_an_unactivated_customer_is_refused(client, db):
    u = User(username="u@test.example", email="u@test.example",
             password_hash=hash_password(PW), role="user",
             email_verified_at=datetime.now(UTC), activated_at=None)
    db.add(u)
    db.commit()
    r = client.get("/api/account/me", headers=_login(client, "u@test.example"))
    assert r.status_code == 403
    assert r.json()["detail"] == "account_not_activated"


def test_self_delete_takes_their_private_book_and_leads_along(client, db):
    """expenses.user_id / leads.user_id carry NO FK (reseed safety), so no
    cascade exists — BOTH delete doors pay the cleanup explicitly, and this
    pins the self-serve one. Without it the rows outlive the account:
    invisible to staff (user_id IS NOT NULL) and unreachable by their owner.

    Mutation-proven 2026-08-27: removing the two cleanup deletes in
    account.delete_me reddens exactly this test.
    """
    from datetime import date

    from app.models import Expense, Lead

    u = _activated(db)
    other = User(username="other@test.example", email="other@test.example",
                 password_hash=hash_password(PW), role="user",
                 email_verified_at=datetime.now(UTC), activated_at=datetime.now(UTC))
    db.add(other)
    db.flush()
    db.add(Expense(category="logistics", vendor="FedEx", amount=42,
                   period_start=date(2026, 8, 1), period_end=date(2026, 8, 1),
                   user_id=u.id))
    db.add(Lead(company_name="Globex", company_slug="globex",
                source_key="theirs|globex", user_id=u.id))
    db.add(Expense(category="logistics", vendor="Kept", amount=7,
                   period_start=date(2026, 8, 1), period_end=date(2026, 8, 1),
                   user_id=other.id))
    db.commit()

    h = _login(client)
    assert client.request("DELETE", "/api/account/me",
                          json={"password": PW}, headers=h).status_code == 200
    db.expire_all()
    assert db.query(Expense).filter(Expense.user_id == u.id).count() == 0
    assert db.query(Lead).filter(Lead.user_id == u.id).count() == 0
    # Another customer's book is untouched — the cleanup is keyed, not a sweep.
    assert db.query(Expense).filter(Expense.user_id == other.id).count() == 1
