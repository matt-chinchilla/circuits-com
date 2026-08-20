# LinkedIn Community Management API — Development Tier access request

**Draft answers for review. Not submitted.**
Prepared 2026-08-18 · Applicant: Circuit Center · Target: Community Management API, **Development tier**

---

## How to use this

1. **Read the two red-flag findings in [§1](#1-stop-read-this-first) before anything else.** One of them may mean you should not submit yet.
2. Fill in every `TBD` in [§2 INPUTS REQUIRED FROM MATTHEW](#2-inputs-required-from-matthew). The form cannot be started honestly until these exist.
3. Work the [§3 pre-flight checklist](#3-pre-flight-checklist-do-all-of-this-before-opening-the-form). Four of the listed terminal-rejection reasons are pre-flight failures, not answer failures.
4. Open the form, and for each question find the matching topic in [§4](#4-the-answers). Paste the block marked **PASTE**. Do not retype from memory — the value of this document is that it has been proofread.
5. Before you hit submit, re-read [§6 DO NOT SAY](#6-do-not-say). That section exists because the likeliest way to fail is to improvise one extra helpful-sounding sentence into a restricted use case.

**Why the care:** a rejected Development tier application is terminal for that app. LinkedIn's own words: *"If your application is rejected, review the qualifications, create a new app, and submit a new Development tier access request form. You won't be able to re-apply for Development tier access with your existing app."* The Company Page verification, the app record, and the app name all have to be built again.

**A note on field names.** LinkedIn does not publish the literal field labels of this form anywhere — not on Microsoft Learn, not on the product catalog page, and the third-party walkthroughs deliberately withhold them. What *is* published is the exact list of things reviewers check. So this document is organised **by topic**, and each topic names the documented review criterion it satisfies. Expect the form's wording to differ from the headings here; match on meaning.

---

## 1. STOP — read this first

### 1a. "Registered legal organization" vs. sole proprietorship — possible blocker

LinkedIn: *"At this time, our Community Management APIs are only available to **registered legal organizations** for commercial use cases only."* Reviewers explicitly check **"Verified organization."**

`frontend/src/public/services/businessInfo.ts` records the current state of the business:

```
legalName:  'Circuit Center'
entityType: 'sole proprietorship'   // S-corp formation in progress, accountant engaged 2026-08-05
```

A sole proprietorship is a business but is not obviously a *registered legal organization*. This is exactly the kind of ambiguity a reviewer resolves against the applicant, and the cost of losing that coin-flip is the whole app.

**Recommendation: do not submit until the S-corp is formed and you can put an entity name with a registration behind it.** The commercial use case is real and the integration is clean; the only thing that would sink this application is the applicant's own paperwork, and that paperwork is already in motion. Waiting costs weeks. Submitting early and losing costs the app plus the weeks.

If you decide to submit as a sole proprietorship anyway, use the DBA/assumed-name certificate (Suffolk County) as the registration artifact and put the registered name in the legal-name field exactly as it appears on that certificate.

### 1b. Registered address — you are already blocked on this

`MAILING_ADDRESS` is deliberately `null` in the codebase; the commercial mail address has been chosen but not opened. The form asks for a **registered address** and reviewers verify the organization. There is no honest way to answer this field today, and the previously fabricated address (`1 Industry Park Way…`) is guarded against in `businessInfo.test.ts` and must not be resurrected here.

Also: many registries and some verification processes reject a bare PO box as a *registered* address. If the box you are acquiring is a PO box rather than a street-addressed mailbox (CMRA / "Suite #" style), check that before you rely on it for this form **and** for Stripe account activation, which needs the same thing.

**Both 1a and 1b resolve on the same event.** Incorporation needs an address; the address unblocks the form. Sequence it once.

---

## 2. INPUTS REQUIRED FROM MATTHEW

Nothing below can be guessed. Fill each in, then the form is a copy-paste job.

| # | Field | Value | Notes |
|---|---|---|---|
| 1 | **Legal entity name** | `TBD` | Exactly as registered. Must match the Stripe account and bank account (see `businessInfo.ts` header). If incorporated: `Circuit Center, Inc.` |
| 2 | **Entity type / registration** | `TBD` | Sole proprietorship vs. S corporation — see §1a. Have the registration number / certificate to hand. |
| 3 | **Registered business address** | `TBD` — **BLOCKED** | Street-addressed, not a bare PO box if avoidable. See §1b. |
| 4 | **Business email on the circuitcenter.ai domain** | `TBD` | **Must not be a personal address** — that is a listed terminal rejection reason. Mailbox must be live and monitored: LinkedIn sends a verification email and it lands in spam often enough that the docs warn about it. Candidates already defined in `businessInfo.ts`: `hello@`, `privacy@`, `legal@`. Suggest a real named human mailbox on the domain rather than a role alias, since it is the developer contact of record. |
| 5 | **Your first / last name, job title** | `TBD` | Title should read as someone authorised to accept API terms (Owner / Founder). |
| 6 | **App name** | `TBD` | See §4.2 for constraints and safe candidates. |
| 7 | **App client ID** | `TBD` | From the Developer Portal, for your own records. |
| 8 | **LinkedIn Company Page URL** | `TBD` | The Page the app is verified against. |
| 9 | **Phone number** | `TBD` if asked | Business line. Note the standing project rule: no fabricated numbers, ever. |
| 10 | **Integration timeline** | `TBD` | How many weeks to build + test. Must fit inside the 12-month Development tier window. §4.9. |
| 11 | **Does the internal dashboard show comment *text* or commenter names?** | `TBD` — **answer this before filling §4.5 and §4.6** | The draft assumes **no** (aggregate counts only). If the answer is yes, the retention and member-data answers change materially — see §7 Q4. |
| 12 | **Executive Management: in or out?** | `TBD` | Pending decision. See §5. |
| 13 | **Demo/test credentials for the admin console** | `TBD` if asked | Documented as a Standard tier requirement, but at least one third-party account reports the Development form asking too. You have a demo door already (`POST /api/auth/demo`) — decide whether that is what you hand over. |

---

## 3. Pre-flight checklist (do all of this before opening the form)

Straight from LinkedIn's "Before You Submit the Access Request" list plus the Development tier review criteria. Each maps to a rejection reason.

- [ ] **App is brand new and product-free.** LinkedIn FAQ: *"Only request Community Management API Development Tier access with new developer applications that don't have access to other API products."* An app with another product attached greys the option out. ✅ per brief.
- [ ] **App verified by a super admin of the Circuit Center Company Page.** Reviewed criterion: *"Application verified by LinkedIn Page associated with same organization."* ✅ per brief — re-confirm it still shows verified in the portal on the day you submit.
- [ ] **App name contains no part of "LinkedIn" or "Microsoft"** — LinkedIn's own example of a forbidden portion is *"Linked or In."* See §4.2.
- [ ] **Business email verified.** Send yourself a test first; then watch spam, junk, Social and Promotions after submitting.
- [ ] **`https://circuitcenter.ai` resolves and looks like a real company site.** Verified 2026-08-18: HTTP 200.
- [ ] **`https://circuitcenter.ai/privacy` resolves.** Verified 2026-08-18: HTTP 200, `<title>Privacy Policy | Circuit Center</title>`, `<h1>Privacy Policy</h1>`. Body is client-rendered — open it in a clean browser profile once and confirm a reviewer sees full text, not an empty shell.
- [ ] **The Company Page's Website field is set to `https://circuitcenter.ai`.** Reviewed criterion: *"Verified organization website and domain address."* Page website, app website, and the business email domain should all be the same domain. A mismatch here is a cheap, silly failure.
- [ ] **Read the [Marketing API Terms](https://www.linkedin.com/legal/l/marketing-api-terms) and the [restricted use cases](https://learn.microsoft.com/en-us/linkedin/marketing/restricted-use-cases) page.** You are attesting to both.
- [ ] **Privacy policy already covers this integration** — §06 "Social Media Integrations (LinkedIn)" at `https://circuitcenter.ai/privacy#social`. Read it once more and confirm every sentence in §4 below agrees with it. It currently states the retention caps (1 year Page reporting, 48h member social activity) and that no data is sold or shared. That is a genuine asset — most applicants have no such section.

---

## 4. The answers

Each block marked **PASTE** is the prose to copy. They are written to be read in about fifteen seconds each, because a reviewer is reading many of these.

### 4.1 Business identity block
*Satisfies: verified business email · verified organization · verified organization website and domain.*

Fill from §2 — legal name (#1), registered address (#3), business email (#4), your name and title (#5).

- **Company website:** `https://circuitcenter.ai`
- **Privacy policy URL:** `https://circuitcenter.ai/privacy`
- **Company size:** 1–10 employees
- **Industry:** Software Development
- **Country / HQ:** United States — New York

### 4.2 App name
*Satisfies: "application doesn't include any portion of the LinkedIn or Microsoft names or logos (e.g. Linked or In)."*

Constraints: no `LinkedIn`, no `Linked`, no `Microsoft`, no LinkedIn/Microsoft logo in the app artwork.

Belt-and-braces suggestion, which costs nothing: **also avoid the letter sequence `in` anywhere in the name.** LinkedIn names `In` itself as a forbidden portion, and a name containing `admin`, `marketing`, or `insights` puts a substring match in front of a reviewer or a filter for no benefit.

Safe candidates (no `in`, no `linked`, no `microsoft`):

- `Circuit Center Social Desk`
- `Circuit Center Channel Console`
- `Circuit Center Comms Console`
- `Circuit Center Page Desk`

Use the Circuit Center badge logo (`@shared/components/Logo`, `badge` variant) for the app artwork.

### 4.3 Company overview — "what does your company do?"
*Satisfies: verified organization · commercial use case.*

> **PASTE**
>
> Circuit Center operates circuitcenter.ai, a searchable directory of electronic components. Engineers and buyers use it to look up parts across roughly 3,600 catalogue entries and 57 distributors and compare availability and pricing. We are a New York software company with fewer than ten people. Our revenue comes from selling sponsored placement on the directory to component distributors and manufacturers, and marketing that placement business is what we use LinkedIn for.

### 4.4 Product / application overview — "describe your application"
*Satisfies: approved use case. This is the most important answer on the form.*

> **PASTE**
>
> [APP NAME] is an internal marketing console used only by Circuit Center staff. It is not a product we sell, license, distribute, or make available to anyone outside our company. It runs inside the authenticated administrator area of our own website, behind a staff login, and in practice one marketing administrator uses it.
>
> It does two things with LinkedIn. First, a staff member composes a post in the console and publishes it to our own Circuit Center LinkedIn Company Page. Second, a nightly job retrieves organic performance figures for that same Page and for the posts we published to it, and presents them in an internal report alongside the equivalent figures from our website analytics and our email, so our team can see which marketing channel is working.
>
> All LinkedIn access is authorised through OAuth 2.0 by a super administrator of the Circuit Center Company Page. The integration touches one Company Page — our own. There is no advertising component: we do not use ad accounts, run campaigns, or use the Advertising API.

### 4.5 Use cases

Select **Page Management** and **Page Analytics**. (See §5 before deciding on Executive Management.)

#### Page Management

> **PASTE**
>
> A Circuit Center marketing administrator drafts a post in our internal console — text, a link, and optionally an image — and publishes it to the Circuit Center LinkedIn Company Page using the Posts API. The console lists the posts we have published so the administrator can keep track of our own publishing schedule and see what has gone out.
>
> Only Circuit Center employees signed in to our admin console can use this, and it can only publish to the single Company Page whose super administrator authorised the app. We do not manage Pages for clients or any third party.

#### Page Analytics

> **PASTE**
>
> Once a night our server retrieves organic performance figures for the Circuit Center Company Page and for the posts we published to it — impressions, unique impressions, clicks, reaction, comment and share counts, and follower counts — using the Follower Statistics, Page Statistics and Share Statistics APIs.
>
> Those figures are written into an internal marketing report inside the same authenticated admin console, next to the equivalent figures from our other marketing channels, so our small team can compare channel performance in one place. The report shows aggregate counts only. It displays no LinkedIn member's name, profile, photograph, or comment text. It is visible only to signed-in Circuit Center staff and appears on no public page.

### 4.6 Data handling, storage, and retention
*Satisfies: compliance with data restrictions and Data Storage Requirements. This is where you pre-empt the reviewer's questions.*

> **PASTE**
>
> LinkedIn data is retrieved server-side and stored in our own PostgreSQL database on infrastructure we control. It is displayed only inside our authenticated admin console. It is never rendered on circuitcenter.ai or any other public page, never exported, never sold, never shared with any third party, and never combined with any other dataset.
>
> We request and store only Page-level administration and reporting data — aggregate counts for our own Page and our own posts — which we retain for no longer than one year, consistent with LinkedIn's Data Storage Requirements. We do not request, store, or display individual member profile data or the content of member social activity. Access tokens are held server-side only and are never sent to the browser.
>
> Our published privacy policy describes this integration, including the retention limits, at https://circuitcenter.ai/privacy#social. A super administrator of our Company Page can revoke the authorisation at any time, which stops all further collection.

*Grounding, if a reviewer asks:* LinkedIn's Data Storage Requirements allow **one year** for "Organization Pages' Admin and Reporting Data (… number of followers, summary of social actions, visitor information). Does not include individual member level data." That is exactly and only what this integration keeps. Member profile data (24h cache) and member social activity (48h) are not requested at all — which is also the cleanest possible answer to the data-minimisation requirement.

### 4.7 Who uses it / audience
*Satisfies: "Limited Audience" restriction — member data may only be shown to people associated with that Page.*

> **PASTE**
>
> Circuit Center employees only — in practice a single marketing administrator, in a company of fewer than ten people, all of whom are associated with the Company Page in question. The console is not offered to customers, clients, partners, or any third party, and there is no version of it that anyone outside Circuit Center can sign in to.

### 4.8 Expected volume / scale
*Satisfies: sanity-checks the integration against Development tier limits (500 calls per app / 100 per member, per 24h; no BATCH_GET; webhooks disabled).*

> **PASTE**
>
> Very low. One nightly analytics job of roughly 20–40 calls, plus a handful of publish calls on days we post. One authorising administrator. This sits well inside the Development tier limits.

*Design note for you, not for the form:* keep the nightly job under 500 calls/24h and do not build it on `BATCH_GET` (no calls allowed at this tier) or on the Social Actions webhook (push notifications disabled at this tier). If the job is written against those, it will work in staging against nothing and fail on day one.

### 4.9 Timeline
> **PASTE**
>
> We expect to complete the integration and internal testing within [TBD — weeks], comfortably inside the twelve-month Development tier window.

### 4.10 Permissions requested / scopes
If the form asks you to justify scopes (they are otherwise granted automatically on approval), request only these three and say why:

| Scope | Why |
|---|---|
| `w_organization_social` | Publish our own posts to our own Company Page. |
| `r_organization_social` | Read back our own posts and their engagement counts. |
| `rw_organization_admin` | Manage our own Page and retrieve its reporting data (follower / page / share statistics). |

> **PASTE**
>
> We request only the organization-level scopes our two use cases need: w_organization_social to publish to our own Page, r_organization_social to read back our own posts and their engagement counts, and rw_organization_admin to retrieve reporting data for that Page. We are not requesting member-level posting or member-level analytics scopes, as our integration does not act on or read individual member profiles.

*(That last sentence must be deleted if Executive Management is added — see §5.)*

### 4.11 "Anything else we should know" / free text
Use this only to close doors. Do not use it to add features.

> **PASTE**
>
> This is a first-party integration: Circuit Center managing the Circuit Center Company Page. There is no reseller, agency, or client dimension, no advertising component, and no public-facing surface — nothing retrieved from LinkedIn is displayed anywhere outside our staff-only admin console.

---

## 5. Executive Management — pending decision

**Status: Matthew has not decided.** Executive Management is the use case that unlocks personal-profile posting and personal-profile/post analytics (`w_member_social`, `r_member_postAnalytics` from API version 202506, `r_member_profileAnalytics` from 202504).

**Recommendation: leave it out of this application unless you are certain you will build personal-profile posting.** The reason is the Standard tier gate, not the Development tier one. LinkedIn requires a screencast demonstrating, *for each use case you specified on the form*:

> For Executive Management Use Cases — demonstrate an application user approving access to their LinkedIn **profile** data via the complete OAuth flow; demonstrate **a user posting to their LinkedIn profile via your app**; demonstrate how a comment on that post by another member is displayed in your app; demonstrate what personal data fields from the commenter's profile are displayed.

So claiming it commits you to building profile posting *and* to displaying another member's comment and profile fields — which is the one part of this integration that currently touches member personal data and its 24h/48h retention rules. Claiming it and then not building it creates a gap between the form and the app, which is the documented way to fail the Standard tier review.

**If it is added, these answers change:**

| Where | Change |
|---|---|
| §4.4 overview | Add a third sentence: staff may also publish to their own LinkedIn profile from the console, and see analytics for their own profile posts. |
| §4.5 | Add an Executive Management block describing profile posting + profile/post analytics, explicitly authorised by the individual whose profile it is. |
| §4.6 retention | **Materially changes.** You would be handling member profile data (24h cache max, storage not allowed) and member social activity (48h max) for commenters. The "we do not request, store, or display individual member profile data" sentence becomes false and must be rewritten to state the 24h/48h caps and how they are enforced. |
| §4.10 scopes | Add `w_member_social`, `r_member_postAnalytics`, `r_member_profileAnalytics`. **Delete** the closing sentence "We are not requesting member-level posting or member-level analytics scopes…". |
| Privacy policy §06 | Needs a clause covering the personal-profile side and the 24h/48h caps for other members' data. |
| Build scope | You must actually build profile posting and a comment display before Standard tier. |

**One thing to fix either way.** Privacy policy §06 currently says the integration *"reads only our own Company Page and the posts published by the authorizing administrator."* Read in the Page-only scope that means the Page's posts, but "posts published by the authorizing administrator" can also be read as *that person's personal profile posts*. Tighten it to "the posts published to that Page" if Executive Management is out. (I have not edited it — that file is outside this document's scope.)

---

## 6. DO NOT SAY

Phrasings that map onto a documented rejection reason or restricted use case. Do not improvise near any of these, including in a phone call or follow-up email.

### 6a. The social-feed tripwire — the single biggest risk

> **"No Social Feeds:** none of the data provided via our Community Management APIs can be used in a social feed use case (e.g. to display a feed of LinkedIn company updates on the company's website or intranet)."

Banned, in any field, in any tense, including as a future plan:

- "feed", "social feed", "activity feed", "social wall", "embed", "widget", "ticker", "carousel of our posts"
- "show our latest LinkedIn posts on the homepage / footer / About page"
- "so visitors can see what we're posting"
- "syndicate", "mirror", "cross-post to our site", "republish"
- "public dashboard", "share the report with sponsors", "on our intranet"

Note the word *intranet* is named in the restriction. "Internal" is safe when it means a staff-only authenticated admin console (which is what you have); it is **not** safe if it drifts into "an internal feed of our LinkedIn updates." Always say **report** or **dashboard panel**, never **feed**.

### 6b. Advertising, sales, recruiting

Member data may not be used for these. Do not write:

- "leads", "lead generation", "prospects", "prospecting", "pipeline"
- "CRM", "enrich", "append", "audience list", "targeting", "account-based marketing"
- "sales outreach", "mass message", "DM", "connect with"
- "recruiting", "candidates", "hiring", "talent"
- Any mention of ad accounts, campaigns, Campaign Manager, or the Advertising API — including "not yet, but later."

Careful: Circuit Center's business *is* selling sponsorships. Describing the LinkedIn integration as "finding distributors to sell placements to" would be a sales use case and a rejection. The honest and safe framing is the one in §4.3: you market the business on LinkedIn and want to know how that marketing performed.

### 6c. Data handling

- "we store it indefinitely", "historical archive", "we keep all comments"
- "export to CSV / Google Sheets / a BI tool" — member data may not be exported from your application at all
- "combine with our analytics data" / "match to our customer records" — combining member data with other data is prohibited. (Comparing *channel-level totals side by side in a report* is fine and is what §4.5 says. "Combine", "merge", "join", "match" are the words to avoid.)
- "scrape", "crawl", "monitor competitors", "track other companies' pages", "brand monitoring across LinkedIn"

### 6d. Applicant identity

- **Never use a personal email address** (gmail, outlook, your own name's domain). Listed terminal rejection reason.
- Do not describe this as a "side project", "hobby", "prototype", "demo", "experiment", "learning exercise", or "just testing". The API is for registered legal organizations and commercial use cases. Everything you write must read as a business tool for an operating business — which it is.
- Do not mention that the wider site began as a demo built for a friend. Irrelevant and actively harmful here.
- No fabricated address, phone number, or entity name. Both a fake registered address and an unverifiable company are direct hits on "Verified organization".

### 6e. Scope inflation

- Do not list a use case you will not build (see §5).
- Do not say "and anything else the API allows", "we may expand to…", "eventually we'd like to…". Everything you claim must be demonstrable in a screencast at Standard tier.
- Do not describe managing Pages for clients, sponsors, or "on behalf of" anyone. One Page: your own.

---

## 7. Open questions I could not resolve

1. **Exact form field labels are not published.** Microsoft Learn, the LinkedIn product catalog page, and the third-party write-ups all describe the *categories* of information (business identity, company and product overview, use-case description, test credentials) but never the literal labels — one walkthrough author states outright that they withhold the exact form wording. Hence the topic-based structure. **Action: when you open the form, screenshot it and paste the real labels back into this document** so the next revision maps 1:1 and so a future re-application (or the Standard tier form) starts from ground truth.

2. **Does a sole proprietorship satisfy "registered legal organization"?** Not answerable from the docs. See §1a. This is the highest-severity unknown in the whole application.

3. **Will a PO box be accepted as a "registered address"?** Unknown, and unknowable until you see the form's validation. See §1b.

4. **Does the internal dashboard show comment text or commenter names?** The brief says the nightly job pulls "reactions/comments" — if that means *counts*, §4.5 and §4.6 are correct as written. If it means *comment content or commenter identity*, then you are storing member social activity (48h cap) and caching member profile data (24h cap, storage not allowed), §4.6 must be rewritten, and the app needs an actual expiry job to enforce those caps. **Confirm before submitting.**

5. **Does the Development tier form ask for test credentials?** LinkedIn's app-review page lists test credentials and the screencast under "Requirements for **Standard** Tier Upgrade Only", but at least one third-party source describes the Development form as requiring "business identity, company and product overview, use-case description, and test credentials." Be prepared either way.

6. **Executive Management: in or out?** Pending your decision. §5.

7. **Two different use-case taxonomies appear in LinkedIn's own docs.** The Community Management overview page lists approved use cases as Page Management / Page Analytics / Member Analytics / Profile Management / Employee Advocacy. The app-review page's screencast requirements — which are explicitly keyed to *"each use case that you specified in the access request form"* — enumerate Page Management / Brand Engagement / Page Analytics / Executive Management / Employee Advocacy. The second list is the better predictor of the form's actual checkboxes, and it is the one this draft assumes. If the form shows a different set, map by meaning: publishing to our own Page → Page Management; our own Page and post statistics → Page Analytics.

8. **Does the `in` substring in an app name actually matter?** LinkedIn says "any portion of the LinkedIn or Microsoft names… (e.g. Linked or In)" without defining how it is checked. §4.2 avoids the question entirely at zero cost.

9. **Development tier expiry behaviour.** The docs say you must complete integration and testing within twelve months of provisioning, but do not say what happens on day 366 if you have not upgraded to Standard. Assume access lapses; plan the Standard tier application before then.

---

## 8. Sources

All accessed 2026-08-18.

- **Community Management App Review** (the review criteria, the "before you submit" list, the no-re-apply rule, per-use-case screencast requirements) — https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review
- **Restricted Uses of LinkedIn Marketing APIs and Data** (No Social Feeds; no advertising/sales/recruiting; no export; no combining; limited audience; data minimisation) — https://learn.microsoft.com/en-us/linkedin/marketing/restricted-use-cases
- **Data Storage Requirements** (1 year for Organization Pages' Admin and Reporting Data; 6 weeks / 6 months for organization social activity; 48h member social activity; 24h member profile cache) — https://learn.microsoft.com/en-us/linkedin/marketing/data-storage-requirements
- **Increasing Access** (Development vs Standard tier; 500 calls/app/24h, 100/member/24h, no BATCH_GET, webhooks disabled; twelve-month window; full scope table) — https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access
- **Community Management — Overview** (approved use cases; FAQ #4 "new applications that don't have access to other API products") — https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview
- **Quick Start, Step 1: Apply for API Access** (where the form lives: My Apps → Products) — https://learn.microsoft.com/en-us/linkedin/marketing/quick-start
- **Community Management API product catalog** — https://developer.linkedin.com/product-catalog/marketing/community-management-api
- **LinkedIn Marketing API Terms** — https://www.linkedin.com/legal/l/marketing-api-terms
- **Associate an app with a LinkedIn Page** (Page super-admin verification) — https://www.linkedin.com/help/linkedin/answer/a548360

Local sources consulted: `frontend/src/public/services/businessInfo.ts` (legal entity, entity type, null mailing address, contact emails) and `frontend/src/public/pages/privacy/index.tsx` §06 "Social Media Integrations (LinkedIn)". Live checks: `https://circuitcenter.ai/` → 200, `https://circuitcenter.ai/privacy` → 200.
