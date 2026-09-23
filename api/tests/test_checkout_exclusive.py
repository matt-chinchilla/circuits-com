"""Gold & Platinum self-serve checkout (spec §7) — slots, quote, the hold, release.

The money rules under test: the server computes every price (the browser only
sends a tier, a slot and maybe a code); an exclusive slot is sold to one buyer
at a time (R2 hold, R16 "taken" — Paused still pays); a buyer who backs out of
Stripe can buy again at once; nobody can squat a slot by opening holds; and a
Stripe failure never leaves a hold behind.
"""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from app.config import settings
from app.models import Category, Sponsor
from app.models.sales import BillingAudit, CheckoutIntent, SalesCode, SponsorBilling
from app.services import checkout_intents, stripe_quotes
from app.services.sales_codes import NOT_VALID_MESSAGE
from tests.fake_stripe import FakeStripe

SLOTS = "/api/checkout/exclusive/slots"
QUOTE = "/api/checkout/quote"
BUY = "/api/checkout/exclusive"
RELEASE = "/api/checkout/exclusive/release"


# ── fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def stripe_key(monkeypatch):
    monkeypatch.setattr(settings, "STRIPE_SECRET_KEY", "sk_test_exclusive")
    monkeypatch.setattr(settings, "APP_BASE_URL", "https://circuitcenter.ai")
    monkeypatch.setattr(settings, "SELF_SERVE_ONBOARDING_REP", "Daniel")


@pytest.fixture
def fake(monkeypatch):
    fs = FakeStripe()
    monkeypatch.setattr(stripe_quotes, "make_client", fs.make_client)
    return fs


@pytest.fixture(autouse=True)
def fresh_rate_buckets():
    from app.routes import checkout as checkout_route

    checkout_route._rate_buckets.clear()
    checkout_route._quote_buckets.clear()
    yield
    checkout_route._rate_buckets.clear()
    checkout_route._quote_buckets.clear()


@pytest.fixture
def board(db, seeded_db):
    """Two top-level categories and their children.

    * parent "Integrated Circuits": no Platinum → open. Children: "Clock and
      Timing" (seeded Gold, status NULL → taken), "Amplifiers" and "Data
      Converters" (open).
    * parent "Passives": an Active Platinum → taken. Child "Resistors" (open).
    """
    parent, child = seeded_db["parent"], seeded_db["child"]
    amps = Category(id=uuid.uuid4(), name="Amplifiers", slug="amplifiers", parent_id=parent.id)
    adc = Category(
        id=uuid.uuid4(), name="Data Converters", slug="data-converters", parent_id=parent.id
    )
    passives = Category(id=uuid.uuid4(), name="Passives", slug="passives")
    db.add_all([amps, adc, passives])
    db.flush()
    resistors = Category(id=uuid.uuid4(), name="Resistors", slug="resistors", parent_id=passives.id)
    db.add(resistors)
    db.add(
        Sponsor(
            supplier_id=seeded_db["supplier2"].id,
            category_id=passives.id,
            tier="Platinum",
            status="Active",
        )
    )
    db.commit()
    return {
        "ics": parent,
        "clock": child,
        "amps": amps,
        "adc": adc,
        "passives": passives,
        "resistors": resistors,
        "avnet": seeded_db["supplier1"],
        "kennedy": seeded_db["supplier2"],
    }


def _code(db, **kw) -> SalesCode:
    row = SalesCode(
        code=kw.pop("code", "AB12CD34"),
        code_points=kw.pop("code_points", 10),
        rep=kw.pop("rep", "Anthony"),
        created_by="Anthony",
        **kw,
    )
    db.add(row)
    db.commit()
    return row


def _buy(client, cat, *, tier="gold", email="ap@acme.example", ip="203.0.113.10", **extra):
    body = {
        "tier": tier,
        "category_id": str(cat.id),
        "company_name": "Acme Components",
        "email": email,
        **extra,
    }
    return client.post(BUY, json=body, headers={"X-Real-IP": ip})


def _intents(db, **filters):
    db.expire_all()
    return db.query(CheckoutIntent).filter_by(**filters).all()


