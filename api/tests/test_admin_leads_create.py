"""Add lead — POST /api/admin/leads/ (owner ask 2026-09-23).

Contract: .superpowers/sdd/2026-09-23-add-lead/contract.md. Salespeople add a
lead from the console; the server derives everything the roster import
derives, through the ONE identity home (services/lead_identity.py), so the
console and leads.csv can never fork the same person into two rows.
"""

import csv
import uuid
from pathlib import Path

import pytest

from app.db.seed_leads import seed_leads
from app.models import Lead, Manufacturer, User
from app.routes import admin_leads
from app.services.lead_distance import distance_from_hq_miles
from app.services.lead_identity import lead_company_parts, lead_source_key
from tests.test_leads_seed import HEADERS

URL = "/api/admin/leads/"
MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "058_lead_created_by.py"


def _post(client, headers, **body):
    return client.post(URL, json=body, headers=headers)


def _write_csv(tmp_path, rows):
    p = tmp_path / "leads.csv"
    with open(p, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=HEADERS)
        w.writeheader()
        for r in rows:
            w.writerow({h: r.get(h, "") for h in HEADERS})
    return p


# ── the identity home ───────────────────────────────────────────────────────


class TestIdentity:
    def test_source_key_is_the_seeds_old_rule(self):
        # The pre-extraction seed computed exactly this inline; a change here
        # re-keys every roster row and the next boot re-inserts all of them.
        # (Yes, "|": canon splits `__company__` on its underscores and folds
        # "company" off as a legal suffix. That IS the stored key.)
        assert lead_source_key("FDH Electronics", "Ian Locke") == "fdh electronics|ian locke"
        assert lead_source_key("Acme Inc.", None) == "acme inc|"
        assert lead_source_key("Acme Inc.", "") == "acme inc|"
        from app.services.manufacturer_canon import canon

        for company, contact in [("Bisco Industries (Bohemia)", "Pat Doe"), ("Lumissil", None)]:
            assert (
                lead_source_key(company, contact)
                == canon(f"{company}|{contact or '__company__'}")[:300]
            )

    def test_source_key_folds_case_and_spacing(self):
        assert lead_source_key("  fdh   ELECTRONICS ", "ian  LOCKE") == lead_source_key(
            "FDH Electronics", "Ian Locke"
        )

    def test_source_key_is_clipped_to_the_column(self):
        assert len(lead_source_key("x" * 400, "y")) == 300

    def test_company_parts_split_the_branch(self):
        assert lead_company_parts("Bisco Industries (Bohemia)") == ("bisco industries", "Bohemia")
        assert lead_company_parts("Lumissil") == ("lumissil", None)

    def test_the_seed_has_no_second_copy_of_the_rules(self):
        src = (Path(__file__).resolve().parents[1] / "app" / "db" / "seed_leads.py").read_text()
        assert "lead_source_key(" in src and "lead_company_parts(" in src
        assert "__company__" not in src
        assert "split_branch" not in src


# ── create ──────────────────────────────────────────────────────────────────


