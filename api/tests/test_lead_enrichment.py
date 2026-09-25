"""Contact enrichment — GET /api/admin/leads/{id}/enrichment (Hunter.io).

The route READS: it asks Hunter and returns candidates, and the rep applies one
through the existing PATCH/POST. These tests play Hunter with an
httpx.MockTransport (the fake_stripe idea — real httpx, no network), so the
request the service builds is asserted, not assumed.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

import httpx
import pytest

from app.config import settings
from app.models import Lead, LeadContact, Manufacturer, User
from app.services import lead_enrichment as le
from tests.test_admin_leads import leads_db  # noqa: F401 — the seeded roster fixture

KEY = "hunter-test-key-7f3a"
URL = "/api/admin/leads/"

# Hunter's documented Domain Search row (hunter.io/api-documentation/v2),
# trimmed to the fields we read.
CIARAN = {
    "value": "ciaran@acme.com",
    "type": "personal",
    "confidence": 92,
    "first_name": "Ciaran",
    "last_name": "Lee",
    "position": "Support Engineer",
    "linkedin": None,
    "phone_number": None,
    "verification": {"date": "2019-12-06", "status": "valid"},
}


def _domain_payload(emails: list[dict[str, Any]], domain: str = "acme.com") -> dict[str, Any]:
    return {
        "data": {
            "domain": domain,
            "organization": "Acme",
            "pattern": "{first}",
            "webmail": False,
            "emails": emails,
        },
        "meta": {"results": len(emails)},
    }


class FakeHunter:
    """Answers /v2/domain-search and /v2/email-finder from canned replies and
    records every request."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.domain_reply: Any = (200, _domain_payload([CIARAN]))
        self.finder_reply: Any = (200, {"data": {"email": None, "score": None}})

    def _reply(self, spec: Any) -> httpx.Response:
        if isinstance(spec, Exception):
            raise spec
        status, body = spec
        if isinstance(body, str):
            return httpx.Response(status, text=body)
        return httpx.Response(status, json=body)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/v2/domain-search":
            return self._reply(self.domain_reply)
        if request.url.path == "/v2/email-finder":
            return self._reply(self.finder_reply)
        return httpx.Response(404, json={"errors": [{"id": "not_found", "code": 404}]})

    def calls(self, path: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path == f"/v2/{path}"]


@pytest.fixture(autouse=True)
def _fresh_cache():
    le.clear_cache()
    yield
    le.clear_cache()


@pytest.fixture
def hunter(monkeypatch):
    fake = FakeHunter()
    real = le.make_client
    monkeypatch.setattr(
        le, "make_client", lambda key, transport=None: real(key, httpx.MockTransport(fake.handler))
    )
    monkeypatch.setattr(settings, "HUNTER_API_KEY", KEY)
    return fake


def _lead(db, company: str = "FDH Electronics", contact: str | None = "Ian Locke") -> Lead:
    q = db.query(Lead).filter(Lead.company_name == company)
    q = q.filter(Lead.contact_name == contact) if contact else q.filter(Lead.contact_name.is_(None))
    return q.one()


def _placeholder(db) -> Lead:
    return db.query(Lead).filter(Lead.needs_enrichment.is_(True)).one()


def _get(client, headers, lead: Lead):
    return client.get(f"{URL}{lead.id}/enrichment", headers=headers)


# ── Domain derivation (pure) ────────────────────────────────────────────────