def _lapse(db, intent_id):
    """Push a hold's expiry into the past, as time would."""
    db.expire_all()
    row = db.get(CheckoutIntent, intent_id)
    row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    db.commit()


# ── GET /exclusive/slots ────────────────────────────────────────────────────


class TestSlots:
    def test_404_without_a_key(self, client, board):
        assert client.get(SLOTS, params={"tier": "gold"}).status_code == 404

    def test_unknown_tier_is_422(self, client, stripe_key, board):
        for bad in ("silver", "diamond", ""):
            resp = client.get(SLOTS, params={"tier": bad})
            assert resp.status_code == 422, bad
            assert isinstance(resp.json()["detail"], str)

    def test_gold_lists_children_without_an_occupant(self, client, stripe_key, board):
        body = client.get(SLOTS, params={"tier": "gold"}).json()
        assert body["tier"] == "gold"
        assert body["list_usd"] == 2500
        assert body["founder_usd"] == 2100
        by_name = {s["name"]: s for s in body["slots"]}
        assert set(by_name) == {"Amplifiers", "Data Converters", "Resistors"}
        amps = by_name["Amplifiers"]
        assert amps == {
            "category_id": str(board["amps"].id),
            "name": "Amplifiers",
            "parent_name": "Integrated Circuits",
            "path": "/category/integrated-circuits/amplifiers",
            "state": "open",
            "held_until": None,
        }

    def test_platinum_lists_top_level_without_an_occupant(self, client, stripe_key, board):
        body = client.get(SLOTS, params={"tier": "Platinum"}).json()
        assert body["tier"] == "platinum"
        assert body["list_usd"] == 10000
        assert body["founder_usd"] == 8500
        assert [s["name"] for s in body["slots"]] == ["Integrated Circuits"]
        row = body["slots"][0]
        assert row["parent_name"] is None
        assert row["path"] == "/category/integrated-circuits"

    def test_paused_sponsor_slot_is_taken(self, client, stripe_key, db, board):
        """R16: a Paused Gold still pays, so its slot is never offered."""
        db.add(
            Sponsor(
                supplier_id=board["avnet"].id,
                category_id=board["amps"].id,
                tier="gold",
                status="Paused",
            )
        )
        db.commit()
        names = {s["name"] for s in client.get(SLOTS, params={"tier": "gold"}).json()["slots"]}
        assert "Amplifiers" not in names

    def test_expired_sponsor_frees_the_slot(self, client, stripe_key, db, board):
        db.query(Sponsor).filter(Sponsor.category_id == board["clock"].id).update(
            {"status": "Expired"}
        )
        db.commit()
        names = {s["name"] for s in client.get(SLOTS, params={"tier": "gold"}).json()["slots"]}
        assert "Clock and Timing" in names

    def test_a_silver_row_does_not_take_a_gold_slot(self, client, stripe_key, db, board):
        db.add(
            Sponsor(
                supplier_id=board["avnet"].id,
                category_id=board["amps"].id,
                tier="Silver",
                status="Active",
            )
        )
        db.commit()
        names = {s["name"] for s in client.get(SLOTS, params={"tier": "gold"}).json()["slots"]}
        assert "Amplifiers" in names

    def test_live_intent_reads_held_and_a_lapsed_one_open(
        self, client, stripe_key, fake, db, board
    ):
        resp = _buy(client, board["amps"])
        assert resp.status_code == 200, resp.text
        slots = {s["name"]: s for s in client.get(SLOTS, params={"tier": "gold"}).json()["slots"]}
        assert slots["Amplifiers"]["state"] == "held"
        assert slots["Amplifiers"]["held_until"] == resp.json()["held_until"]

        (intent,) = _intents(db, status="open")
        _lapse(db, intent.id)
        slots = {s["name"]: s for s in client.get(SLOTS, params={"tier": "gold"}).json()["slots"]}
        assert slots["Amplifiers"]["state"] == "open"
        assert slots["Amplifiers"]["held_until"] is None


# ── POST /quote ─────────────────────────────────────────────────────────────