class TestCreate:
    def test_happy_path_derives_every_server_field(self, client, db, seeded_db, auth_header):
        db.add(
            Manufacturer(
                id=uuid.uuid4(),
                name="Bisco Industries",
                slug="bisco-industries",
                canonical_key="bisco industries",
            )
        )
        db.commit()
        resp = _post(
            client,
            auth_header(),
            company_name="  Bisco Industries (Bohemia) ",
            tier="M",
            street="1 Main St",
            city="Bohemia",
            state="ny",
            postal_code="10001",
            main_phone="631-555-0100",
            website="bisco.example",
            sales_email="sales@bisco.example",
            contact_name="Pat Doe",
            contact_title="Buyer",
            direct_phone="631-555-0101",
            contact_email="pat@bisco.example",
            linkedin_url="https://linkedin.example/pat",
            hours_tz="ET",
            notes="met at a trade show",
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["company_name"] == "Bisco Industries (Bohemia)"  # stripped
        assert body["branch_label"] == "Bohemia"
        assert body["company_slug"] == "bisco industries"
        assert body["state"] == "NY"  # uppercased
        assert body["manufacturer_id"] is not None
        assert body["distance_miles"] == pytest.approx(float(distance_from_hq_miles("10001")))
        assert body["needs_enrichment"] is False
        assert body["created_by"] == "admin"
        assert body["created_at"]
        assert body["ring"] is None  # the owner's research label — never on the form
        assert body["contacts"] == []
        assert body["contact_attempts"] == 0

        row = db.query(Lead).filter(Lead.id == uuid.UUID(body["id"])).one()
        assert row.source_key == lead_source_key("Bisco Industries (Bohemia)", "Pat Doe")
        assert row.user_id is None
        assert row.created_by == "admin"

    def test_company_only_needs_enrichment(self, client, db, seeded_db, auth_header):
        resp = _post(client, auth_header(), company_name="Acme Interconnect", contact_name="  ")
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["contact_name"] is None
        assert body["needs_enrichment"] is True
        assert body["distance_miles"] is None  # no ZIP, no claim
        assert body["manufacturer_id"] is None
        row = db.query(Lead).filter(Lead.id == uuid.UUID(body["id"])).one()
        assert row.source_key == lead_source_key("Acme Interconnect", None)

    def test_new_lead_is_readable_by_id_and_in_the_list(self, client, db, seeded_db, auth_header):
        h = auth_header()
        created = _post(client, h, company_name="Listed Co", contact_name="Lee Ray").json()
        detail = client.get(f"{URL}{created['id']}", headers=h).json()
        assert detail["created_by"] == "admin"
        assert detail["created_at"] == created["created_at"]
        rows = client.get(URL, headers=h).json()["leads"]
        mine = [r for r in rows if r["id"] == created["id"]]
        assert mine and mine[0]["created_by"] == "admin" and mine[0]["created_at"]


class TestDuplicates:
    def test_second_add_is_a_named_409(self, client, db, seeded_db, auth_header):
        h = auth_header()
        first = _post(client, h, company_name="FDH Electronics", contact_name="Ian Locke").json()
        again = _post(client, h, company_name="fdh  electronics ", contact_name="IAN locke")
        assert again.status_code == 409
        assert again.json()["detail"] == {
            "code": "lead_exists",
            "lead_id": first["id"],
            "company_name": "FDH Electronics",
            "contact_name": "Ian Locke",
        }
        assert db.query(Lead).count() == 1

    def test_same_company_new_person_is_a_new_row(self, client, db, seeded_db, auth_header):
        h = auth_header()
        assert _post(client, h, company_name="FDH", contact_name="Ian Locke").status_code == 201
        assert _post(client, h, company_name="FDH", contact_name="Nat Little").status_code == 201
        assert _post(client, h, company_name="FDH").status_code == 201  # company-only row

    def test_an_enriched_placeholder_still_refuses_the_same_person(
        self, client, db, seeded_db, auth_header
    ):
        """PATCH fills in a placeholder's contact but never re-keys it (the
        seed keys on source_key, so a re-key would make the next boot
        re-insert the placeholder). The add must still find that person."""
        h = auth_header()
        first = _post(client, h, company_name="ZZReview Zip4").json()
        assert first["contact_name"] is None
        patched = client.patch(f"{URL}{first['id']}", json={"contact_name": "Bob Smith"}, headers=h)
        assert patched.status_code == 200, patched.text

        again = _post(client, h, company_name="zzreview  zip4", contact_name="bob smith")
        assert again.status_code == 409, again.text
        assert again.json()["detail"]["code"] == "lead_exists"
        assert again.json()["detail"]["lead_id"] == first["id"]
        assert db.query(Lead).count() == 1

        # a different person at the same company is still a new row
        assert (
            _post(client, h, company_name="ZZReview Zip4", contact_name="Ann Other").status_code
            == 201
        )
        assert db.query(Lead).count() == 2

    def test_a_renamed_contact_is_found_under_the_new_name(
        self, client, db, seeded_db, auth_header
    ):
        h = auth_header()
        first = _post(client, h, company_name="FDH", contact_name="Ian Locke").json()
        client.patch(f"{URL}{first['id']}", json={"contact_name": "Nat Little"}, headers=h)
        again = _post(client, h, company_name="FDH", contact_name="Nat Little")
        assert again.status_code == 409
        assert again.json()["detail"]["lead_id"] == first["id"]
        assert db.query(Lead).count() == 1

    def test_the_same_person_at_another_branch_is_a_new_row(
        self, client, db, seeded_db, auth_header
    ):
        # company_slug groups branches; the duplicate is the KEY, branch included
        h = auth_header()
        first = _post(client, h, company_name="Powell (East)").json()
        client.patch(f"{URL}{first['id']}", json={"contact_name": "Bob Smith"}, headers=h)
        resp = _post(client, h, company_name="Powell (West)", contact_name="Bob Smith")
        assert resp.status_code == 201, resp.text

    def test_invisible_characters_do_not_fork_the_key(self, client, db, seeded_db, auth_header):
        h = auth_header()
        first = _post(client, h, company_name="Acme").json()
        for pasted in ("Acme\u200b", "\ufeffAcme", "Ac\u200dme"):
            resp = _post(client, h, company_name=pasted)
            assert resp.status_code == 409, (pasted, resp.text)
            assert resp.json()["detail"]["lead_id"] == first["id"]
        stored = _post(client, h, company_name="Zero\u200bWidth Co").json()
        assert stored["company_name"] == "ZeroWidth Co"
        assert db.query(Lead).count() == 2

    def test_seed_then_api_is_one_row(self, client, db, seeded_db, auth_header, tmp_path):
        seed_leads(
            db, csv_path=_write_csv(tmp_path, [{"Company": "Lumissil", "Contact Name": "Kim Ray"}])
        )
        db.commit()
        resp = _post(client, auth_header(), company_name="LUMISSIL", contact_name="kim ray")
        assert resp.status_code == 409
        detail = resp.json()["detail"]
        assert detail["code"] == "lead_exists"
        assert detail["company_name"] == "Lumissil"
        assert db.query(Lead).count() == 1

    def test_seed_placeholder_row_collides_with_a_company_only_add(
        self, client, db, seeded_db, auth_header, tmp_path
    ):
        seed_leads(
            db,
            csv_path=_write_csv(
                tmp_path, [{"Company": "Acme Interconnect", "Contact Name": "ENRICHMENT NEEDED"}]
            ),
        )
        db.commit()
        resp = _post(client, auth_header(), company_name="Acme Interconnect")
        assert resp.status_code == 409
        assert resp.json()["detail"]["contact_name"] is None

    def test_api_then_seed_is_one_row(self, client, db, seeded_db, auth_header, tmp_path):
        created = _post(client, auth_header(), company_name="Lumissil", contact_name="Kim Ray")
        assert created.status_code == 201
        counts = seed_leads(
            db,
            csv_path=_write_csv(
                tmp_path, [{"Company": "Lumissil", "Contact Name": "Kim Ray", "Ring": "3"}]
            ),
        )
        db.commit()
        assert counts["leads_created"] == 0
        rows = db.query(Lead).all()
        assert len(rows) == 1
        assert rows[0].created_by == "admin"  # the console row survives, stamp intact

    def test_race_integrity_error_answers_409(
        self, client, db, seeded_db, auth_header, monkeypatch
    ):
        """The probe misses (another writer has not committed yet), the
        insert then hits uq_leads_source_key: the answer is the same 409."""
        h = auth_header()
        winner = _post(client, h, company_name="Race Co", contact_name="Sam Hill").json()

        real = admin_leads._find_by_source_key
        calls = {"n": 0}

        def blind_first_probe(db_, key):
            calls["n"] += 1
            return None if calls["n"] == 1 else real(db_, key)

        monkeypatch.setattr(admin_leads, "_find_by_source_key", blind_first_probe)
        # the in-memory re-key probe is blind too (the other writer's row is
        # not committed yet from this request's point of view)
        monkeypatch.setattr(admin_leads, "_find_enriched", lambda *_a: None)
        resp = _post(client, h, company_name="Race Co", contact_name="Sam Hill")
        assert calls["n"] == 2, "the IntegrityError path must re-probe"
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "lead_exists"
        assert resp.json()["detail"]["lead_id"] == winner["id"]
        assert db.query(Lead).count() == 1

    def test_a_customers_private_lead_is_never_named(self, client, db, seeded_db, auth_header):
        """uq_leads_source_key is unique over ALL rows (045 added user_id
        without scoping it), so a customer's own prospect CAN collide with a
        staff add. The 409 must not hand staff that row's id or company."""
        customer = User(
            username="cust_lead@test.example",
            email="cust_lead@test.example",
            password_hash="x",
            role="user",
        )
        db.add(customer)
        db.flush()
        db.add(
            Lead(
                id=uuid.uuid4(),
                source_key=lead_source_key("Globex", "Hank Scorpio"),
                company_name="Globex",
                company_slug="globex",
                contact_name="Hank Scorpio",
                user_id=customer.id,
            )
        )
        db.commit()
        resp = _post(client, auth_header(), company_name="Globex", contact_name="Hank Scorpio")
        assert resp.status_code == 409
        assert resp.json()["detail"] == {"code": "lead_exists_private"}

    def test_race_against_a_customer_row_is_private_too(
        self, client, db, seeded_db, auth_header, monkeypatch
    ):
        customer = User(
            username="cust_race@test.example",
            email="cust_race@test.example",
            password_hash="x",
            role="user",
        )
        db.add(customer)
        db.flush()
        db.add(
            Lead(
                id=uuid.uuid4(),
                source_key=lead_source_key("Initech", None),
                company_name="Initech",
                company_slug="initech",
                user_id=customer.id,
            )
        )
        db.commit()
        real = admin_leads._find_by_source_key
        calls = {"n": 0}

        def blind_first_probe(db_, key):
            calls["n"] += 1
            return None if calls["n"] == 1 else real(db_, key)

        monkeypatch.setattr(admin_leads, "_find_by_source_key", blind_first_probe)
        resp = _post(client, auth_header(), company_name="Initech")
        assert resp.status_code == 409
        assert resp.json()["detail"] == {"code": "lead_exists_private"}


class TestGate:
    def test_anonymous_is_refused(self, client, db, seeded_db):
        assert _post(client, {}, company_name="Nope").status_code in (401, 403)

    def test_viewer_is_read_only(self, client, db, viewer_header):
        resp = _post(client, viewer_header(), company_name="Nope")
        assert resp.status_code == 403
        assert resp.json()["detail"] == "read_only"
        assert db.query(Lead).count() == 0

    def test_customer_is_staff_only(self, client, db, viewer_header):
        resp = _post(client, viewer_header("user"), company_name="Nope")
        assert resp.status_code == 403
        assert resp.json()["detail"] == "staff_only"
        assert db.query(Lead).count() == 0


class TestValidation:
    @pytest.mark.parametrize(
        "body",
        [
            {"company_name": ""},
            {"company_name": "   "},
            {},
            {"company_name": "x" * 201},
            {"company_name": "Co", "sales_email": "not-an-email"},
            {"company_name": "Co", "contact_email": "a@b"},
            {"company_name": "Co", "contact_email": "a b@c.example"},
            {"company_name": "Co", "state": "New York"},
            {"company_name": "Co", "state": "N1"},
            {"company_name": "Co", "postal_code": "1234"},
            {"company_name": "Co", "postal_code": "12345-12"},
            {"company_name": "Co", "postal_code": "١٢٣٤٥"},  # Arabic digits
            {"company_name": "Co", "tier": "XL"},
            {"company_name": "Co", "notes": "n" * 4001},
            {"company_name": "Co", "ring": "1"},  # not on the form
            {"company_name": "Co", "created_by": "someone-else"},  # server-stamped only
            {"company_name": "Co", "user_id": str(uuid.uuid4())},
        ],
    )
    def test_422(self, client, db, seeded_db, auth_header, body):
        resp = client.post(URL, json=body, headers=auth_header())
        assert resp.status_code == 422, resp.text
        assert db.query(Lead).count() == 0

    @pytest.mark.parametrize("contact", [".", "-", "...", " - Inc", "\u200b"])
    def test_a_contact_that_reads_as_no_one_is_422(
        self, client, db, seeded_db, auth_header, contact
    ):
        """A contact that folds to nothing would take the company-only key
        and be stored as a real person — refuse it on the contact field."""
        resp = _post(client, auth_header(), company_name="ZZReview Widgets", contact_name=contact)
        if contact == "\u200b":
            # only an invisible character: that is no contact at all
            assert resp.status_code == 201, resp.text
            assert resp.json()["contact_name"] is None
            return
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"][0]["loc"][-1] == "contact_name"
        assert db.query(Lead).count() == 0

    @pytest.mark.parametrize("field", ["company_name", "contact_name", "notes", "website"])
    def test_nul_is_a_422_not_a_500(self, client, db, seeded_db, auth_header, field):
        # SQLite stores NUL happily; Postgres refuses it at the SELECT/INSERT
        # and the route 500s — so the 422 is asserted directly.
        body = {"company_name": "Acme", field: "Acme\u0000X"}
        resp = client.post(URL, json=body, headers=auth_header())
        assert resp.status_code == 422, resp.text
        assert db.query(Lead).count() == 0

    def test_blank_optionals_become_null_and_zip_plus4_is_fine(
        self, client, db, seeded_db, auth_header
    ):
        resp = _post(
            client,
            auth_header(),
            company_name="Co",
            sales_email=" ",
            state="",
            postal_code="11779-1234",
            tier=None,
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["sales_email"] is None and body["state"] is None and body["tier"] is None
        assert body["postal_code"] == "11779-1234"
        assert body["distance_miles"] is not None


class TestAddedByMe:
    def test_filter_returns_only_the_callers_adds(
        self, client, db, seeded_db, auth_header, viewer_header, tmp_path
    ):
        seed_leads(
            db,
            csv_path=_write_csv(tmp_path, [{"Company": "Roster Co", "Contact Name": "Ann Roster"}]),
        )
        db.commit()
        me = auth_header()
        colleague = viewer_header("admin")
        _post(client, me, company_name="Mine Co", contact_name="Ann Mine", tier="S")
        _post(client, me, company_name="Mine Too", tier="L")
        _post(client, colleague, company_name="Theirs Co", contact_name="Tom Theirs")

        mine = client.get(f"{URL}?added_by=me", headers=me).json()
        assert mine["total"] == 2
        assert {r["company_name"] for r in mine["leads"]} == {"Mine Co", "Mine Too"}
        assert all(r["created_by"] == "admin" for r in mine["leads"])

        # composes with every other filter
        assert client.get(f"{URL}?added_by=me&tier=S", headers=me).json()["total"] == 1
        assert (
            client.get(f"{URL}?added_by=me&needs_enrichment=true", headers=me).json()["total"] == 1
        )
        assert client.get(f"{URL}?added_by=me&q=too", headers=me).json()["total"] == 1

        theirs = client.get(f"{URL}?added_by=me", headers=colleague).json()
        assert [r["company_name"] for r in theirs["leads"]] == ["Theirs Co"]

        everyone = client.get(URL, headers=me).json()
        assert everyone["total"] == 4
        roster = [r for r in everyone["leads"] if r["company_name"] == "Roster Co"]
        assert roster[0]["created_by"] is None  # "From the roster import"

    def test_any_other_value_is_422(self, client, db, seeded_db, auth_header):
        assert client.get(f"{URL}?added_by=admin", headers=auth_header()).status_code == 422
        assert client.get(f"{URL}?added_by=", headers=auth_header()).status_code == 422


# ── migration 058 ───────────────────────────────────────────────────────────


class TestMigration058:
    def test_follows_057(self):
        src = MIGRATION.read_text()
        assert 'revision = "058"' in src
        assert 'down_revision = "057"' in src

    def test_adds_a_nullable_120_char_column_with_no_fk_and_no_backfill(self):
        src = MIGRATION.read_text()
        assert 'sa.Column("created_by", sa.String(120), nullable=True)' in src
        assert "ForeignKey" not in src
        assert "UPDATE" not in src.upper().replace("UPGRADE", "")
        assert 'op.drop_column("leads", "created_by")' in src

    def test_never_imports_app_code(self):
        assert "from app" not in MIGRATION.read_text()
        assert "import app" not in MIGRATION.read_text()

    def test_model_agrees(self):
        col = Lead.__table__.c.created_by
        assert col.nullable
        assert col.type.length == 120
        assert not col.foreign_keys
