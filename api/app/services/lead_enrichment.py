"""Contact enrichment for the Leads CRM — Hunter.io (owner ask, 2026-09-25).

"Enriching data with contact info would be wonderful." A rep opens a lead and
asks "who works there, and what is this person's address?". This module asks
Hunter and hands back CANDIDATES; it writes nothing. The rep reviews them and
applies one through the CRM's existing doors (PATCH a placeholder, or POST a
new lead) — so the identity rules, the 409s and the audit trail are the ones
every other lead already goes through.

Two Hunter endpoints, contract checked against hunter.io/api-documentation/v2
on 2026-09-25:

  GET /v2/domain-search?domain=…&limit=…  → data.{domain, organization,
      pattern, emails[{value, type, confidence, first_name, last_name,
      position, linkedin, phone_number, verification{status}}]}
  GET /v2/email-finder?domain=…&full_name=… → data.{email, score, position,
      linkedin_url, phone_number, verification{status}}; email null (200) when
      nobody is found. Neither endpoint charges a credit for an empty answer.

The key travels as the X-API-KEY header, never a query parameter: httpx logs
request URLs, and a key in one would land in the container log. Errors come
back as {"errors": [{"id", "code", "details"}]}; 401 = bad key, 403 = the rate
limit (15/s, 500/min), 429 = the plan's monthly allowance is spent.

Every answer (empty ones included) is STORED — `lead_enrichment_searches`,
migration 060, owner ask 2026-09-25: "prevent people from searching companies
that have already been searched for". A company's domain is searched once, a
named person once per domain, and from then on every lead at that domain
reads the stored answer. Reading (`stored_enrichment`) never calls Hunter;
searching (`search_enrichment`) calls it only for what is not stored yet, so
the block is enforced here on the server, not by hiding a button. Errors are
never stored — a failed search can be run again.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

import httpx
from sqlalchemy.orm import Session

from app.models import LeadEnrichmentSearch

logger = logging.getLogger(__name__)

HUNTER_API = "https://api.hunter.io/v2"
PROVIDER = "hunter"

# A rep is waiting on the panel: fail in seconds, not the default minute.
TIMEOUT = httpx.Timeout(12.0, connect=5.0)
# 10 is ONE Domain Search credit (Hunter bills per 10 addresses returned).
DOMAIN_SEARCH_LIMIT = 10

# The two stored search kinds — `lead_enrichment_searches.kind`.
DOMAIN_SEARCH = "domain-search"
EMAIL_FINDER = "email-finder"

# Hosted mailboxes: a lead's gmail address says nothing about who else works
# at the company, and a Domain Search on gmail.com would spend a credit on
# strangers. A candidate source on one of these is skipped; a lead with
# nothing else is refused by name.
FREE_MAIL_DOMAINS = frozenset(
    {
        "aol.com",
        "att.net",
        "bellsouth.net",
        "comcast.net",
        "cox.net",
        "earthlink.net",
        "fastmail.com",
        "gmail.com",
        "gmx.com",
        "gmx.net",
        "googlemail.com",
        "hey.com",
        "hotmail.com",
        "icloud.com",
        "live.com",
        "mac.com",
        "mail.com",
        "me.com",
        "msn.com",
        "outlook.com",
        "proton.me",
        "protonmail.com",
        "qq.com",
        "rocketmail.com",
        "sbcglobal.net",
        "verizon.net",
        "yahoo.com",
        "yandex.com",
        "ymail.com",
        "zoho.com",
    }
)


# ── Errors: each carries the route's status, a code and the rep's sentence ──


class EnrichmentError(Exception):
    status = 502
    code = "provider_unavailable"

    def __init__(self, message: str, reason: str | None = None):
        super().__init__(message)
        self.message = message
        self.reason = reason

    def detail(self) -> dict[str, Any]:
        out: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.reason:
            out["reason"] = self.reason
        return out


class NoDomain(EnrichmentError):
    status = 422
    code = "no_domain"


class FreeMailDomain(EnrichmentError):
    status = 422
    code = "free_mail_domain"


class ProviderUnavailable(EnrichmentError):
    status = 502
    code = "provider_unavailable"


# ── Domain derivation (pure) ────────────────────────────────────────────────


def normalise_host(value: str | None) -> str | None:
    """A bare lower-case host from a website string ('https://www.Acme.com/x',
    'acme.com', 'www.acme.com:8080') — `www.` and a trailing dot stripped.
    None when there is no plausible host (no dot, stray characters)."""
    raw = (value or "").strip()
    if not raw:
        return None
    if "://" not in raw:
        raw = "http://" + raw.lstrip("/")
    try:
        host = urlsplit(raw).hostname or ""
    except ValueError:
        return None
    host = host.strip().rstrip(".").lower()
    if host.startswith("www."):
        host = host[4:]
    if "." not in host or not all(ch.isalnum() or ch in ".-" for ch in host):
        return None
    if host.startswith(("-", ".")) or ".." in host:
        return None
    return host


def domain_of_email(value: str | None) -> str | None:
    raw = (value or "").strip()
    if raw.count("@") != 1:
        return None
    return normalise_host(raw.split("@", 1)[1])


@dataclass(frozen=True)
class DomainChoice:
    domain: str
    # Which field it came from: website | sales_email | contact_email | manufacturer
    source: str


def derive_domain(
    *,
    website: str | None,
    sales_email: str | None,
    contact_email: str | None,
    manufacturer_website: str | None,
) -> DomainChoice:
    """The company's domain, from the first field that holds one: the lead's
    website, then the domain of its sales email, then of the contact's email,
    then the linked manufacturer's website. A free-mail domain is skipped;
    if that leaves nothing, the refusal names it (FreeMailDomain) rather than
    claiming the lead has no domain at all (NoDomain)."""
    candidates = (
        ("website", normalise_host(website)),
        ("sales_email", domain_of_email(sales_email)),
        ("contact_email", domain_of_email(contact_email)),
        ("manufacturer", normalise_host(manufacturer_website)),
    )
    free_mail: str | None = None
    for source, domain in candidates:
        if domain is None:
            continue
        if domain in FREE_MAIL_DOMAINS:
            free_mail = free_mail or domain
            continue
        return DomainChoice(domain=domain, source=source)
    if free_mail:
        raise FreeMailDomain(
            f"This lead only has a {free_mail} address, which is a personal mailbox, "
            "not the company's. Add the company's website first."
        )
    raise NoDomain("No company domain on this lead — add its website first.")


# ── Payload mappers (pure) ──────────────────────────────────────────────────


def _text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return round(value)
    return None


def linkedin_url(value: Any) -> str | None:
    """Hunter returns LinkedIn as a full URL on some records and a bare handle
    on others; the CRM stores a URL either way."""
    text = _text(value)
    if text is None:
        return None
    if text.lower().startswith(("http://", "https://")):
        return text
    if "linkedin.com/" in text.lower():
        return "https://" + text.lstrip("/")
    handle = text.strip("/").removeprefix("in/")
    return f"https://www.linkedin.com/in/{handle}" if handle else None


def _full_name(first: str | None, last: str | None) -> str | None:
    return " ".join(p for p in (first, last) if p) or None


def _verification(value: Any) -> str | None:
    return _text(value.get("status")) if isinstance(value, dict) else None


def candidate_from_domain_email(item: dict[str, Any]) -> dict[str, Any] | None:
    """One Domain Search `emails[]` row → our candidate shape. None when the
    row carries no address (it is the one thing a candidate must have)."""
    email = _text(item.get("value"))
    if email is None:
        return None
    first, last = _text(item.get("first_name")), _text(item.get("last_name"))
    return {
        "first_name": first,
        "last_name": last,
        "full_name": _full_name(first, last),
        "email": email,
        "position": _text(item.get("position")),
        "phone": _text(item.get("phone_number")),
        "linkedin_url": linkedin_url(item.get("linkedin")),
        "confidence": _int(item.get("confidence")),
        "verification": _verification(item.get("verification")),
        # personal | generic — a generic address (sales@) names nobody.
        "kind": _text(item.get("type")),
        "source": PROVIDER,
    }


def rank_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Named people first, then by confidence (highest first); the provider's
    own order breaks ties. Generic addresses sink to the bottom."""
    return sorted(
        candidates,
        key=lambda c: (c["full_name"] is None, -(c["confidence"] or 0)),
    )


