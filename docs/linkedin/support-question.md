# LinkedIn Developer Support enquiry — retention class of member post/follower analytics

**Prepared:** 2026-08-18
**Decides:** whether to declare the "Executive Management" use case on the Community Management API
access request (the request cannot be amended, and a rejected app cannot re-apply — a new app is required).

---

## 1. Where and how to send it

**Route:** LinkedIn Developer Support Portal contact form — <https://www.linkedin.com/help/linkedin/ask/dsapi>

This is the single documented door for developer/API questions. It is referenced from every LinkedIn
API page on Microsoft Learn ("submit a request on the LinkedIn Developer Support Portal") and from the
partner support guide at
<https://learn.microsoft.com/en-us/linkedin/shared/linkedin-api-partner-support-guide>.

**Form fields to select** (per the partner support guide, "When submitting a ticket"):

| Field | Value |
| --- | --- |
| Application Client ID | your app's API key (from Developer Portal → My Apps → Auth) |
| Form Type | **Developer Support** (not "Vetting Appeal" — that form is only for identity-vetting denials) |
| What API Product do you require support for? | **Community Management** |
| Description | the enquiry text in §2 below |

**Prerequisites:**

1. You must be signed in to LinkedIn.
2. You need a **Client ID**, which means a developer application must already exist in the Developer
   Portal (<https://developer.linkedin.com/> → My Apps → Create App). An app can be created — and
   therefore a Client ID obtained — *before* any product is requested or granted.
3. Before ticketing, LinkedIn asks you to try the docs and the Help Assistant chat on
   <https://developer.linkedin.com/> first. Doing so costs nothing and the chat transcript sometimes
   produces a faster written answer you can cite.

**Can a ticket be raised before the product is granted?** Mechanically, yes — the only hard input is a
Client ID, which exists at app creation, and LinkedIn explicitly runs a "Vetting Appeal" form type for
apps that have *not* been granted access, which shows the portal serves pre-approval developers.
**However, LinkedIn nowhere documents an SLA or even a commitment to answer policy-interpretation
questions from an app with no approved product.** Treat a timely answer as unlikely, not assured —
see the fallback plan in §3. There is no published response-time target for Developer Support tickets;
the only published figure anywhere nearby is "up to 30 business days" for an Ads API tier-upgrade review.

**Practical sequencing note:** create the app *first*, raise this ticket against that Client ID, and only
submit the Community Management access request once you have an answer or have decided to proceed on
the fallback assumption. Requesting Community Management API access will grey the product out for that
app, and the app cannot re-apply after a rejection.

---

## 2. Enquiry text (paste into the Description field)

> **Subject: Retention classification for authenticated-member post and follower analytics
> (memberCreatorPostAnalytics, memberFollowersCount)**
>
> Do the aggregate counts returned by `GET /rest/memberCreatorPostAnalytics` and
> `GET /rest/memberFollowersCount` for the authenticating member fall within "Members' Social Activity
> Data" (48 hours), or are they treated as reporting data with a longer permitted retention?
>
> The Data Storage Requirements table
> (https://learn.microsoft.com/en-us/linkedin/marketing/data-storage-requirements) defines:
>
> - **Members' Social Activity Data** — "Data relating to social activity by LinkedIn members, including
>   articles, posts/shares, likes, comments, mentions, and the metadata relating thereto (e.g. time of
>   creation, content, visibility, etc.)" — **48 Hours**.
> - **Organization Pages' Admin and Reporting Data** — "Data relating to administration and reporting for
>   an organization's LinkedIn page (e.g. number of followers, summary of social actions, visitor
>   information). Does not include individual member level data." — **One Year**.
>
> The table has no row for member-level admin and reporting data, and the organization row expressly
> excludes individual member-level data. The values at issue are integer aggregates for the authenticated
> member's own content — IMPRESSION, REACTION and COMMENT counts from `memberCreatorPostAnalytics`, and
> follower counts from `memberFollowersCount`. They contain no third-party member data and no post or
> comment content.
>
> Intended use: a historical engagement trend line over the authorizing member's own posts, in that
> member's private internal dashboard — no export, no combination with other data, no third-party display.
>
> Please confirm:
>
> 1. Yes or no — are these aggregates "Members' Social Activity Data"?
> 2. If no, what retention period applies, and which clause governs?
> 3. If the governing clause sits outside the Data Storage Requirements page, please cite it.
>
> Application Client ID: `<INSERT CLIENT ID>`

*(~250 words. Do not add background, product pitch, or thanks-in-advance padding — it lengthens the
read and dilutes the yes/no ask.)*

---

## 3. Fallback plan — if Support does not answer, or answers ambiguously

**Assume the 48-hour cap applies, and build so the feature survives that assumption.** Three reasons this
is the correct default rather than a pessimistic one:

1. The Data Storage Requirements page states the tie-break explicitly: *"if a given data field is
   encompassed by two or more of the following requirements, the shortest storage/caching duration shall
   apply"* — and, on conflict with the Terms, *"the requirements that are more restrictive or more
   protective of the data apply."* An unclassified member-level metric therefore resolves **downward**,
   to 48 hours, not upward to one year.
2. The Restricted Use Cases page restates the rule as a flat prohibition without carving out aggregates:
   *"No Data Storage in Excess of 48 hours: Under our Data Storage Requirements, member social activity
   data can only be stored for 48 hours."*
3. Retention non-compliance is grounds for losing API access, and LinkedIn reserves the right to revoke a
   previously approved integration. The downside of guessing wrong is losing the product, not a warning.

**The feature is still buildable under that assumption, because LinkedIn serves the history itself.**
Both endpoints accept a `dateRange` and return **daily** buckets, so the trend line can be re-fetched
from LinkedIn on demand instead of accumulated locally:

- `GET /rest/memberCreatorPostAnalytics?q=me&queryType=REACTION&aggregation=DAILY&dateRange=(start:(...),end:(...))`
- `GET /rest/memberFollowersCount?q=dateRange&dateRange=(start:(...),end:(...))`

Design to that shape:

- **Never persist a durable series.** Hold the response in a cache with a hard TTL **under 48 hours**
  (24h is the safer round number, and it matches the stricter member-profile-data line), with the TTL
  enforced by a deletion job, not merely by a cache-eviction hint.
- **Do not render on every page load.** With Community Management **Development Tier** capped at
  **100 API calls per member per 24 hours** (and 500 per app per 24 hours), a per-render fetch will
  exhaust the member quota. Fetch on a fixed schedule — e.g. twice a day per member — and serve the
  dashboard from the short-TTL cache.
- **Know which metrics you cannot trend this way.** `aggregation=DAILY` is *not supported* for
  `MEMBERS_REACHED`, `LINK_CLICKS`, `FOLLOWER_GAINED_FROM_CONTENT` or `PROFILE_VIEW_FROM_CONTENT` —
  those are `TOTAL` only. A trend line for those four can only be built by storing your own daily
  snapshots, which is exactly the practice at risk. **Scope the v1 trend line to the DAILY-capable
  metrics** (`IMPRESSION`, `RESHARE`, `REACTION`, `COMMENT`, `POST_SAVE`, `POST_SEND`,
  `PREMIUM_CTA_CLICKS`) and leave the TOTAL-only metrics as single "lifetime" figures until the
  retention question is answered in writing.
- **Delete on revocation.** If the member disconnects or LinkedIn access is revoked, purge the cache
  immediately — the Marketing API Program Terms require deletion on member request.

**On the access request itself:** the fallback design above uses only aggregate analytics for the
authorizing member's own profile, which is squarely inside the documented "Executive Management" /
"Member Analytics" surface of the Community Management API. Declaring the use case is therefore not
contingent on the retention answer — only the *storage architecture* is. Declare it; build to 48 hours.
Note that the Standard Tier screencast for an Executive Management use case expects you to demonstrate
posting to a profile and how a comment by another member is displayed — if the dashboard is analytics-only,
say so explicitly in the recording (LinkedIn's guidance: "If your application doesn't include certain
functionality specified in the above test cases, please just note that in your recording").

**If Support answers ambiguously**, reply once asking only for the governing clause citation (question 3
above). Do not accept a paraphrase as authority — retain the written answer, with the ticket number, as
the compliance record for the retention decision.

---

## 4. Sources

| What | URL |
| --- | --- |
| Data Storage Requirements (the retention table; verbatim quotes above) | <https://learn.microsoft.com/en-us/linkedin/marketing/data-storage-requirements?view=li-lms-2026-08> |
| Restricted Uses of LinkedIn Marketing APIs and Data ("No Data Storage in Excess of 48 hours") | <https://learn.microsoft.com/en-us/linkedin/marketing/restricted-use-cases?view=li-lms-2026-08> |
| Member Post Statistics (`memberCreatorPostAnalytics`: queryType values, DAILY vs TOTAL) | <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics?view=li-lms-2026-08> |
| Member Follower Statistics (`memberFollowersCount`: `q=me`, `q=dateRange`) | <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/follower-statistics?view=li-lms-2026-08> |
| Community Management overview (tiers, approved use cases incl. Member Analytics, rate-limit FAQ) | <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview?view=li-lms-2026-08> |
| Community Management App Review (vetting, Executive Management screencast requirements, no re-apply) | <https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review?view=li-lms-2026-08> |
| Increasing Access (Development Tier: 500/app/24h, 100/member/24h) | <https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access?view=li-lms-2026-08> |
| LinkedIn API Partner Support (ticket form fields, required info) | <https://learn.microsoft.com/en-us/linkedin/shared/linkedin-api-partner-support-guide> |
| Rate Limiting (per-app vs per-member, 429s, midnight-UTC reset) | <https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits> |
| Developer Support Portal (submission target) | <https://www.linkedin.com/help/linkedin/ask/dsapi> |
| LinkedIn Marketing API Terms (referenced by the docs; not read for this note) | <https://www.linkedin.com/legal/l/marketing-api-terms> |

### Verbatim policy language located

**"Members' Social Activity Data"** — Data Storage Requirements, allowed duration **48 Hours**:

> Data relating to social activity by LinkedIn members, including articles, posts/shares, likes, comments,
> mentions, and the metadata relating thereto (e.g. time of creation, content, visibility, etc.). For
> clarity, this restriction shall not limit your ability to store data relating to social activity by
> organizations, provided such data doesn't relate to LinkedIn members. For example, if an organization
> comments on a member's share, the organization's comment is not subject to this restriction but the
> content of the member's share is.

**"Organization Pages' Admin and Reporting Data"** — allowed duration **One Year**:

> Data relating to administration and reporting for an organization's LinkedIn page (e.g. number of
> followers, summary of social actions, visitor information). Does not include individual member level data.

**Tie-break clause**, same page:

> If there's any conflict between these requirements and the requirements in the terms, the requirements
> that are more restrictive or more protective of the data apply. Similarly, if a given data field is
> encompassed by two or more of the following requirements, the shortest storage/caching duration shall apply.

**Restricted Use Cases**, "Restrictions on Member Data":

> **No Data Storage in Excess of 48 hours:** Under our Data Storage Requirements, member social activity
> data can only be stored for 48 hours, and most member profile data can only be cached for 24 hours.

### `memberCreatorPostAnalytics` — documented behaviour (as of API version 202608)

- Permission: `r_member_postAnalytics`. Finders: `q=me` (aggregated across the member's posts) and
  `q=entity` (a single `ugcPost`/`share`).
- `queryType` values: `IMPRESSION`, `MEMBERS_REACHED`, `RESHARE`, `REACTION`, `COMMENT`, `POST_SAVE`,
  `POST_SEND`, `LINK_CLICKS`, `PREMIUM_CTA_CLICKS`, `FOLLOWER_GAINED_FROM_CONTENT`,
  `PROFILE_VIEW_FROM_CONTENT`. Docs note `RESHARE`, `REACTION`, `COMMENT` "are not consistent with UI at
  the moment."
- `aggregation`: `TOTAL` (default) or `DAILY`. **`DAILY` is not supported for `MEMBERS_REACHED`,
  `LINK_CLICKS`, `FOLLOWER_GAINED_FROM_CONTENT` or `PROFILE_VIEW_FROM_CONTENT`.** Also: "Daily impression
  metrics are not supported if given entity is post."
- `dateRange` optional; omitted ⇒ lifetime. Start inclusive, end exclusive.
- Response `count` carries the caveat: "Data is best-effort accurate and shouldn't be used for billing purposes."
- Breaking change in version 202605: `metricType` changed from object to string in the response body.

`memberFollowersCount` — permission `r_member_profileAnalytics`; `q=me` (lifetime) and `q=dateRange`
(daily counts across the range).

### Not confirmed

1. **The Marketing API Terms themselves were not read** (<https://www.linkedin.com/legal/l/marketing-api-terms>).
   Everything quoted above is from the developer documentation, which the Terms page may qualify. If the
   answer matters legally rather than operationally, read the Terms — particularly Section 3, "Use of
   Marketing APIs and Marketing Data," which the Restricted Use Cases page points at.
2. **There is no definition of "Members' Social Activity Data" beyond the table row quoted above.** No
   separate glossary exists in the developer docs. Whether an *aggregate count derived from* social
   activity is itself social-activity "metadata" is precisely the undefined edge — which is why the
   enquiry asks LinkedIn to classify it rather than asserting a reading.
3. **No row in the retention table covers member-level admin/reporting data at all.** This is a genuine
   gap in the published table, not an oversight in the research.
4. **Whether Developer Support answers policy questions from an app with no approved product is
   undocumented.** Mechanically the ticket can be filed (only a Client ID is required, obtainable at app
   creation); no SLA, and no statement either way about scope.
5. **No published response-time target for Developer Support tickets.** The 30-business-day figure in the
   docs refers to Ads API tier-upgrade reviews, not support tickets.
6. Screenshots of the actual contact form were not captured — the field names in §1 come from LinkedIn's
   own written walkthrough, not from loading the form. Field labels may differ slightly in the live UI.
