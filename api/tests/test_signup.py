"""POST /api/auth/signup — the public front door for a customer account.

Two properties this file exists to pin:

* Signup creates an UNVERIFIED, UNACTIVATED customer and returns NO token.
  There is no session until the mailbox is proved, which is what makes
  "notify staff on verify, never on submit" (D6) enforceable rather than
  advisory.
* D5's explicit `409 email_taken` — the one place in this API where
  anti-enumeration is deliberately traded away for UX — is PAID FOR by the
  distinct-address probe counter, and the payment is a real one-hour pause.
"""

import uuid as uuid_mod

from app.config import settings
from app.models import User
from app.services import email as email_service
from app.services.auth_service import decode_verify_token, verify_token_matches_email
from app.services.rate_limit import (
    MAX_LOCK_SECONDS,
    PROBE_DISTINCT_THRESHOLD,
    PROBE_LOCK_SECONDS,
    limiter,
    reset_probes,
)

GOOD = {
    "first_name": "James",
    "last_name": "Chirichella",
    "email": "James@Test.Example",
    "password": "Analytical1!",
}


def setup_function():
    limiter.reset()
    reset_probes()


def _existing(db, email: str) -> User:
    """A registered account, minted directly — signing 8 of them up through
    the route would cost 8 bcrypt hashes to prove nothing about hashing."""
    user = User(
        id=uuid_mod.uuid4(),
        username=email,
        email=email,
        password_hash="x",
        role="user",
    )
    db.add(user)
    db.commit()
    return user


def test_returns_202_and_no_token(client):
    r = client.post("/api/auth/signup", json=GOOD)
    assert r.status_code == 202
    assert r.json() == {"status": "ok"}
    assert "token" not in r.json()  # no session until verified


def test_creates_an_unverified_unactivated_customer(client, db):
    client.post("/api/auth/signup", json=GOOD)
    u = db.query(User).filter(User.email == "James@test.example").first()
    assert u is not None
    assert u.role == "user"
    assert u.email_verified_at is None
    assert u.activated_at is None
    assert u.must_change_password is False


def test_username_is_the_lowercased_email(client, db):
    client.post("/api/auth/signup", json=GOOD)
    u = db.query(User).filter(User.email == "James@test.example").first()
    assert u.username == "James@test.example"


def test_capability_links_are_never_set_by_signup(client, db):
    client.post("/api/auth/signup", json=GOOD)
    u = db.query(User).filter(User.email == "James@test.example").first()
    assert u.supplier_id is None
    assert u.manufacturer_id is None


def test_a_body_that_tries_to_set_privilege_is_rejected(client):
    r = client.post("/api/auth/signup", json={**GOOD, "role": "owner"})
    assert r.status_code == 422  # extra="forbid"


def test_confirm_password_is_not_accepted_on_the_wire(client):
    # D11: it is a client-side check. Sending it would put a second copy of a
    # live credential on the wire for no added assurance.
    r = client.post("/api/auth/signup", json={**GOOD, "confirm_password": "Analytical1!"})
    assert r.status_code == 422


def test_a_weak_password_returns_the_shared_policy_shape(client):
    r = client.post("/api/auth/signup", json={**GOOD, "password": "short"})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "password_policy"
    assert "length" in detail["unmet"]


def test_duplicate_email_is_reported_plainly(client):
    client.post("/api/auth/signup", json=GOOD)
    r = client.post("/api/auth/signup", json={**GOOD, "email": "James@test.example"})
    assert r.status_code == 409
    assert r.json()["detail"] == "email_taken"


def test_duplicate_detection_is_case_insensitive(client):
    client.post("/api/auth/signup", json=GOOD)
    r = client.post("/api/auth/signup", json={**GOOD, "email": "James@TEST.EXAMPLE"})
    assert r.status_code == 409


def test_an_existing_staff_address_is_also_taken(client, seeded_db):
    # Signing up must never be a way to shadow (or collide with) a staff
    # account. seeded_db's admin is the staff row this suite actually has.
    r = client.post("/api/auth/signup", json={**GOOD, "email": "admin@test.example"})
    assert r.status_code == 409


# ── The address we record ───────────────────────────────────────────────────


def test_the_recorded_signup_ip_is_an_address_not_a_rate_limit_bucket(client, db):
    # client_ip() collapses IPv6 to its /64 because that is the right shape for
    # a bucket KEY and the wrong shape for a stored address: a CIDR is not
    # where anybody signed up, and geoip rejects it outright (which is how
    # every IPv6 visitor once landed on the analytics map as "unknown").
    client.post("/api/auth/signup", json=GOOD, headers={"X-Real-IP": "2001:db8:1:2::5"})
    u = db.query(User).filter(User.email == "James@test.example").first()
    assert u.signup_ip == "2001:db8:1:2::5"


def test_a_signup_with_no_readable_address_records_none(client, db):
    # TestClient's host is the literal string "testclient". Storing that (or
    # "unknown") in signup_ip would be inventing data; None is the truth.
    client.post("/api/auth/signup", json=GOOD)
    u = db.query(User).filter(User.email == "James@test.example").first()
    assert u.signup_ip is None
    assert u.signup_country is None


# ── The link we mail ────────────────────────────────────────────────────────