def domain_search_result(payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise ProviderUnavailable("Hunter sent an answer we could not read.", reason="bad_payload")
    rows = data.get("emails")
    if not isinstance(rows, list):
        rows = []
    mapped = (candidate_from_domain_email(r) for r in rows if isinstance(r, dict))
    candidates = [c for c in mapped if c]
    return {
        "organization": _text(data.get("organization")),
        "pattern": _text(data.get("pattern")),
        "candidates": rank_candidates(candidates),
    }


def email_suggestion(payload: dict[str, Any]) -> dict[str, Any] | None:
    """An Email Finder answer → a suggestion, or None when Hunter found no
    address (it answers 200 with `email: null`, and charges nothing)."""
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return None
    email = _text(data.get("email"))
    if email is None:
        return None
    first, last = _text(data.get("first_name")), _text(data.get("last_name"))
    return {
        "first_name": first,
        "last_name": last,
        "full_name": _full_name(first, last),
        "email": email,
        "position": _text(data.get("position")),
        "phone": _text(data.get("phone_number")),
        "linkedin_url": linkedin_url(data.get("linkedin_url")),
        "confidence": _int(data.get("score")),
        "verification": _verification(data.get("verification")),
        "kind": "personal",
        "source": PROVIDER,
    }


# ── The provider client ─────────────────────────────────────────────────────


def make_client(api_key: str, transport: httpx.BaseTransport | None = None) -> httpx.Client:
    """``transport`` exists for tests — an httpx.MockTransport plays Hunter
    without a network (the fake_stripe pattern)."""
    return httpx.Client(
        base_url=HUNTER_API,
        headers={"X-API-KEY": api_key, "Accept": "application/json"},
        timeout=TIMEOUT,
        transport=transport,
    )


# Status → (reason, the rep's sentence). Hunter's own meanings, per its docs.
_REFUSALS: dict[int, tuple[str, str]] = {
    401: ("auth", "Hunter refused our API key. Ask the owner to check it."),
    403: ("rate_limited", "Hunter is asking us to slow down; try again in a minute."),
    429: ("quota", "This month's Hunter searches are used up."),
}
_DIDNT_ANSWER = "Hunter didn't answer; try again in a minute."


def _get(
    client: httpx.Client, path: str, params: dict[str, Any], *, allow_404: bool = False
) -> dict | None:
    try:
        resp = client.get(path, params=params)
    except httpx.TimeoutException:
        logger.warning("hunter %s timed out", path)
        raise ProviderUnavailable(_DIDNT_ANSWER, reason="timeout") from None
    except httpx.HTTPError as exc:
        logger.warning("hunter %s transport error: %s", path, type(exc).__name__)
        raise ProviderUnavailable(_DIDNT_ANSWER, reason="network") from None
    if allow_404 and resp.status_code == 404:
        return None
    if resp.status_code != 200:
        # Status only: the body can echo request parameters, never the key,
        # but a status is all an operator needs.
        logger.warning("hunter %s -> HTTP %s", path, resp.status_code)
        reason, message = _REFUSALS.get(resp.status_code, ("error", _DIDNT_ANSWER))
        raise ProviderUnavailable(message, reason=reason)
    try:
        payload = resp.json()
    except ValueError:
        raise ProviderUnavailable(
            "Hunter sent an answer we could not read.", reason="bad_payload"
        ) from None
    if not isinstance(payload, dict):
        raise ProviderUnavailable("Hunter sent an answer we could not read.", reason="bad_payload")
    return payload


def domain_search(client: httpx.Client, domain: str) -> dict[str, Any]:
    payload = _get(client, "/domain-search", {"domain": domain, "limit": DOMAIN_SEARCH_LIMIT})
    return domain_search_result(payload or {})


def find_email(client: httpx.Client, domain: str, full_name: str) -> dict[str, Any] | None:
    payload = _get(
        client, "/email-finder", {"domain": domain, "full_name": full_name}, allow_404=True
    )
    return email_suggestion(payload) if payload is not None else None


# ── The store (migration 060) ───────────────────────────────────────────────


def finder_key(domain: str, full_name: str) -> str:
    """One person at one domain — case and spacing folded, so "Ian  LOCKE"
    is the search already made for "Ian Locke"."""
    return f"{domain}|{' '.join(full_name.lower().split())}"


@dataclass(frozen=True)
class SearchPlan:
    """What a lead needs from Hunter: its company's domain, and — when the
    lead names a contact with no address yet — that person's address."""

    choice: DomainChoice
    finder_name: str | None

    def keys(self) -> dict[str, str]:
        out = {DOMAIN_SEARCH: self.choice.domain}
        if self.finder_name:
            out[EMAIL_FINDER] = finder_key(self.choice.domain, self.finder_name)
        return out


def plan_search(
    *,
    website: str | None,
    sales_email: str | None,
    contact_name: str | None,
    contact_email: str | None,
    manufacturer_website: str | None,
) -> SearchPlan:
    """Raises NoDomain / FreeMailDomain (422) before anything is read."""
    choice = derive_domain(
        website=website,
        sales_email=sales_email,
        contact_email=contact_email,
        manufacturer_website=manufacturer_website,
    )
    name = (contact_name or "").strip()
    # A known address is not worth a credit.
    needs_finder = bool(name) and not (contact_email or "").strip()
    return SearchPlan(choice=choice, finder_name=name if needs_finder else None)


def _stored(db: Session, plan: SearchPlan) -> dict[str, LeadEnrichmentSearch]:
    keys = plan.keys()
    rows = (
        db.query(LeadEnrichmentSearch)
        .filter(
            LeadEnrichmentSearch.kind.in_(list(keys)),
            LeadEnrichmentSearch.key.in_(list(keys.values())),
        )
        .all()
    )
    return {row.kind: row for row in rows if keys.get(row.kind) == row.key}


def _store(db: Session, kind: str, key: str, payload: Any, actor: str | None) -> None:
    """INSERT … ON CONFLICT DO NOTHING, then commit: when two reps search the
    same company at once, the first row stands and both read it back. (Not a
    begin_nested savepoint — see part_identity._insert_if_absent.)"""
    if db.bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as _insert
    else:
        from sqlalchemy.dialects.sqlite import insert as _insert
    values = {
        "id": uuid.uuid4(),
        "kind": kind,
        "key": key,
        "payload": json.dumps(payload),
        "searched_by": actor,
        "searched_at": datetime.now(UTC),
    }
    db.execute(_insert(LeadEnrichmentSearch.__table__).values(**values).on_conflict_do_nothing())
    db.commit()


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _answer(
    plan: SearchPlan,
    rows: dict[str, LeadEnrichmentSearch],
    suggestion_error: str | None = None,
) -> dict[str, Any]:
    """The route's shape, from stored rows only. `pending` lists the kinds a
    search would still spend a credit on; `searched` is "nothing left to
    spend on"."""
    company_row = rows.get(DOMAIN_SEARCH)
    finder_row = rows.get(EMAIL_FINDER)
    company = json.loads(company_row.payload) if company_row else {}
    pending = [kind for kind in plan.keys() if kind not in rows]
    return {
        "provider": PROVIDER,
        "configured": True,
        "domain": plan.choice.domain,
        "domain_source": plan.choice.source,
        "searched": not pending,
        "pending": pending,
        "searched_by": company_row.searched_by if company_row else None,
        "searched_at": _iso(company_row.searched_at) if company_row else None,
        "organization": company.get("organization"),
        "pattern": company.get("pattern"),
        "candidates": company.get("candidates", []),
        "contact_email_suggestion": json.loads(finder_row.payload) if finder_row else None,
        "suggestion_error": suggestion_error,
    }


def stored_enrichment(db: Session, **lead_fields: str | None) -> dict[str, Any]:
    """What is already known about this lead's company. NEVER calls Hunter,
    never writes — opening a lead costs nothing."""
    plan = plan_search(**lead_fields)
    return _answer(plan, _stored(db, plan))


def search_enrichment(
    db: Session,
    *,
    api_key: str,
    actor: str | None,
    transport: httpx.BaseTransport | None = None,
    **lead_fields: str | None,
) -> dict[str, Any]:
    """Ask Hunter for whatever this lead needs that is NOT stored yet, store
    each answer with the actor, and return the stored shape. When everything
    is stored already, Hunter is not called at all — the owner's block,
    enforced here rather than in the UI."""
    plan = plan_search(**lead_fields)
    rows = _stored(db, plan)
    pending = [kind for kind in plan.keys() if kind not in rows]
    if not pending:
        return _answer(plan, rows)

    domain = plan.choice.domain
    suggestion_error: str | None = None
    with make_client(api_key, transport) as client:
        if DOMAIN_SEARCH in pending:
            # A failure here raises (502) and stores nothing.
            found = domain_search(client, domain)
            _store(db, DOMAIN_SEARCH, domain, found, actor)
        if EMAIL_FINDER in pending and plan.finder_name:
            try:
                suggestion = find_email(client, domain, plan.finder_name)
            except ProviderUnavailable as exc:
                # The company list already arrived; losing it to a failed
                # second call would be the worse answer. Not stored, so the
                # person can be looked up again.
                suggestion_error = exc.message
            else:
                _store(db, EMAIL_FINDER, plan.keys()[EMAIL_FINDER], suggestion, actor)
    return _answer(plan, _stored(db, plan), suggestion_error)
