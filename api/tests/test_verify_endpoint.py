"""POST /api/auth/verify and /api/auth/resend-verification.

The two Message rows are the point of this file. Side effects fire on VERIFY,
never on submit (D6): otherwise anyone with a script sprays the staff inbox and
mails strangers an unrequested "welcome".
"""

from app.models import Message, User
from app.services import email as email_service
from app.services.auth_service import create_token, create_verify_token
from app.services.rate_limit import limiter, reset_probes

GOOD = {
    "first_name": "Ada",
    "last_name": "Lovelace",
    "email": "ada@test.example",
    "password": "Analytical1!",
}


def setup_function():
    limiter.reset()
    reset_probes()


def _signup(client, db):
    client.post("/api/auth/signup", json=GOOD)
    return db.query(User).filter(User.email == GOOD["email"]).first()


def test_signup_alone_creates_no_messages(client, db):
    # D6: side effects fire on VERIFY, never on submit. Otherwise anyone with
    # a script sprays the staff inbox and mails strangers a "welcome".
    before = db.query(Message).count()
    _signup(client, db)
    assert db.query(Message).count() == before


def test_verify_stamps_and_creates_both_messages(client, db):
    user = _signup(client, db)
    token = create_verify_token(str(user.id), user.email)
    r = client.post("/api/auth/verify", json={"token": token})
    assert r.status_code == 200

    db.expire_all()
    user = db.query(User).filter(User.email == GOOD["email"]).first()
    assert user.email_verified_at is not None
    assert user.activated_at is None  # verification is not activation

    staff = db.query(Message).filter(Message.type == "signup").one()
    assert staff.user_id is None  # the shared staff inbox
    assert staff.payload["first_name"] == "Ada"

    welcome = db.query(Message).filter(Message.type == "welcome").one()
    assert welcome.user_id == user.id


def test_verify_is_single_use(client, db):
    user = _signup(client, db)
    token = create_verify_token(str(user.id), user.email)
    assert client.post("/api/auth/verify", json={"token": token}).status_code == 200
    r = client.post("/api/auth/verify", json={"token": token})
    assert r.status_code == 400
    assert db.query(Message).filter(Message.type == "signup").count() == 1


def test_a_session_token_cannot_verify(client, db):
    user = _signup(client, db)
    r = client.post("/api/auth/verify", json={"token": create_token(str(user.id), "user")})
    assert r.status_code == 400


def test_garbage_token_is_rejected(client):
    assert client.post("/api/auth/verify", json={"token": "nope"}).status_code == 400


def test_resend_is_generic_for_an_unknown_address(client):
    # Resend has no UX reason to be an oracle, so it keeps the invariant.
    r = client.post("/api/auth/resend-verification", json={"email": "nobody@test.example"})
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_resend_is_generic_for_an_already_verified_address(client, db):
    user = _signup(client, db)
    client.post("/api/auth/verify", json={"token": create_verify_token(str(user.id), user.email)})
    r = client.post("/api/auth/resend-verification", json={"email": user.email})
    assert r.json() == {"status": "ok"}


# ── The sends themselves ────────────────────────────────────────────────────
# Because the reply is a constant either way, EVERY assertion above still
# passes if both endpoints are stubs that mail nothing. These two are what
# make the generic-OK tests mean something.


def test_resend_mails_a_link_that_actually_verifies(client, db, monkeypatch):
    sent: dict[str, str] = {}

    async def _capture(to_email, first_name, verify_url):
        sent.update(to=to_email, url=verify_url)
        return True

    user = _signup(client, db)
    monkeypatch.setattr(email_service, "send_verification_email", _capture)
    client.post("/api/auth/resend-verification", json={"email": user.email.upper()})

    assert sent["to"] == user.email  # matched case-insensitively, mailed lowercased
    # A FRESH token, not a replay of the first: the usual reason somebody is on
    # this screen is that the original expired.
    token = sent["url"].partition("?token=")[2]
    assert client.post("/api/auth/verify", json={"token": token}).status_code == 200


def test_verify_mails_the_welcome(client, db, monkeypatch):
    sent: dict[str, str] = {}

    async def _capture(to_email, first_name):
        sent.update(to=to_email, first_name=first_name)
        return True

    user = _signup(client, db)
    monkeypatch.setattr(email_service, "send_welcome_email", _capture)
    client.post("/api/auth/verify", json={"token": create_verify_token(str(user.id), user.email)})

    assert sent == {"to": "ada@test.example", "first_name": "Ada"}