def test_the_verification_link_is_built_from_the_configured_origin(client, db, monkeypatch):
    """The URL origin is settings.APP_BASE_URL, never the request Host.

    ProxyHeadersMiddleware trusts every host, so a link built from the request
    would let an attacker poison the one email a registrant is most likely to
    click. Same rule /forgot-password already follows.
    """
    sent: dict[str, str] = {}

    async def _capture(to_email, first_name, verify_url):
        sent.update(to=to_email, first_name=first_name, url=verify_url)
        return True

    monkeypatch.setattr(email_service, "send_verification_email", _capture)
    client.post("/api/auth/signup", json=GOOD, headers={"Host": "poisoned.test.example"})

    base = settings.APP_BASE_URL.rstrip("/")
    assert sent["url"].startswith(f"{base}/admin/verify?token=")
    assert "poisoned" not in sent["url"]
    assert sent["to"] == "James@test.example"
    assert sent["first_name"] == "James"


def test_the_minted_token_names_this_user_and_this_address(client, db, monkeypatch):
    # If either half were wrong, every link would be minted dead and the
    # failure would only surface in Task 8's verify route.
    sent: dict[str, str] = {}

    async def _capture(to_email, first_name, verify_url):
        sent["url"] = verify_url
        return True

    monkeypatch.setattr(email_service, "send_verification_email", _capture)
    client.post("/api/auth/signup", json=GOOD)

    token = sent["url"].partition("?token=")[2]
    payload = decode_verify_token(token)
    u = db.query(User).filter(User.email == "James@test.example").first()
    assert payload["sub"] == str(u.id)
    assert verify_token_matches_email(payload, "James@test.example")


# ── What pays for the 409 (spec §6, middle row) ─────────────────────────────


def test_one_forgetful_customer_retrying_one_address_is_never_paused(client, db):
    # The entire reason the signal is DISTINCT values and not attempts.
    _existing(db, "James@test.example")
    for _ in range(20):
        assert client.post("/api/auth/signup", json=GOOD).status_code == 409
    fresh = client.post("/api/auth/signup", json={**GOOD, "email": "grace@test.example"})
    assert fresh.status_code == 202


def test_seven_distinct_taken_addresses_are_still_under_the_threshold(client, db):
    for i in range(PROBE_DISTINCT_THRESHOLD - 1):
        _existing(db, f"taken{i}@test.example")
        r = client.post("/api/auth/signup", json={**GOOD, "email": f"taken{i}@test.example"})
        assert r.status_code == 409
    fresh = client.post("/api/auth/signup", json={**GOOD, "email": "grace@test.example"})
    assert fresh.status_code == 202


def test_walking_distinct_taken_addresses_arms_a_pause(client, db):
    for i in range(PROBE_DISTINCT_THRESHOLD):
        _existing(db, f"taken{i}@test.example")
        r = client.post("/api/auth/signup", json={**GOOD, "email": f"taken{i}@test.example"})
        assert r.status_code == 409, f"probe {i} should still answer 409"

    blocked = client.post("/api/auth/signup", json={**GOOD, "email": "grace@test.example"})
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == "too_many_requests"


def test_the_pause_is_the_specified_hour_and_not_the_login_ladder(client, db):
    # The spec's threshold table says "1 hour pause". limiter.record_failure
    # would deliver 60 seconds (the login ladder's first rung) and leave
    # PROBE_LOCK_SECONDS a constant that lies. This is the assertion that
    # tells the two apart.
    for i in range(PROBE_DISTINCT_THRESHOLD):
        _existing(db, f"taken{i}@test.example")
        client.post("/api/auth/signup", json={**GOOD, "email": f"taken{i}@test.example"})

    blocked = client.post("/api/auth/signup", json={**GOOD, "email": "grace@test.example"})
    retry_after = int(blocked.headers["Retry-After"])
    assert retry_after > MAX_LOCK_SECONDS  # not any rung of the ladder
    assert PROBE_LOCK_SECONDS - 5 <= retry_after <= PROBE_LOCK_SECONDS


def test_a_signup_pause_does_not_lock_a_real_customer_out_of_signing_in(client, db, seeded_db):
    # The whole reason signup:* is a third namespace. Arm the pause, then sign
    # in — from the same host, in the same process.
    for i in range(PROBE_DISTINCT_THRESHOLD):
        _existing(db, f"taken{i}@test.example")
        client.post("/api/auth/signup", json={**GOOD, "email": f"taken{i}@test.example"})
    assert client.post("/api/auth/signup", json=GOOD).status_code == 429

    login = client.post(
        "/api/auth/login",
        json={"email": "admin@test.example", "password": "testpass123"},
    )
    assert login.status_code == 200


# ── The duplicate check is a fast path, not the arbiter ─────────────────────


def test_a_racing_signup_for_the_same_address_answers_409_not_500(client, db, monkeypatch):
    """Two signups for one address can both pass the SELECT and race to INSERT;
    the loser meets uq_users_email_lower. 409 is what this endpoint promises
    that person (D5) — a 500 tells them their address is broken rather than
    taken, and every test above passes without the promise holding here.

    The interleaving is reproduced at the one seam that sits BETWEEN the read
    and the write: hashing the password. The row it inserts is the winner.
    """
    from app.routes import auth as auth_route

    def _racing_hash(password: str) -> str:
        if not getattr(_racing_hash, "fired", False):
            _racing_hash.fired = True
            db.add(
                User(
                    id=uuid_mod.uuid4(),
                    username="James@test.example",
                    email="James@test.example",
                    password_hash="x",
                    role="user",
                )
            )
            db.flush()
        return "x"

    monkeypatch.setattr(auth_route, "hash_password", _racing_hash)

    r = client.post("/api/auth/signup", json=GOOD)
    assert r.status_code == 409
    assert r.json()["detail"] == "email_taken"

    # And the connection has to be USABLE afterwards: an IntegrityError that is
    # never rolled back poisons every later request on this session with
    # PendingRollbackError, so one collision would take the front door down.
    later = client.post("/api/auth/signup", json={**GOOD, "email": "grace@test.example"})
    assert later.status_code == 202
