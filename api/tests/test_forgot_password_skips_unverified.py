"""D14: an unverified account never receives a reset link.

The right door for someone who never verified is resend-verification. Each
door does one job.
"""
from unittest.mock import patch

from app.models import User
from app.services.auth_service import create_verify_token
from app.services.rate_limit import limiter, reset_probes

GOOD = {"first_name": "Ada", "last_name": "Lovelace",
        "email": "ada@test.example", "password": "Analytical1!"}


def setup_function():
    limiter.reset()
    reset_probes()


def test_no_reset_mail_for_an_unverified_account(client, db):
    client.post("/api/auth/signup", json=GOOD)
    with patch("app.routes.auth.email_service.send_password_reset") as sender:
        r = client.post("/api/auth/forgot-password", json={"identifier": GOOD["email"]})
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
    sender.assert_not_called()


def test_the_response_is_identical_to_the_verified_case(client, db):
    client.post("/api/auth/signup", json=GOOD)
    unverified = client.post("/api/auth/forgot-password",
                             json={"identifier": GOOD["email"]})
    user = db.query(User).filter(User.email == GOOD["email"]).first()
    client.post("/api/auth/verify",
                json={"token": create_verify_token(str(user.id), user.email)})
    verified = client.post("/api/auth/forgot-password",
                           json={"identifier": GOOD["email"]})
    assert unverified.status_code == verified.status_code
    assert unverified.json() == verified.json()


def test_login_refuses_an_unverified_customer_with_the_right_password(client, db):
    client.post("/api/auth/signup", json=GOOD)
    r = client.post("/api/auth/login",
                    json={"email": GOOD["email"], "password": GOOD["password"]})
    assert r.status_code == 403
    assert r.json()["detail"] == "email_not_verified"


def test_a_wrong_password_still_gets_the_generic_401(client, db):
    # Learning "unverified" must require ALREADY knowing the password, or
    # login becomes an account-existence oracle.
    client.post("/api/auth/signup", json=GOOD)
    r = client.post("/api/auth/login",
                    json={"email": GOOD["email"], "password": "Wrong1!aa"})
    assert r.status_code == 401
    assert r.json()["detail"] == "Invalid credentials"


def test_a_verified_customer_can_sign_in(client, db):
    client.post("/api/auth/signup", json=GOOD)
    user = db.query(User).filter(User.email == GOOD["email"]).first()
    client.post("/api/auth/verify",
                json={"token": create_verify_token(str(user.id), user.email)})
    r = client.post("/api/auth/login",
                    json={"email": GOOD["email"], "password": GOOD["password"]})
    assert r.status_code == 200
    assert r.json()["user"]["role"] == "user"


def test_a_verified_customer_still_gets_the_reset_link(client, db):
    """The POSITIVE half of D14, and the reason the negative half means
    anything.

    Every other test in this file passes if the skip is widened from "customers
    who never verified" to "customers", or to "everyone" — the reply is a
    constant, so a route that mails NOBODY looks identical from the outside.
    This is the one that notices.
    """
    client.post("/api/auth/signup", json=GOOD)
    user = db.query(User).filter(User.email == GOOD["email"]).first()
    client.post("/api/auth/verify",
                json={"token": create_verify_token(str(user.id), user.email)})

    with patch("app.routes.auth.email_service.send_password_reset") as sender:
        r = client.post("/api/auth/forgot-password", json={"identifier": GOOD["email"]})

    assert r.status_code == 200
    sender.assert_called_once()
    to_email, _username, reset_url = sender.call_args.args
    assert to_email == GOOD["email"]
    # A real, freshly minted link — not an empty string the assertion above
    # would have accepted.
    assert "/admin/reset-password?token=" in reset_url
    assert reset_url.rpartition("token=")[2]