class TestDomainDerivation:
    @pytest.mark.parametrize(
        ("raw", "host"),
        [
            ("https://www.Acme.com/about", "acme.com"),
            ("acme.com", "acme.com"),
            ("www.acme.com:8080/x", "acme.com"),
            ("http://shop.acme.co.uk.", "shop.acme.co.uk"),
            ("//acme.com", "acme.com"),
            ("", None),
            ("   ", None),
            (None, None),
            ("localhost", None),
            ("acme .com", None),
            ("http://", None),
            ("javascript:alert(1)", None),
        ],
    )
    def test_normalise_host(self, raw, host):
        assert le.normalise_host(raw) == host

    def test_domain_of_email(self):
        assert le.domain_of_email("Sales@WWW.Acme.com ") == "acme.com"
        assert le.domain_of_email("no-at-sign") is None
        assert le.domain_of_email("a@b@acme.com") is None
        assert le.domain_of_email(None) is None

    def _derive(self, **kw):
        base = dict(website=None, sales_email=None, contact_email=None, manufacturer_website=None)
        base.update(kw)
        return le.derive_domain(**base)

    def test_the_website_wins(self):
        got = self._derive(
            website="www.acme.com", sales_email="sales@other.com", manufacturer_website="mfr.com"
        )
        assert (got.domain, got.source) == ("acme.com", "website")

    def test_then_the_sales_email_then_the_contact_email_then_the_manufacturer(self):
        assert self._derive(sales_email="s@a.com", contact_email="c@b.com").source == "sales_email"
        assert self._derive(contact_email="c@b.com", manufacturer_website="m.com").source == (
            "contact_email"
        )
        got = self._derive(manufacturer_website="https://www.lumissil.com")
        assert (got.domain, got.source) == ("lumissil.com", "manufacturer")

    def test_a_free_mail_source_is_skipped_for_the_next_one(self):
        got = self._derive(sales_email="bob@gmail.com", manufacturer_website="acme.com")
        assert (got.domain, got.source) == ("acme.com", "manufacturer")

    def test_only_free_mail_is_refused_by_name(self):
        with pytest.raises(le.FreeMailDomain) as exc:
            self._derive(sales_email="bob@gmail.com", contact_email="amy@Outlook.com")
        assert exc.value.status == 422
        assert exc.value.detail()["code"] == "free_mail_domain"
        assert "gmail.com" in exc.value.message

    def test_nothing_at_all_is_no_domain(self):
        with pytest.raises(le.NoDomain) as exc:
            self._derive(website="not a site")
        assert exc.value.detail() == {
            "code": "no_domain",
            "message": "No company domain on this lead — add its website first.",
        }


# ── Mappers (pure) ──────────────────────────────────────────────────────────


class TestMappers:
    def test_a_domain_search_row_maps_to_a_candidate(self):
        assert le.candidate_from_domain_email(CIARAN) == {
            "first_name": "Ciaran",
            "last_name": "Lee",
            "full_name": "Ciaran Lee",
            "email": "ciaran@acme.com",
            "position": "Support Engineer",
            "phone": None,
            "linkedin_url": None,
            "confidence": 92,
            "verification": "valid",
            "kind": "personal",
            "source": "hunter",
        }

    def test_a_row_without_an_address_is_dropped(self):
        assert le.candidate_from_domain_email({**CIARAN, "value": None}) is None
        assert le.candidate_from_domain_email({**CIARAN, "value": "  "}) is None

    @pytest.mark.parametrize(
        ("raw", "url"),
        [
            ("https://www.linkedin.com/in/ada", "https://www.linkedin.com/in/ada"),
            ("linkedin.com/in/ada", "https://linkedin.com/in/ada"),
            ("ada-lovelace", "https://www.linkedin.com/in/ada-lovelace"),
            ("in/ada", "https://www.linkedin.com/in/ada"),
            (None, None),
            ("", None),
        ],
    )
    def test_linkedin_handles_become_urls(self, raw, url):
        assert le.linkedin_url(raw) == url

    def test_named_people_first_then_confidence(self):
        rows = [
            {
                **CIARAN,
                "value": "sales@acme.com",
                "type": "generic",
                "first_name": None,
                "last_name": None,
                "confidence": 99,
            },
            {**CIARAN, "value": "low@acme.com", "confidence": 40},
            {**CIARAN, "value": "high@acme.com", "confidence": 95},
        ]
        got = le.domain_search_result(_domain_payload(rows))["candidates"]
        assert [c["email"] for c in got] == ["high@acme.com", "low@acme.com", "sales@acme.com"]

    def test_a_payload_without_data_is_a_provider_error(self):
        with pytest.raises(le.ProviderUnavailable):
            le.domain_search_result({"errors": []})

    def test_the_email_finder_maps_its_score(self):
        got = le.email_suggestion(
            {
                "data": {
                    "first_name": "Ian",
                    "last_name": "Locke",
                    "email": "ian@fdh.com",
                    "score": 97,
                    "position": "SVP Sales",
                    "linkedin_url": None,
                    "phone_number": None,
                    "verification": {"status": "valid"},
                }
            }
        )
        assert got["email"] == "ian@fdh.com"
        assert got["confidence"] == 97
        assert got["verification"] == "valid"

    def test_the_email_finder_finding_nobody_is_none(self):
        assert le.email_suggestion({"data": {"email": None, "score": None}}) is None
        assert le.email_suggestion({}) is None


