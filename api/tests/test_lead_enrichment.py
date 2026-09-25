"""Contact enrichment (Hunter.io) — GET /api/admin/leads/{id}/enrichment reads
the STORED answer and never calls Hunter; POST …/enrichment/search calls it
only for what is not stored yet (migration 060, owner 2026-09-25: "prevent
people from searching companies that have already been searched for").

Neither route writes a lead: the rep applies a candidate through the existing
PATCH/POST. These tests play Hunter with an httpx.MockTransport (the
fake_stripe idea — real httpx, no network), so the request the service builds
is asserted, not assumed.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

import httpx
import pytest

from app.config import settings
from app.models import Lead, LeadContact, LeadEnrichmentSearch, Manufacturer, User
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
    """The free read — never calls Hunter."""
    return client.get(f"{URL}{lead.id}/enrichment", headers=headers)


def _search(client, headers, lead: Lead):
    """The spend — calls Hunter for whatever is not stored yet."""
    return client.post(f"{URL}{lead.id}/enrichment/search", headers=headers)


def _rows(db) -> list[LeadEnrichmentSearch]:
    db.expire_all()
    return db.query(LeadEnrichmentSearch).order_by(LeadEnrichmentSearch.kind).all()


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


# ── The routes ──────────────────────────────────────────────────────────────


class TestUnconfigured:
    def test_no_key_404s_every_route_and_calls_nobody(
        self,
        client,
        leads_db,
        auth_header,
        monkeypatch,  # noqa: F811
    ):
        fake = FakeHunter()
        monkeypatch.setattr(settings, "HUNTER_API_KEY", None)
        real = le.make_client
        monkeypatch.setattr(
            le, "make_client", lambda k, t=None: real(k, httpx.MockTransport(fake.handler))
        )
        h = auth_header()
        lead = _lead(leads_db)
        lead.website = "fdh.com"
        leads_db.commit()
        assert client.get(f"{URL}enrichment/status", headers=h).status_code == 404
        assert _get(client, h, lead).status_code == 404
        assert _search(client, h, lead).status_code == 404
        monkeypatch.setattr(settings, "HUNTER_API_KEY", "   ")
        assert client.get(f"{URL}enrichment/status", headers=h).status_code == 404
        assert _search(client, h, lead).status_code == 404
        assert fake.requests == []
        assert _rows(leads_db) == []

    def test_status_says_configured_without_spending_a_credit(
        self,
        client,
        leads_db,
        auth_header,
        hunter,  # noqa: F811
    ):
        r = client.get(f"{URL}enrichment/status", headers=auth_header())
        assert r.status_code == 200
        assert r.json() == {"configured": True, "provider": "hunter"}
        assert hunter.requests == []


class TestTheReadIsFree:
    def test_get_on_a_fresh_company_says_unsearched_and_calls_nobody(
        self,
        client,
        leads_db,
        auth_header,
        hunter,  # noqa: F811
    ):
        lead = _lead(leads_db)
        lead.website = "https://www.fdh.com/"
        leads_db.commit()
        r = _get(client, auth_header(), lead)
        assert r.status_code == 200, r.text
        body = r.json()
        assert (body["domain"], body["domain_source"]) == ("fdh.com", "website")
        assert body["configured"] is True
        assert body["searched"] is False
        # Ian Locke is named with no address: a search would spend on both.
        assert body["pending"] == ["domain-search", "email-finder"]
        assert (body["searched_by"], body["searched_at"]) == (None, None)
        assert body["candidates"] == []
        assert body["contact_email_suggestion"] is None
        assert hunter.requests == []
        assert _rows(leads_db) == []

    def test_get_after_a_search_returns_the_stored_answer_without_calling(
        self,
        client,
        leads_db,
        auth_header,
        hunter,  # noqa: F811
    ):
        lead = _lead(leads_db)
        lead.website = "fdh.com"
        lead.contact_email = "ian@fdh.com"
        leads_db.commit()
        h = auth_header()
        searched = _search(client, h, lead).json()
        calls = len(hunter.requests)
        assert calls == 1
        read = _get(client, h, lead).json()
        assert read == searched
        assert read["searched"] is True
        assert len(hunter.requests) == calls


class TestSearch:
    def test_domain_search_request_answer_and_row(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = _lead(leads_db)
        lead.website = "https://www.fdh.com/"
        lead.contact_email = "ian@fdh.com"  # a known address: no Email Finder call
        leads_db.commit()
        r = _search(client, auth_header(), lead)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["provider"] == "hunter"
        assert body["domain"] == "fdh.com"
        assert body["domain_source"] == "website"
        assert body["organization"] == "Acme"
        assert body["pattern"] == "{first}"
        assert body["lead_id"] == str(lead.id)
        assert body["searched"] is True
        assert body["pending"] == []
        assert body["searched_by"] == "admin"
        assert body["searched_at"]
        assert body["contact_email_suggestion"] is None
        assert [c["email"] for c in body["candidates"]] == ["ciaran@acme.com"]
        assert body["candidates"][0]["existing_lead_id"] is None

        (req,) = hunter.requests
        assert req.url.path == "/v2/domain-search"
        assert dict(req.url.params) == {"domain": "fdh.com", "limit": "10"}
        # The key rides a header, never the URL (httpx logs URLs).
        assert req.headers["X-API-KEY"] == KEY
        assert KEY not in str(req.url)

        (row,) = _rows(leads_db)
        assert (row.kind, row.key, row.searched_by) == ("domain-search", "fdh.com", "admin")
        assert row.searched_at is not None

    def test_a_named_contact_without_an_address_also_asks_the_email_finder(
        self,
        client,
        leads_db,  # noqa: F811
        auth_header,
        hunter,
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
        body = _search(client, auth_header(), lead).json()
        (finder,) = hunter.calls("email-finder")
        assert dict(finder.url.params) == {"domain": "fdh.com", "full_name": "Ian Locke"}
        s = body["contact_email_suggestion"]
        assert (s["email"], s["confidence"], s["verification"]) == ("ian@fdh.com", 91, "accept_all")
        # The lead IS Ian Locke — the suggestion is marked as this very lead.
        assert s["existing_lead_id"] == str(lead.id)
        assert body["suggestion_error"] is None
        assert body["pending"] == []

    def test_a_placeholder_does_not_ask_the_email_finder(
        self,
        client,
        leads_db,
        auth_header,
        hunter,  # noqa: F811
    ):
        lead = _placeholder(leads_db)
        lead.website = "acme-interconnect.com"
        leads_db.commit()
        assert _get(client, auth_header(), lead).json()["pending"] == ["domain-search"]
        assert _search(client, auth_header(), lead).status_code == 200
        assert hunter.calls("email-finder") == []

    def test_the_manufacturer_website_is_the_last_resort(
        self,
        client,
        leads_db,
        auth_header,
        hunter,  # noqa: F811
    ):
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
        assert (body["domain"], body["domain_source"]) == ("lumissil.com", "contact_email")
        lead.contact_email = None
        leads_db.commit()
        body = _get(client, auth_header(), lead).json()
        assert (body["domain"], body["domain_source"]) == ("lumissil.com", "manufacturer")
        assert hunter.requests == []

    def test_a_candidate_already_on_the_roster_is_marked(
        self,
        client,
        leads_db,
        auth_header,
        hunter,  # noqa: F811
    ):
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
            for c in _search(client, auth_header(), placeholder).json()["candidates"]
        }
        assert got["ciaran@acme.com"] == str(colleague.id)  # by name
        assert got["dana@acme-interconnect.com"] == str(by_email.id)  # by address
        assert got["ian@acme-interconnect.com"] is None  # Ian is at FDH, not here
        assert str(ian.id) not in got.values()


class TestTheBlock:
    """The owner's rule, enforced on the server: a company searched once is
    never searched again — by this lead, a branch row, or anyone else."""

    def _ready(self, db, website="fdh.com"):
        lead = _lead(db)
        lead.website = website
        lead.contact_email = "ian@fdh.com"
        db.commit()
        return lead

    def test_a_second_search_calls_nothing(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = self._ready(leads_db)
        h = auth_header()
        first = _search(client, h, lead)
        assert first.status_code == 200
        assert len(hunter.requests) == 1
        second = _search(client, h, lead)
        assert second.status_code == 200
        assert second.json() == first.json()
        assert second.json()["searched"] is True
        assert len(hunter.requests) == 1
        assert len(_rows(leads_db)) == 1

    def test_any_lead_on_the_same_domain_is_blocked_too(
        self,
        client,
        leads_db,
        auth_header,
        hunter,  # noqa: F811
    ):
        self._ready(leads_db)
        other = _lead(leads_db, "FDH Electronics", "Nathan Little")
        other.website = "https://www.FDH.com/contact"
        other.contact_email = "nathan@fdh.com"
        leads_db.commit()
        h = auth_header()
        _search(client, h, _lead(leads_db))
        assert len(hunter.requests) == 1
        before = _get(client, h, other).json()
        assert before["searched"] is True  # the branch row sees it with no button
        assert before["searched_by"] == "admin"
        after = _search(client, h, other).json()
        assert len(hunter.requests) == 1
        assert [c["email"] for c in after["candidates"]] == ["ciaran@acme.com"]

    def test_another_rep_is_blocked_and_sees_who_searched(
        self,
        client,
        leads_db,
        auth_header,
        hunter,  # noqa: F811
    ):
        lead = self._ready(leads_db)
        _search(client, auth_header(), lead)
        rep = leads_db.query(User).filter_by(username="admin").first()
        rep.username = "anthony"
        leads_db.commit()
        body = _search(client, auth_header(), lead).json()
        assert len(hunter.requests) == 1
        assert body["searched_by"] == "admin"

    def test_an_empty_answer_is_stored_too(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = self._ready(leads_db)
        hunter.domain_reply = (200, _domain_payload([]))
        h = auth_header()
        body = _search(client, h, lead).json()
        assert (body["candidates"], body["searched"]) == ([], True)
        _search(client, h, lead)
        assert len(hunter.calls("domain-search")) == 1

    def test_an_error_is_not_stored(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = self._ready(leads_db)
        hunter.domain_reply = (500, {"errors": []})
        h = auth_header()
        assert _search(client, h, lead).status_code == 502
        assert _rows(leads_db) == []
        assert _get(client, h, lead).json()["searched"] is False
        hunter.domain_reply = (200, _domain_payload([CIARAN]))
        assert _search(client, h, lead).status_code == 200
        assert len(hunter.calls("domain-search")) == 2
        assert len(_rows(leads_db)) == 1

    def test_finder_rows_are_keyed_by_domain_and_folded_name(
        self,
        client,
        leads_db,
        auth_header,
        hunter,  # noqa: F811
    ):
        ian = _lead(leads_db)
        ian.website = "fdh.com"
        leads_db.commit()
        h = auth_header()
        _search(client, h, ian)
        assert [(r.kind, r.key) for r in _rows(leads_db)] == [
            ("domain-search", "fdh.com"),
            ("email-finder", "fdh.com|ian locke"),
        ]
        # A DIFFERENT person at the stored company: only their own lookup runs.
        nathan = _lead(leads_db, "FDH Electronics", "Nathan Little")
        nathan.website = "fdh.com"
        leads_db.commit()
        pending = _get(client, h, nathan).json()["pending"]
        assert pending == ["email-finder"]
        _search(client, h, nathan)
        assert len(hunter.calls("domain-search")) == 1
        (_, nathan_call) = hunter.calls("email-finder")
        assert nathan_call.url.params["full_name"] == "Nathan Little"
        # The same person, typed differently, is the search already made.
        ian.contact_name = "  IAN   locke "
        leads_db.commit()
        assert _get(client, h, ian).json()["searched"] is True
        _search(client, h, ian)
        assert len(hunter.calls("email-finder")) == 2

    def test_a_failed_finder_keeps_the_company_list_and_stays_pending(
        self,
        client,
        leads_db,
        auth_header,
        hunter,  # noqa: F811
    ):
        lead = _lead(leads_db)
        lead.website = "fdh.com"
        leads_db.commit()
        hunter.finder_reply = (500, {"errors": []})
        h = auth_header()
        r = _search(client, h, lead)
        assert r.status_code == 200
        body = r.json()
        assert len(body["candidates"]) == 1
        assert body["contact_email_suggestion"] is None
        assert body["suggestion_error"] == "Hunter didn't answer; try again in a minute."
        assert (body["searched"], body["pending"]) == (False, ["email-finder"])
        # A retry spends only on the person, never the company again.
        hunter.finder_reply = (200, {"data": {"email": None, "score": None}})
        retry = _search(client, h, lead).json()
        assert (retry["searched"], retry["suggestion_error"]) == (True, None)
        assert len(hunter.calls("domain-search")) == 1
        assert len(hunter.calls("email-finder")) == 2

    def test_stored_answers_are_never_decorated(self, client, leads_db, auth_header, hunter):  # noqa: F811
        """The route stamps existing_lead_id per lead; the stored answer must
        stay undecorated or the NEXT lead would inherit this one's marks."""
        import json

        lead = _lead(leads_db)
        lead.website = "fdh.com"
        hunter.finder_reply = (
            200,
            {"data": {"first_name": "Ian", "last_name": "Locke", "email": "ian@fdh.com"}},
        )
        leads_db.commit()
        _search(client, auth_header(), lead)
        for row in _rows(leads_db):
            assert "existing_lead_id" not in row.payload, row.kind
        company = json.loads(_rows(leads_db)[0].payload)
        assert set(company) == {"organization", "pattern", "candidates"}

    def test_a_racing_second_store_keeps_the_first(self, leads_db):  # noqa: F811
        le._store(leads_db, le.DOMAIN_SEARCH, "fdh.com", {"candidates": ["first"]}, "anthony")
        le._store(leads_db, le.DOMAIN_SEARCH, "fdh.com", {"candidates": ["second"]}, "daniel")
        (row,) = _rows(leads_db)
        assert (row.searched_by, row.payload) == ("anthony", '{"candidates": ["first"]}')