class TestQuote:
    def test_404_without_a_key(self, client, board):
        assert client.post(QUOTE, json={"tier": "gold"}).status_code == 404

    def test_no_code_is_the_founders_deal(self, client, stripe_key, board):
        body = client.post(QUOTE, json={"tier": "gold"}).json()
        assert body == {
            "tier": "gold",
            "list_usd": 2500,
            "founder_usd": 2100,
            "price_usd": 2100,
            "savings_usd": 400,
            "code": None,
            "slot_state": None,
        }

    def test_platinum_no_code(self, client, stripe_key, board):
        body = client.post(QUOTE, json={"tier": "platinum"}).json()
        assert (body["price_usd"], body["savings_usd"]) == (8500, 1500)

    def test_valid_ten_point_code(self, client, stripe_key, db, board):
        _code(db, code_points=10)
        body = client.post(QUOTE, json={"tier": "gold", "code": "ab12-cd34"}).json()
        assert body["price_usd"] == 1850
        assert body["savings_usd"] == 650
        assert body["code"] == {"accepted": True, "points": 10, "message": None}

    def test_tier_locked_code_on_the_other_tier(self, client, stripe_key, db, board):
        _code(db, tier="platinum")
        body = client.post(QUOTE, json={"tier": "gold", "code": "AB12CD34"}).json()
        assert body["price_usd"] == 2100
        assert body["code"] == {"accepted": False, "points": None, "message": NOT_VALID_MESSAGE}

    def test_email_lock_is_checked_only_when_email_is_sent(self, client, stripe_key, db, board):
        _code(db, email_lock="buyer@acme.example")
        no_email = client.post(QUOTE, json={"tier": "gold", "code": "AB12CD34"}).json()
        assert no_email["code"]["accepted"] is True
        right = client.post(
            QUOTE, json={"tier": "gold", "code": "AB12CD34", "email": " Buyer@Acme.example "}
        ).json()
        assert right["code"]["accepted"] is True
        wrong = client.post(
            QUOTE, json={"tier": "gold", "code": "AB12CD34", "email": "other@acme.example"}
        ).json()
        assert wrong["code"]["accepted"] is False
        assert wrong["code"]["message"] == NOT_VALID_MESSAGE
        assert wrong["price_usd"] == 2100

    def test_blank_code_is_no_code(self, client, stripe_key, board):
        body = client.post(QUOTE, json={"tier": "gold", "code": "   "}).json()
        assert body["code"] is None

    def test_slot_state_values(self, client, stripe_key, fake, db, board):
        def state(cat, tier="gold"):
            resp = client.post(QUOTE, json={"tier": tier, "category_id": str(cat.id)})
            assert resp.status_code == 200, resp.text
            return resp.json()["slot_state"]

        assert state(board["amps"]) == "open"
        assert state(board["clock"]) == "taken"
        assert state(board["passives"], "platinum") == "taken"
        assert _buy(client, board["amps"]).status_code == 200
        assert state(board["amps"]) == "held"

    def test_wrong_shape_or_unknown_slot_is_422(self, client, stripe_key, board):
        for tier, cat_id in (
            ("gold", str(board["ics"].id)),  # Gold lives on children
            ("platinum", str(board["amps"].id)),  # Platinum on top-level
            ("gold", str(uuid.uuid4())),
            ("gold", "not-a-uuid"),
        ):
            resp = client.post(QUOTE, json={"tier": tier, "category_id": cat_id})
            assert resp.status_code == 422, (tier, cat_id)
            assert isinstance(resp.json()["detail"], str)

    def test_unknown_tier_is_422(self, client, stripe_key, board):
        resp = client.post(QUOTE, json={"tier": "diamond"})
        assert resp.status_code == 422
        assert isinstance(resp.json()["detail"], str)

    def test_quote_has_no_side_effects(self, client, stripe_key, db, board):
        _code(db)
        client.post(
            QUOTE, json={"tier": "gold", "category_id": str(board["amps"].id), "code": "AB12CD34"}
        )
        db.expire_all()
        assert db.query(CheckoutIntent).count() == 0
        assert db.query(SalesCode).one().uses == 0

    def test_quote_is_rate_limited(self, client, stripe_key, board):
        codes = [
            client.post(
                QUOTE, json={"tier": "gold"}, headers={"X-Real-IP": "198.51.100.7"}
            ).status_code
            for _ in range(31)
        ]
        assert codes[:30] == [200] * 30
        assert codes[30] == 429