# ── The route ───────────────────────────────────────────────────────────────


class TestUnconfigured:
    def test_no_key_404s_both_routes_and_calls_nobody(
        self, client, leads_db, auth_header, monkeypatch
    ):  # noqa: F811
        fake = FakeHunter()
        monkeypatch.setattr(settings, "HUNTER_API_KEY", None)
        real = le.make_client
        monkeypatch.setattr(
            le, "make_client", lambda k, t=None: real(k, httpx.MockTransport(fake.handler))
        )
        h = auth_header()
        assert client.get(f"{URL}enrichment/status", headers=h).status_code == 404
        assert _get(client, h, _lead(leads_db)).status_code == 404
        monkeypatch.setattr(settings, "HUNTER_API_KEY", "   ")
        assert client.get(f"{URL}enrichment/status", headers=h).status_code == 404
        assert fake.requests == []

    def test_status_says_configured_without_spending_a_credit(
        self, client, leads_db, auth_header, hunter
    ):  # noqa: F811
        r = client.get(f"{URL}enrichment/status", headers=auth_header())
        assert r.status_code == 200
        assert r.json() == {"configured": True, "provider": "hunter"}
        assert hunter.requests == []


class TestSearch:
    def test_domain_search_request_and_answer(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = _lead(leads_db)
        lead.website = "https://www.fdh.com/"
        lead.contact_email = "ian@fdh.com"  # a known address: no Email Finder call
        leads_db.commit()
        r = _get(client, auth_header(), lead)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["provider"] == "hunter"
        assert body["domain"] == "fdh.com"
        assert body["domain_source"] == "website"
        assert body["organization"] == "Acme"
        assert body["pattern"] == "{first}"
        assert body["lead_id"] == str(lead.id)
        assert body["contact_email_suggestion"] is None
        assert [c["email"] for c in body["candidates"]] == ["ciaran@acme.com"]
        assert body["candidates"][0]["existing_lead_id"] is None

        (req,) = hunter.requests
        assert req.url.path == "/v2/domain-search"
        assert dict(req.url.params) == {"domain": "fdh.com", "limit": "10"}
        # The key rides a header, never the URL (httpx logs URLs).
        assert req.headers["X-API-KEY"] == KEY
        assert KEY not in str(req.url)

    def test_a_named_contact_without_an_address_also_asks_the_email_finder(
        self,
        client,
        leads_db,
        auth_header,
        hunter,  # noqa: F811
    ):
        lead = _lead(leads_db)
        lead.website = "fdh.com"
        leads_db.commit()
        hunter.finder_reply = (
            200,
            {
                "data": {
                    "first_name": "Ian",
                    "last_name": "Locke",
                    "email": "ian@fdh.com",
                    "score": 91,
                    "verification": {"status": "accept_all"},
                }
            },
        )
        body = _get(client, auth_header(), lead).json()
        (finder,) = hunter.calls("email-finder")
        assert dict(finder.url.params) == {"domain": "fdh.com", "full_name": "Ian Locke"}
        s = body["contact_email_suggestion"]
        assert (s["email"], s["confidence"], s["verification"]) == ("ian@fdh.com", 91, "accept_all")
        # The lead IS Ian Locke — the suggestion is marked as this very lead.
        assert s["existing_lead_id"] == str(lead.id)
        assert body["suggestion_error"] is None

    def test_a_placeholder_does_not_ask_the_email_finder(
        self, client, leads_db, auth_header, hunter
    ):  # noqa: F811
        lead = _placeholder(leads_db)
        lead.website = "acme-interconnect.com"
        leads_db.commit()
        assert _get(client, auth_header(), lead).status_code == 200
        assert hunter.calls("email-finder") == []

    def test_the_manufacturer_website_is_the_last_resort(
        self, client, leads_db, auth_header, hunter
    ):  # noqa: F811
        lead = _lead(leads_db, "Lumissil", "Kim Ray")
        mfr = Manufacturer(
            id=uuid.uuid4(),
            name="Lumissil",
            slug="lumissil-x",
            canonical_key="lumissil-x",
            website="https://www.lumissil.com",
        )
        leads_db.add(mfr)
        leads_db.commit()  # no Lead→Manufacturer relationship orders the flush
        lead.manufacturer_id = mfr.id
        lead.contact_email = "kim@lumissil.com"
        leads_db.commit()
        body = _get(client, auth_header(), lead).json()
        # contact_email outranks the manufacturer; same domain either way here.
        assert body["domain"] == "lumissil.com"
        lead.contact_email = None
        leads_db.commit()
        le.clear_cache()
        body = _get(client, auth_header(), lead).json()
        assert (body["domain"], body["domain_source"]) == ("lumissil.com", "manufacturer")

    def test_a_candidate_already_on_the_roster_is_marked(
        self, client, leads_db, auth_header, hunter
    ):  # noqa: F811
        placeholder = _placeholder(leads_db)  # Acme Interconnect
        placeholder.website = "acme-interconnect.com"
        ian = _lead(leads_db)  # a roster row at ANOTHER company must not match
        leads_db.commit()
        colleague = Lead(
            id=uuid.uuid4(),
            source_key="acme interconnect|ciaran lee",
            company_name="Acme Interconnect",
            company_slug=placeholder.company_slug,
            contact_name="Ciaran Lee",
            needs_enrichment=False,
            contact_attempts=0,
        )
        by_email = Lead(
            id=uuid.uuid4(),
            source_key="acme interconnect|dana roe",
            company_name="Acme Interconnect",
            company_slug=placeholder.company_slug,
            contact_name="Dana Roe",
            contact_email="DANA@acme-interconnect.com",
            needs_enrichment=False,
            contact_attempts=0,
        )
        leads_db.add_all([colleague, by_email])
        leads_db.commit()
        hunter.domain_reply = (
            200,
            _domain_payload(
                [
                    CIARAN,
                    {
                        **CIARAN,
                        "value": "dana@acme-interconnect.com",
                        "first_name": "D.",
                        "last_name": "Roe",
                        "confidence": 80,
                    },
                    {
                        **CIARAN,
                        "value": "ian@acme-interconnect.com",
                        "first_name": "Ian",
                        "last_name": "Locke",
                        "confidence": 70,
                    },
                ]
            ),
        )
        got = {
            c["email"]: c["existing_lead_id"]
            for c in _get(client, auth_header(), placeholder).json()["candidates"]
        }
        assert got["ciaran@acme.com"] == str(colleague.id)  # by name
        assert got["dana@acme-interconnect.com"] == str(by_email.id)  # by address
        assert got["ian@acme-interconnect.com"] is None  # Ian is at FDH, not here
        assert str(ian.id) not in got.values()


class TestRefusals:
    def test_no_domain_is_a_named_422_and_spends_nothing(
        self, client, leads_db, auth_header, hunter
    ):  # noqa: F811
        r = _get(client, auth_header(), _lead(leads_db))
        assert r.status_code == 422
        assert r.json()["detail"]["code"] == "no_domain"
        assert hunter.requests == []

    def test_free_mail_only_is_a_named_422(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = _lead(leads_db)
        lead.sales_email = "fdh.sales@gmail.com"
        leads_db.commit()
        r = _get(client, auth_header(), lead)
        assert r.status_code == 422
        assert r.json()["detail"]["code"] == "free_mail_domain"
        assert hunter.requests == []

    @pytest.mark.parametrize(
        ("reply", "reason"),
        [
            ((500, {"errors": [{"id": "server", "code": 500}]}), "error"),
            ((401, {"errors": [{"id": "authentication_failed", "code": 401}]}), "auth"),
            ((403, {"errors": [{"id": "too_many_requests", "code": 403}]}), "rate_limited"),
            ((429, {"errors": [{"id": "too_many_requests", "code": 429}]}), "quota"),
            ((200, "<html>not json</html>"), "bad_payload"),
            ((200, {"errors": []}), "bad_payload"),
            (httpx.ReadTimeout("slow"), "timeout"),
            (httpx.ConnectError("down"), "network"),
        ],
    )
    def test_provider_trouble_is_a_502_with_a_reason(
        self,
        client,
        leads_db,
        auth_header,
        hunter,
        reply,
        reason,  # noqa: F811
    ):
        lead = _lead(leads_db)
        lead.website = "fdh.com"
        leads_db.commit()
        hunter.domain_reply = reply
        r = _get(client, auth_header(), lead)
        assert r.status_code == 502
        detail = r.json()["detail"]
        assert detail["code"] == "provider_unavailable"
        assert detail["reason"] == reason
        assert detail["message"]
        assert KEY not in r.text

    def test_a_failed_email_finder_keeps_the_company_list(
        self, client, leads_db, auth_header, hunter
    ):  # noqa: F811
        lead = _lead(leads_db)
        lead.website = "fdh.com"
        leads_db.commit()
        hunter.finder_reply = (500, {"errors": []})
        r = _get(client, auth_header(), lead)
        assert r.status_code == 200
        assert len(r.json()["candidates"]) == 1
        assert r.json()["contact_email_suggestion"] is None
        assert r.json()["suggestion_error"] == "Hunter didn't answer; try again in a minute."

    def test_an_email_finder_404_is_simply_no_match(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = _lead(leads_db)
        lead.website = "fdh.com"
        leads_db.commit()
        hunter.finder_reply = (404, {"errors": [{"id": "not_found"}]})
        body = _get(client, auth_header(), lead).json()
        assert body["contact_email_suggestion"] is None
        assert body["suggestion_error"] is None

    def test_a_viewer_is_refused(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = _lead(leads_db)
        admin = leads_db.query(User).filter_by(username="admin").first()
        admin.role = "viewer"
        leads_db.commit()
        h = auth_header()
        assert _get(client, h, lead).json()["detail"] == "no_leads_access"
        assert client.get(f"{URL}enrichment/status", headers=h).status_code == 403
        assert hunter.requests == []

    def test_a_customers_private_lead_is_404(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = _lead(leads_db)
        lead.user_id = uuid.uuid4()
        lead.website = "fdh.com"
        leads_db.commit()
        assert _get(client, auth_header(), lead).status_code == 404
        assert hunter.requests == []


class TestReadOnly:
    def test_the_route_writes_nothing(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = _placeholder(leads_db)
        lead.website = "acme-interconnect.com"
        leads_db.commit()
        leads_db.refresh(lead)
        before = (
            lead.updated_at,
            lead.contact_name,
            lead.contact_email,
            lead.needs_enrichment,
            leads_db.query(Lead).count(),
            leads_db.query(LeadContact).count(),
        )
        assert _get(client, auth_header(), lead).status_code == 200
        leads_db.expire_all()
        lead = leads_db.get(Lead, lead.id)
        after = (
            lead.updated_at,
            lead.contact_name,
            lead.contact_email,
            lead.needs_enrichment,
            leads_db.query(Lead).count(),
            leads_db.query(LeadContact).count(),
        )
        assert after == before

    def test_the_route_holds_no_write_calls(self):
        """Belt and braces: the handler's source never adds, commits or sets."""
        import inspect

        from app.routes import admin_leads

        src = inspect.getsource(admin_leads.lead_enrichment_candidates)
        for verb in ("db.add", "db.commit", "db.delete", "setattr(", "db.flush"):
            assert verb not in src, verb


class TestCache:
    def _ready(self, db, website="fdh.com"):
        lead = _lead(db)
        lead.website = website
        lead.contact_email = "ian@fdh.com"
        db.commit()
        return lead

    def test_a_second_open_spends_no_credit(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = self._ready(leads_db)
        h = auth_header()
        first = _get(client, h, lead).json()
        second = _get(client, h, lead).json()
        assert first == second
        assert len(hunter.calls("domain-search")) == 1

    def test_the_cache_is_per_domain_and_shared_across_leads(
        self, client, leads_db, auth_header, hunter
    ):  # noqa: F811
        self._ready(leads_db)
        other = _lead(leads_db, "FDH Electronics", "Nathan Little")
        other.website = "https://www.fdh.com"
        other.contact_email = "nathan@fdh.com"
        leads_db.commit()
        h = auth_header()
        _get(client, h, _lead(leads_db))
        _get(client, h, other)
        assert len(hunter.calls("domain-search")) == 1

    def test_an_empty_answer_is_cached_too(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = self._ready(leads_db)
        hunter.domain_reply = (200, _domain_payload([]))
        h = auth_header()
        assert _get(client, h, lead).json()["candidates"] == []
        _get(client, h, lead)
        assert len(hunter.calls("domain-search")) == 1

    def test_an_error_is_not_cached(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = self._ready(leads_db)
        hunter.domain_reply = (500, {"errors": []})
        h = auth_header()
        assert _get(client, h, lead).status_code == 502
        hunter.domain_reply = (200, _domain_payload([CIARAN]))
        assert _get(client, h, lead).status_code == 200
        assert len(hunter.calls("domain-search")) == 2

    def test_entries_expire_after_a_day(self, client, leads_db, auth_header, hunter, monkeypatch):  # noqa: F811
        lead = self._ready(leads_db)
        clock = [1000.0]
        monkeypatch.setattr(le.time, "monotonic", lambda: clock[0])
        h = auth_header()
        _get(client, h, lead)
        clock[0] += le.CACHE_TTL_SECONDS - 1
        _get(client, h, lead)
        assert len(hunter.calls("domain-search")) == 1
        clock[0] += 2
        _get(client, h, lead)
        assert len(hunter.calls("domain-search")) == 2

    def test_one_leads_decoration_never_leaks_into_the_cache(
        self, client, leads_db, auth_header, hunter
    ):  # noqa: F811
        """The route stamps existing_lead_id per lead; the cached answer must
        stay undecorated or the NEXT lead would inherit this one's marks."""
        lead = self._ready(leads_db)
        _get(client, auth_header(), lead)
        hit, value = le._cache_get(("domain-search", "fdh.com"))
        assert hit
        assert all("existing_lead_id" not in c for c in value["candidates"])


class TestLogHygiene:
    def test_the_key_never_reaches_a_log_line(self, client, leads_db, auth_header, hunter, caplog):  # noqa: F811
        lead = _lead(leads_db)
        lead.website = "fdh.com"
        leads_db.commit()
        hunter.domain_reply = (401, {"errors": [{"id": "authentication_failed"}]})
        with caplog.at_level(logging.DEBUG):
            _get(client, auth_header(), lead)
        assert caplog.records, "the failure should be logged"
        assert all(KEY not in r.getMessage() for r in caplog.records)


class TestTheWayOutOfNoDomain:
    def test_a_patched_website_is_what_the_search_uses_and_never_rekeys(
        self,
        client,
        leads_db,
        auth_header,
        hunter,  # noqa: F811
    ):
        """The 422 says "add its website first" — so the lead's page must be
        able to: LeadUpdate takes `website`, and the next search uses it."""
        lead = _placeholder(leads_db)
        key = lead.source_key
        h = auth_header()
        assert _get(client, h, lead).json()["detail"]["code"] == "no_domain"
        r = client.patch(f"{URL}{lead.id}", json={"website": "https://www.acme-ic.com"}, headers=h)
        assert r.status_code == 200
        assert r.json()["website"] == "https://www.acme-ic.com"
        body = _get(client, h, lead).json()
        assert (body["domain"], body["domain_source"]) == ("acme-ic.com", "website")
        leads_db.expire_all()
        assert leads_db.get(Lead, lead.id).source_key == key

    def test_the_website_keeps_the_column_bound(self, client, leads_db, auth_header):  # noqa: F811
        lead = _placeholder(leads_db)
        r = client.patch(f"{URL}{lead.id}", json={"website": "x" * 201}, headers=auth_header())
        assert r.status_code == 422