class TestRefusals:
    @pytest.mark.parametrize("call", [_get, _search])
    def test_no_domain_is_a_named_422_and_spends_nothing(
        self,
        client,
        leads_db,
        auth_header,
        hunter,
        call,  # noqa: F811
    ):
        r = call(client, auth_header(), _lead(leads_db))
        assert r.status_code == 422
        assert r.json()["detail"]["code"] == "no_domain"
        assert hunter.requests == []

    @pytest.mark.parametrize("call", [_get, _search])
    def test_free_mail_only_is_a_named_422(self, client, leads_db, auth_header, hunter, call):  # noqa: F811
        lead = _lead(leads_db)
        lead.sales_email = "fdh.sales@gmail.com"
        leads_db.commit()
        r = call(client, auth_header(), lead)
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
        leads_db,  # noqa: F811
        auth_header,
        hunter,
        reply,
        reason,
    ):
        lead = _lead(leads_db)
        lead.website = "fdh.com"
        leads_db.commit()
        hunter.domain_reply = reply
        r = _search(client, auth_header(), lead)
        assert r.status_code == 502
        detail = r.json()["detail"]
        assert detail["code"] == "provider_unavailable"
        assert detail["reason"] == reason
        assert detail["message"]
        assert KEY not in r.text
        assert _rows(leads_db) == []

    def test_an_email_finder_404_is_simply_no_match(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = _lead(leads_db)
        lead.website = "fdh.com"
        leads_db.commit()
        hunter.finder_reply = (404, {"errors": [{"id": "not_found"}]})
        body = _search(client, auth_header(), lead).json()
        assert body["contact_email_suggestion"] is None
        assert body["suggestion_error"] is None
        assert body["searched"] is True

    def test_a_viewer_is_refused(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = _lead(leads_db)
        lead.website = "fdh.com"
        admin = leads_db.query(User).filter_by(username="admin").first()
        admin.role = "viewer"
        leads_db.commit()
        h = auth_header()
        assert _get(client, h, lead).json()["detail"] == "no_leads_access"
        assert _search(client, h, lead).status_code == 403
        assert client.get(f"{URL}enrichment/status", headers=h).status_code == 403
        assert hunter.requests == []
        assert _rows(leads_db) == []

    @pytest.mark.parametrize("call", [_get, _search])
    def test_a_customers_private_lead_is_404(self, client, leads_db, auth_header, hunter, call):  # noqa: F811
        lead = _lead(leads_db)
        lead.user_id = uuid.uuid4()
        lead.website = "fdh.com"
        leads_db.commit()
        assert call(client, auth_header(), lead).status_code == 404
        assert hunter.requests == []


class TestNoLeadIsWritten:
    def _snapshot(self, db, lead_id):
        db.expire_all()
        lead = db.get(Lead, lead_id)
        return (
            lead.updated_at,
            lead.contact_name,
            lead.contact_email,
            lead.needs_enrichment,
            db.query(Lead).count(),
            db.query(LeadContact).count(),
        )

    def test_the_read_writes_nothing_at_all(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = _placeholder(leads_db)
        lead.website = "acme-interconnect.com"
        leads_db.commit()
        before = self._snapshot(leads_db, lead.id)
        assert _get(client, auth_header(), lead).status_code == 200
        assert self._snapshot(leads_db, lead.id) == before
        assert _rows(leads_db) == []

    def test_the_search_writes_only_its_own_row(self, client, leads_db, auth_header, hunter):  # noqa: F811
        lead = _placeholder(leads_db)
        lead.website = "acme-interconnect.com"
        leads_db.commit()
        before = self._snapshot(leads_db, lead.id)
        assert _search(client, auth_header(), lead).status_code == 200
        assert self._snapshot(leads_db, lead.id) == before
        assert len(_rows(leads_db)) == 1

    def test_the_read_holds_no_write_calls(self):
        """Belt and braces: the GET handler and the service read it calls
        never add, commit or set — and never open a Hunter client."""
        import inspect

        from app.routes import admin_leads

        for fn in (admin_leads.lead_enrichment_candidates, le.stored_enrichment, le._stored):
            src = inspect.getsource(fn)
            for verb in ("db.add", "db.commit", "db.delete", "setattr(", "db.flush", "db.execute"):
                assert verb not in src, (fn.__name__, verb)
            assert "make_client" not in src, fn.__name__


class TestLogHygiene:
    def test_the_key_never_reaches_a_log_line(self, client, leads_db, auth_header, hunter, caplog):  # noqa: F811
        lead = _lead(leads_db)
        lead.website = "fdh.com"
        leads_db.commit()
        hunter.domain_reply = (401, {"errors": [{"id": "authentication_failed"}]})
        with caplog.at_level(logging.DEBUG):
            _search(client, auth_header(), lead)
        assert caplog.records, "the failure should be logged"
        assert all(KEY not in r.getMessage() for r in caplog.records)


class TestTheWayOutOfNoDomain:
    def test_a_patched_website_is_what_the_search_uses_and_never_rekeys(
        self,
        client,
        leads_db,  # noqa: F811
        auth_header,
        hunter,
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
        body = _search(client, h, lead).json()
        assert (body["domain"], body["domain_source"]) == ("acme-ic.com", "website")
        leads_db.expire_all()
        assert leads_db.get(Lead, lead.id).source_key == key

    def test_the_website_keeps_the_column_bound(self, client, leads_db, auth_header):  # noqa: F811
        lead = _placeholder(leads_db)
        r = client.patch(f"{URL}{lead.id}", json={"website": "x" * 201}, headers=auth_header())
        assert r.status_code == 422