# ── POST /exclusive ─────────────────────────────────────────────────────────


class TestBuy:
    def test_404_without_a_key(self, client, board):
        assert _buy(client, board["amps"]).status_code == 404

    def test_happy_path_holds_the_slot_and_mints_the_session(
        self, client, stripe_key, fake, db, board
    ):
        before = datetime.now(UTC)
        resp = _buy(client, board["amps"], website="acme.example")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["url"].startswith("https://checkout.stripe.com/")
        assert len(body["release_token"]) >= 32

        (intent,) = _intents(db)
        assert intent.status == "open"
        assert intent.tier == "gold"
        assert intent.category_id == board["amps"].id
        assert (intent.list_usd, intent.founder_usd, intent.price_usd) == (2500, 2100, 2100)
        assert intent.channel == "self_serve"
        assert intent.sold_by == "Daniel"
        assert intent.company_name == "Acme Components"
        assert intent.email == "ap@acme.example"
        assert intent.website == "acme.example"
        assert intent.release_token_hash == checkout_intents.hash_token(body["release_token"])
        assert intent.client_ip_hash == checkout_intents.client_ip_hash("203.0.113.10")
        assert intent.stripe_session_id and intent.stripe_session_id.startswith("cs_test_")
        held = (
            intent.expires_at if intent.expires_at.tzinfo else intent.expires_at.replace(tzinfo=UTC)
        )
        assert timedelta(minutes=44) < held - before < timedelta(minutes=46)
        assert body["held_until"] == held.isoformat()

        req = fake.last("POST", "/v1/checkout/sessions")
        form = req.form
        assert req.headers["Idempotency-Key"] == f"checkout:{intent.id}"
        assert form["mode"] == "subscription"
        assert form["line_items[0][price]"] == "price_gold_advertising_monthly"
        assert form["line_items[1][price]"] == "price_gold_platform_monthly"
        assert form["payment_method_types[0]"] == "card"
        assert "payment_method_types[1]" not in form
        assert form["automatic_tax[enabled]"] == "true"
        assert form["billing_address_collection"] == "required"
        assert form["discounts[0][coupon]"] == "GOLD-AT-2100"
        assert "allow_promotion_codes" not in form
        assert form["customer_email"] == "ap@acme.example"
        assert "customer" not in form
        stripe_expiry = datetime.fromtimestamp(int(form["expires_at"]), UTC)
        assert timedelta(minutes=34) < stripe_expiry - before < timedelta(minutes=36)
        for prefix in ("metadata", "subscription_data[metadata]"):
            assert form[f"{prefix}[intent_id]"] == str(intent.id)
            assert form[f"{prefix}[tier]"] == "gold"
            assert form[f"{prefix}[managed_by]"] == "circuits-com"
        assert form["success_url"] == "https://circuitcenter.ai/join?welcome=gold"
        assert form["cancel_url"] == "https://circuitcenter.ai/join?released=1"

        coupon = fake.coupons["GOLD-AT-2100"]
        assert coupon["amount_off"] == 40000
        assert coupon["duration"] == "forever"
        assert coupon["name"] == "Gold Founder's Deal — $2,100/mo"
        assert set(coupon["_products"]) == set(fake.product_ids("gold"))

        audits = db.query(BillingAudit).filter_by(action="checkout_started").all()
        assert len(audits) == 1 and audits[0].intent_id == intent.id

    def test_platinum_takes_a_top_level_slot(self, client, stripe_key, fake, db, board):
        resp = _buy(client, board["ics"], tier="platinum")
        assert resp.status_code == 200, resp.text
        form = fake.last("POST", "/v1/checkout/sessions").form
        assert form["discounts[0][coupon]"] == "PLATINUM-AT-8500"
        assert form["success_url"] == "https://circuitcenter.ai/join?welcome=platinum"
        (intent,) = _intents(db)
        assert intent.price_usd == 8500

    def test_wrong_shape_is_422(self, client, stripe_key, fake, board):
        for tier, cat in (("gold", board["ics"]), ("platinum", board["amps"])):
            resp = _buy(client, cat, tier=tier)
            assert resp.status_code == 422, tier
            assert isinstance(resp.json()["detail"], str)
        assert _buy(client, board["amps"], tier="silver").status_code == 422
        assert not fake.calls("POST", "/v1/checkout/sessions")

    def test_body_validation_details_are_strings(self, client, stripe_key, fake, board):
        for extra in (
            {"email": "not-an-email"},
            {"company_name": "A"},
            {"company_name": "x" * 121},
            {"website": "x" * 201},
        ):
            body = {
                "tier": "gold",
                "category_id": str(board["amps"].id),
                "company_name": "Acme",
                "email": "ap@acme.example",
                **extra,
            }
            resp = client.post(BUY, json=body)
            assert resp.status_code == 422, extra
            assert isinstance(resp.json()["detail"], str), extra

    def test_second_buyer_same_slot_is_held(self, client, stripe_key, fake, db, board):
        first = _buy(client, board["amps"])
        assert first.status_code == 200
        second = _buy(client, board["amps"], email="other@beta.example", ip="198.51.100.20")
        assert second.status_code == 409
        assert second.json()["detail"] == "slot_held"
        assert second.headers["X-Held-Until"] == first.json()["held_until"]
        assert len(_intents(db)) == 1

    def test_the_unique_index_backs_the_hold(self, db, board, monkeypatch):
        """Even past the pre-check, the partial unique index refuses a second
        live hold — `open_exclusive_intent` turns that into SlotHeld."""
        now = datetime.now(UTC)
        db.add(
            CheckoutIntent(
                tier="platinum",
                category_id=board["amps"].id,
                list_usd=1,
                founder_usd=1,
                price_usd=1,
                channel="self_serve",
                company_name="x",
                email="x@y.example",
                expires_at=now + timedelta(minutes=45),
            )
        )
        db.commit()
        # Blind the pre-check, as a concurrent insert would.
        monkeypatch.setattr(checkout_intents, "_live_hold", lambda *a, **k: None)
        with pytest.raises(checkout_intents.SlotHeld) as info:
            checkout_intents.open_exclusive_intent(
                db,
                tier="gold",
                category_id=str(board["amps"].id),
                code=None,
                company_name="Acme",
                email="ap@acme.example",
                website=None,
                ip="203.0.113.1",
                now=now,
            )
        assert info.value.held_until is not None

    def test_occupied_slot_is_taken(self, client, stripe_key, fake, board):
        resp = _buy(client, board["clock"])
        assert resp.status_code == 409
        assert resp.json()["detail"] == "slot_taken"
        resp = _buy(client, board["passives"], tier="platinum")
        assert resp.json()["detail"] == "slot_taken"

    def test_paused_occupant_is_taken(self, client, stripe_key, fake, db, board):
        db.add(
            Sponsor(
                supplier_id=board["avnet"].id,
                category_id=board["amps"].id,
                tier="Gold",
                status="Paused",
            )
        )
        db.commit()
        assert _buy(client, board["amps"]).json()["detail"] == "slot_taken"

    def test_stripe_failure_expires_the_hold_and_a_retry_succeeds(
        self, client, stripe_key, fake, db, board
    ):
        fake.session_create_status = 502
        resp = _buy(client, board["amps"])
        assert resp.status_code == 502
        assert isinstance(resp.json()["detail"], str)
        (intent,) = _intents(db)
        assert intent.status == "expired"

        fake.session_create_status = None
        retry = _buy(client, board["amps"])
        assert retry.status_code == 200, retry.text
        assert len(_intents(db, status="open")) == 1

    def test_stripe_4xx_is_422_and_expires_the_hold(self, client, stripe_key, fake, db, board):
        fake.session_create_status = 400
        resp = _buy(client, board["amps"])
        assert resp.status_code == 422
        (intent,) = _intents(db)
        assert intent.status == "expired"

    def test_a_lapsed_hold_frees_the_slot_for_someone_else(
        self, client, stripe_key, fake, db, board
    ):
        assert _buy(client, board["amps"]).status_code == 200
        (intent,) = _intents(db)
        _lapse(db, intent.id)
        other = _buy(client, board["amps"], email="other@beta.example", ip="198.51.100.20")
        assert other.status_code == 200, other.text
        assert _intents(db, id=intent.id)[0].status == "expired"

    # ── anti-squatting ──────────────────────────────────────────────────────

    def test_one_open_hold_per_ip(self, client, stripe_key, fake, board):
        assert _buy(client, board["amps"]).status_code == 200
        resp = _buy(client, board["adc"], email="other@beta.example")
        assert resp.status_code == 429
        assert resp.json()["detail"] == "hold_limit"

    def test_one_open_hold_per_email(self, client, stripe_key, fake, board):
        assert _buy(client, board["amps"]).status_code == 200
        resp = _buy(client, board["adc"], email="AP@Acme.example ", ip="198.51.100.30")
        assert resp.status_code == 429
        assert resp.json()["detail"] == "hold_limit"

    def test_two_lapses_on_one_slot_lock_that_pair_out(self, client, stripe_key, fake, db, board):
        for ip in ("198.51.100.1", "198.51.100.2"):
            assert _buy(client, board["amps"], ip=ip).status_code == 200
            (intent,) = _intents(db, status="open")
            _lapse(db, intent.id)
        third = _buy(client, board["amps"], ip="198.51.100.3")
        assert third.status_code == 429
        assert third.json()["detail"] == "hold_limit"
        # Another slot is still fine for that buyer, and the slot for others.
        assert _buy(client, board["adc"], ip="198.51.100.3").status_code == 200

    def test_two_lapses_by_ip_lock_that_pair_out(self, client, stripe_key, fake, db, board):
        for email in ("a@one.example", "b@two.example"):
            assert _buy(client, board["amps"], email=email).status_code == 200
            (intent,) = _intents(db, status="open")
            _lapse(db, intent.id)
        third = _buy(client, board["amps"], email="c@three.example")
        assert third.json()["detail"] == "hold_limit"

    def test_old_lapses_do_not_count(self, client, stripe_key, fake, db, board):
        for ip in ("198.51.100.1", "198.51.100.2"):
            assert _buy(client, board["amps"], ip=ip).status_code == 200
            (intent,) = _intents(db, status="open")
            _lapse(db, intent.id)
        db.query(CheckoutIntent).update({"created_at": datetime.now(UTC) - timedelta(hours=25)})
        db.commit()
        assert _buy(client, board["amps"], ip="198.51.100.3").status_code == 200

    def test_released_holds_do_not_count(self, client, stripe_key, fake, db, board):
        for _ in range(3):
            resp = _buy(client, board["amps"])
            assert resp.status_code == 200, resp.text
            released = client.post(RELEASE, json={"release_token": resp.json()["release_token"]})
            assert released.json() == {"released": True}
        assert _buy(client, board["amps"]).status_code == 200

    def test_a_stripe_failure_is_not_a_lapse(self, client, stripe_key, fake, db, board):
        fake.session_create_status = 502
        for _ in range(3):
            assert _buy(client, board["amps"]).status_code == 502
        fake.session_create_status = None
        assert _buy(client, board["amps"]).status_code == 200

    def test_mint_is_rate_limited(self, client, stripe_key, fake, db, board):
        codes = []
        for i in range(9):
            resp = _buy(client, board["amps"], email=f"b{i}@x.example")
            codes.append(resp.status_code)
            if resp.status_code == 200:
                client.post(RELEASE, json={"release_token": resp.json()["release_token"]})
        assert codes[:8] == [200] * 8
        assert codes[8] == 429
        assert _buy(client, board["amps"], email="z@x.example").json()["detail"] != "hold_limit"

    # ── codes ───────────────────────────────────────────────────────────────

    def test_code_prices_the_hold_and_credits_the_rep(self, client, stripe_key, fake, db, board):
        code = _code(db, code_points=10, rep="Ronald")
        resp = _buy(client, board["amps"], code="ab12 cd34")
        assert resp.status_code == 200, resp.text
        (intent,) = _intents(db)
        assert intent.price_usd == 1850
        assert intent.channel == "rep_code"
        assert intent.sold_by == "Ronald"
        assert intent.sales_code_id == code.id
        form = fake.last("POST", "/v1/checkout/sessions").form
        assert form["discounts[0][coupon]"] == "GOLD-AT-1850"
        assert fake.coupons["GOLD-AT-1850"]["name"] == "Gold Founder's Deal — $1,850/mo"
        # The use is counted by the webhook at activation, not by the hold.
        db.expire_all()
        assert db.get(SalesCode, code.id).uses == 0

    def test_unusable_code_is_the_uniform_422(self, client, stripe_key, fake, db, board):
        _code(db, tier="platinum")
        resp = _buy(client, board["amps"], code="AB12CD34")
        assert resp.status_code == 422
        assert resp.json()["detail"] == NOT_VALID_MESSAGE
        resp = _buy(client, board["amps"], code="ZZZZZZZZ")
        assert resp.json()["detail"] == NOT_VALID_MESSAGE
        assert not _intents(db)
        assert not fake.calls("POST", "/v1/checkout/sessions")

    def test_email_locked_code_needs_the_right_email(self, client, stripe_key, fake, db, board):
        _code(db, email_lock="buyer@acme.example")
        wrong = _buy(client, board["amps"], code="AB12CD34")
        assert wrong.json()["detail"] == NOT_VALID_MESSAGE
        right = _buy(client, board["amps"], code="AB12CD34", email="Buyer@acme.example")
        assert right.status_code == 200, right.text

    def test_single_use_code_cannot_be_held_twice(self, client, stripe_key, fake, db, board):
        """The FOR UPDATE path, sequentially: the first hold counts against
        max_uses while it is open, so a second concurrent intent is refused."""
        _code(db, max_uses=1)
        assert _buy(client, board["amps"], code="AB12CD34").status_code == 200
        second = _buy(
            client, board["adc"], code="AB12CD34", email="other@beta.example", ip="198.51.100.9"
        )
        assert second.status_code == 422
        assert second.json()["detail"] == NOT_VALID_MESSAGE

    def test_a_released_hold_gives_the_code_back(self, client, stripe_key, fake, db, board):
        _code(db, max_uses=1)
        first = _buy(client, board["amps"], code="AB12CD34")
        client.post(RELEASE, json={"release_token": first.json()["release_token"]})
        again = _buy(client, board["amps"], code="AB12CD34")
        assert again.status_code == 200, again.text

    def test_bound_code_refused_while_the_company_sponsors_the_category(
        self, client, stripe_key, fake, db, board
    ):
        """R7: an upgrade on the same category goes through the desk."""
        db.add(
            Sponsor(
                supplier_id=board["avnet"].id,
                category_id=board["amps"].id,
                tier="Silver",
                status="Active",
            )
        )
        db.commit()
        _code(db, supplier_id=board["avnet"].id, email_lock="ap@avnet.example")
        resp = _buy(client, board["amps"], code="AB12CD34", email="ap@avnet.example")
        assert resp.status_code == 409
        assert resp.json()["detail"] == "already_sponsor"
        assert not _intents(db)

    def test_bound_code_with_an_expired_row_is_fine(self, client, stripe_key, fake, db, board):
        db.add(
            Sponsor(
                supplier_id=board["avnet"].id,
                category_id=board["amps"].id,
                tier="Silver",
                status="Expired",
            )
        )
        db.commit()
        _code(db, supplier_id=board["avnet"].id, email_lock="ap@avnet.example")
        resp = _buy(client, board["amps"], code="AB12CD34", email="ap@avnet.example")
        assert resp.status_code == 200, resp.text

    def test_bound_code_checks_out_as_the_companys_customer(
        self, client, stripe_key, fake, db, board
    ):
        sponsor = Sponsor(
            supplier_id=board["avnet"].id,
            category_id=board["resistors"].id,
            tier="Silver",
            status="Active",
            amount=Decimal("210"),
        )
        db.add(sponsor)
        db.flush()
        db.add(
            SponsorBilling(
                sponsor_id=sponsor.id,
                stripe_customer_id="cus_avnet0000001",
                stripe_subscription_id="sub_avnet0000001",
                channel="self_serve",
                list_usd=250,
                price_usd=210,
            )
        )
        db.commit()
        fake.add_customer("cus_avnet0000001", email="ap@avnet.example")
        code = _code(db, supplier_id=board["avnet"].id, email_lock="ap@avnet.example")
        resp = _buy(client, board["amps"], code="AB12CD34", email="ap@avnet.example")
        assert resp.status_code == 200, resp.text
        form = fake.last("POST", "/v1/checkout/sessions").form
        assert form["customer"] == "cus_avnet0000001"
        assert form["customer_update[address]"] == "auto"
        assert form["customer_update[name]"] == "auto"
        assert "customer_email" not in form
        (intent,) = _intents(db)
        assert intent.supplier_id == board["avnet"].id
        assert intent.sales_code_id == code.id

    def test_bound_code_without_a_known_customer_uses_the_email(
        self, client, stripe_key, fake, db, board
    ):
        _code(db, supplier_id=board["kennedy"].id, email_lock="ap@kennedy.example")
        resp = _buy(client, board["amps"], code="AB12CD34", email="ap@kennedy.example")
        assert resp.status_code == 200, resp.text
        form = fake.last("POST", "/v1/checkout/sessions").form
        assert form["customer_email"] == "ap@kennedy.example"
        assert "customer" not in form


