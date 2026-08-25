# The Account Console — Surface Map (Project 2)

**Date:** 2026-08-25 · **Status:** captured owner vision, not yet designed
**Companion to:** `2026-08-25-customer-registration-design.md` (Project 1)

Project 1 builds registration, verification and the activation gate, and mounts
the existing admin console at `/account` **unscoped** (D16) behind staff
activation (D17). This document is what `/account` is eventually FOR. It is the
owner's product vision, recorded so it survives, plus an honest column on
whether the data to build each surface exists today.

Nothing here is committed work. It exists so Project 1 does not paint Project 2
into a corner — and it already changed Project 1 once, by revealing that account
capability is two nullable links rather than one type enum.

---

## 1. Identity — capability, not type

An account's nature is **the links it holds**, not a type column:

| `users.supplier_id` | `users.manufacturer_id` | Account is |
|---|---|---|
| — | — | Free / browsing |
| set | — | Distributor |
| — | set | Manufacturer |
| set | set | Both — e.g. Avnet |

"Both" is the normal case for the largest players, so it cannot be an
afterthought. An enum would have forced a wrong answer for Avnet on day one.

**Consequence: no route may carry two meanings.** The owner's original sketch
had `/account/suppliers` mean "my own page" for a distributor and "everyone who
sells my products" for a manufacturer — undecidable for an account holding both.
Resolved by splitting rather than renaming:

| Route | Shows | Rendered when |
|---|---|---|
| `/account/my-supply` | Their own supplier page | `supplier_id` |
| `/account/my-manufacturing` | Their own manufacturer page | `manufacturer_id` |
| `/account/manufacturers` | Manufacturers whose products they sell | `supplier_id` |
| `/account/suppliers` | Suppliers who sell their products | `manufacturer_id` |

Sidebar nav is built from the same two links, so an account never sees a route
that cannot mean anything for it.

---

## 2. Surfaces, and whether the data exists

Legend — **Derivable**: computable from today's schema with a WHERE/JOIN.
**Needs a column**: the table has no owner. **New system**: does not exist.

### `/account` — dashboard

| Tile | Owner's intent | Status |
|---|---|---|
| Total Parts | Parts tied to their account | **Derivable** — `part_listings.supplier_id` for a distributor; `parts.manufacturer_id` for a manufacturer |
| (was Active Suppliers) | Replaced by a **user-chosen KPI chart** | **New system** — needs a per-user chart preference and a KPI registry |
| Monthly Revenue | Outbound click-throughs: a visitor looks up a part here, clicks through to the distributor's own site | **New system** — see §3, and note the naming problem |
| Active Sponsors | Their sponsorships, as a **Sankey** | **Derivable** for distributors — but see §4, manufacturers cannot hold one today |
| Revenue | As now, scoped | **Derivable** from their sponsor amounts |
| Book of business | **Their** salespeople and **their** customers, not ours | **Needs a column** — the CRM has no owner |
| Site traffic | Their own site and/or the supplier/manufacturer page we will build them | **New system** — `page_views` has no per-company attribution |
| Operating costs | Cost breakdown, plus Silver/Gold/Platinum subscription lines so they see what their sponsorship costs | **Needs a column** — `expenses` has no owner |
| Social & ad engagement | Unchanged | As today |
| Leads | Businesses **they** want to sell to | **Needs a column** — `leads` has no owner |
| Recent Activity / Import Queue | Items they are adding | **Partly derivable** — `activity_events` and `supplier_feeds` are already per-supplier |

### The other routes

| Route | Intent | Status |
|---|---|---|
| `/account/parts` | Only their parts | **Derivable** |
| `/account/my-supply` | Their own supplier detail page | **Derivable** — the page already exists at `/admin/suppliers/{id}` |
| `/account/my-manufacturing` | Their own manufacturer detail page | **Derivable** |
| `/account/manufacturers` | Makers whose products they sell | **Derivable** — `part_listings` → `parts.manufacturer_id` |
| `/account/suppliers` | Distributors selling their products | **Derivable** — the same join, read the other way |
| `/account/categories` | Categories their parts appear in | **Derivable** |
| `/account/sponsors` | Manage their own sponsorships | **Derivable** for distributors; see §4 |
| `/account/expenses` | Their own expenses + subscription tiers | **Needs a column** |
| `/account/reports` | Their company's metrics | **New system** — attribution, see §3 |
| `/account/messages` | Messages from us: updates, receipts, payment confirmations | **Ready** — Project 1 adds `messages.user_id` |
| `/account/import` | Upload their own data | **Partly derivable** — the feed system is already per-supplier |
| `/account/settings` | "Company name" not "Site name"; their own integrations | Retool later |

---

## 3. Two findings worth acting on early

### The recurring one: four tables have no owner

`expenses`, `leads`, and the book-of-business CRM rows were all built for a
single company — ours. Every one of them needs an owner column before it can
appear in a customer's console, and each is a migration plus a backfill
declaring that existing rows belong to Circuit Center.

**This is the single largest piece of Project 2**, and it is invisible from the
UI sketch. Scoping `/account/parts` is a `WHERE`; scoping `/account/expenses`
is a schema change on a table with live financial data in it.

### "Monthly Revenue" would not be revenue

The intent is real and good: count visitors who look up a part here and click
through to the distributor's own site — the existing `distributorUrl()` link on
a part page, e.g. `.../part/<id>` → `digikey.com/...?keywords=<MPN>`.

That is genuinely valuable to a distributor, and it is the number that proves
this site sends them business. But it is **referral clicks, not money**. Putting
a click count under a heading that says Revenue would tell a paying customer
they earned a dollar figure we did not measure and cannot see. Name it for what
it is — Referral clicks, or Outbound traffic — and it becomes a claim we can
stand behind.

Mechanically it is a new outbound-click event table plus a tracked click on the
part page, attributed to `supplier_id`. It is the one item here that is both
new infrastructure and, arguably, the most commercially important tile on the
page: it is the evidence a sponsorship works.

---

## 4. A schema fact that blocks part of the vision

`sponsors.supplier_id` is **NOT NULL** and references `suppliers`. There is no
path for a manufacturer-linked account to hold a sponsorship.

So "manage their own sponsorships" works for a distributor and silently does
nothing for a pure manufacturer. Two ways out, both real migrations:

1. Give a manufacturer account a shadow `Supplier` row (matches how self-serve
   checkout already mints one).
2. Widen `sponsors` to reference either — an XOR like the existing
   `category_id` / `keyword` pair.

Not decided. Flagged because the vision assumes manufacturers can sponsor, and
today's schema says they cannot.

---

## 5. Open, and genuinely unknown

- **Inbound purchase enquiries in `/account/messages`.** The owner flagged this
  as "do not know if viable yet" — correct. It means routing real inbound mail
  to a customer's inbox, which is a mail-infrastructure project, not a page.
- **Which KPIs** the user-chosen dashboard chart may select from.
- **The supplier/manufacturer public pages** the owner intends to build. Site
  traffic reporting depends on them existing first.
