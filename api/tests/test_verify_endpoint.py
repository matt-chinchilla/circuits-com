"""POST /api/auth/verify and /api/auth/resend-verification.

The two Message rows are the point of this file. Side effects fire on VERIFY,
never on submit (D6): otherwise anyone with a script sprays the staff inbox and
mails strangers an unrequested "welcome".
"""

from datetime import UTC, datetime

from app.models import Message, User
from app.services import auth_service
from app.services import email as email_service
from app.services.auth_service import create_token, create_verify_token
from app.services.rate_limit import limiter, reset_probes

GOOD = {
    "first_name": "James",
    "last_name": "Chirichella",
    "email": "james@test.example",
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
    assert staff.payload["first_name"] == "James"

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

    assert sent == {"to": "james@test.example", "first_name": "James"}


# ── The link goes stale (D13) ───────────────────────────────────────────────


def test_an_expired_link_verifies_nobody(client, db, monkeypatch):
    """A 24-hour window is a security property, so something has to measure it.

    Every other test here holds if the `exp` claim is deleted from
    create_verify_token — the link would simply never die, and a token sitting
    in an old mailbox (or a forwarded one) would still open the account a year
    later. This mints one whose window has already closed.
    """
    user = _signup(client, db)
    monkeypatch.setattr(auth_service, "VERIFY_EXPIRY_HOURS", -1)
    stale = create_verify_token(str(user.id), user.email)

    r = client.post("/api/auth/verify", json={"token": stale})
    assert r.status_code == 400
    # The same body a garbage token gets: a dead link tells you nothing about
    # whether the account exists.
    assert r.json()["detail"] == "invalid_or_expired_token"

    db.expire_all()
    assert db.query(User).filter(User.email == GOOD["email"]).one().email_verified_at is None
    assert db.query(Message).count() == 0


# ── Single use, under a real interleaving ───────────────────────────────────


def test_the_stamp_is_what_claims_the_verification(client, db, monkeypatch):
    """test_verify_is_single_use replays the link SEQUENTIALLY, so the "already
    verified?" read has always committed by the time the second request runs.
    Two requests in flight together — a double-clicked link, a mail client that
    opens the page twice — both pass that read, and both then fire the side
    effects: two staff rows, two welcome mails, or a 500 when the second pair
    of INSERTs collides on the unique Message.seq.

    The interleaving is reproduced with the ORM's own identity map: the row is
    stamped underneath the session, so the instance the route loads still
    reports email_verified_at = None. That IS the losing caller's state when
    the winner commits between its read and its write.
    """
    sent: list[str] = []

    async def _capture(to_email, first_name):
        sent.append(to_email)
        return True

    monkeypatch.setattr(email_service, "send_welcome_email", _capture)
    user = _signup(client, db)
    token = create_verify_token(str(user.id), user.email)

    db.query(User).filter(User.id == user.id).update(
        {User.email_verified_at: datetime.now(UTC)}, synchronize_session=False
    )
    assert user.email_verified_at is None, "the loaded instance must still be stale"

    r = client.post("/api/auth/verify", json={"token": token})
    assert r.status_code == 400
    assert r.json()["detail"] == "already_verified"
    # The whole point: no second staff row, no second welcome.
    assert db.query(Message).count() == 0
    assert sent == []