# ── POST /exclusive/release ─────────────────────────────────────────────────


class TestRelease:
    def test_404_without_a_key(self, client, board):
        assert client.post(RELEASE, json={"release_token": "x"}).status_code == 404

    def test_release_frees_own_slot_for_immediate_retry(self, client, stripe_key, fake, db, board):
        """Review Focus 1: Back from Stripe, then straight back in."""
        first = _buy(client, board["amps"])
        assert first.status_code == 200
        (intent,) = _intents(db)
        session_id = intent.stripe_session_id

        resp = client.post(RELEASE, json={"release_token": first.json()["release_token"]})
        assert resp.status_code == 200
        assert resp.json() == {"released": True}
        assert fake.sessions[session_id]["status"] == "expired"
        assert fake.last("POST", f"/v1/checkout/sessions/{session_id}/expire")
        assert _intents(db, id=intent.id)[0].status == "released"
        assert db.query(BillingAudit).filter_by(action="hold_released").count() == 1

        again = _buy(client, board["amps"])
        assert again.status_code == 200, again.text
        assert len(_intents(db, status="open")) == 1

    def test_unknown_or_used_token_is_a_quiet_false(self, client, stripe_key, fake, board):
        assert client.post(RELEASE, json={"release_token": "nope"}).json() == {"released": False}
        first = _buy(client, board["amps"])
        token = first.json()["release_token"]
        assert client.post(RELEASE, json={"release_token": token}).json() == {"released": True}
        assert client.post(RELEASE, json={"release_token": token}).json() == {"released": False}

    def test_a_paid_session_is_never_released(self, client, stripe_key, fake, db, board):
        """The buyer paid in another tab: the hold belongs to the webhook now."""
        first = _buy(client, board["amps"])
        (intent,) = _intents(db)
        fake.sessions[intent.stripe_session_id]["status"] = "complete"
        resp = client.post(RELEASE, json={"release_token": first.json()["release_token"]})
        assert resp.json() == {"released": False}
        assert _intents(db, id=intent.id)[0].status == "open"

    def test_stripe_unreachable_keeps_the_hold(self, client, stripe_key, fake, db, board):
        first = _buy(client, board["amps"])
        (intent,) = _intents(db)
        del fake.sessions[intent.stripe_session_id]  # expire → 404 from Stripe
        resp = client.post(RELEASE, json={"release_token": first.json()["release_token"]})
        assert resp.status_code == 502
        assert isinstance(resp.json()["detail"], str)
        assert _intents(db, id=intent.id)[0].status == "open"

    def test_bad_body_is_422_string(self, client, stripe_key, board):
        for body in ({}, {"release_token": "x" * 500}):
            resp = client.post(RELEASE, json=body)
            assert resp.status_code == 422
            assert isinstance(resp.json()["detail"], str)
