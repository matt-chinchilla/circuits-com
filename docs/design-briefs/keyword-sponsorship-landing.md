# Design Brief — Keyword Sponsorship Landing Page + Search Empty-State CTA

**Status:** Awaiting Claude Design. Code-side scaffolding (routes, footer link, 404 fallback) will be shipped first as Wave 1; visual design lands as Wave 2.

**Date drafted:** 2026-05-14
**Owner (engineering):** Claude Code
**Owner (design):** Claude Design (this brief)

---

## Background — what Circuit Center offers

Circuit Center offers a **keyword sponsorship** product: a manufacturer or distributor pays to claim a specific search-keyword (e.g., `spi-flash`, `low-noise op-amps`, `mlcc`). When a visitor lands on `circuitcenter.ai/keyword/<that-word>`, the sponsor's logo, description, and contact info appear as a dedicated full-page card. The intended traffic source is sponsor-driven — paid ads, external links, SEO — not in-site navigation.

That assumption left two real-world gaps:

1. **No in-site discoverability.** A site visitor who is themselves a potential sponsor (manufacturer / distributor / brand interested in the offering) has no way to learn that the product exists. There's no navbar link, no footer link, no surfacing on search-result pages, no CTA on category pages. Revenue lead that's invisible to the lead.
2. **The URL `circuitcenter.ai/keyword/` (no specific keyword) renders only the persistent PCB-banner backdrop and nothing else** — because the route `/keyword/:keyword` requires the `:keyword` param, and React Router falls through to no-match → blank render. This is the canonical entry-point URL someone would try first if they were exploring.

This brief commissions the design for **(a) a landing page at `/keyword/`** that replaces the blank-render bug AND becomes the discoverability surface, and **(b) a search empty-state CTA** that turns "no results for X" into "are you a vendor of X? sponsor this keyword →".

---

## Existing brand voice — calibrate against these

The site has a deliberate, established design system. New surfaces MUST stay inside it.

| Surface | What to study | Where |
|---|---|---|
| Datasheet-component motif | U1/U2 monospace component designators + crop-mark corners + faint PCB grid background | `frontend/src/public/pages/contact/index.tsx` + `ContactPage.module.scss` |
| Restrained type hierarchy | DM Sans for body, JetBrains Mono for component-like labels, no decorative typography | `frontend/src/shared/styles/_variables.scss` + `global.scss` |
| Theme-aware accents | All accents resolve through `var(--theme-accent)` and `var(--theme-cta-bg)` — must work across all 4 themes (base / steel / schematic / pcb) | `frontend/src/shared/styles/_themes.scss` |
| Hero "window" pattern | Inner pages don't paint their own hero — they let the persistent `<BackdropLayer />` show through via a transparent page-header band. New page must follow the same pattern. | `frontend/src/public/components/layout/PageHeaderBand.tsx`, `BackdropLayer.tsx` |
| CTA treatment | Gold "GlowButton" for primary sponsor CTAs; the existing `<GlowButton variant="gold">` on `/keyword/:keyword` is the established pattern | `frontend/src/public/components/widgets/GlowButton.tsx` and `keyword/index.tsx:151` |

**Specifically: this page should feel like the Contact page's sibling, not a generic marketing landing page.** The brand statement is "we look like a datasheet, not a SaaS homepage."

---

## Deliverable 1 — Landing page at `/keyword/` (no keyword in URL)

### Sections requested (top to bottom)

1. **Page-header band** — uses the shared `<PageHeaderBand>` component already in the codebase. Title + subtitle.
   - Title: something like "Sponsor a Keyword" or "Keyword Sponsorship"
   - Subtitle: one sentence that explains the offering. Aim for the same tone as the Contact page's "Two founders. Two direct lines. No gatekeepers, no ticket queue, no chatbot."

2. **Value-prop hero** (the body of the page)
   - Establish what this is for someone who's never heard of it.
   - 1-2 sentences max. The brand voice is laconic.
   - Consider a datasheet-style block with monospace labels — e.g., `PRODUCT: KEYWORD-SPONSORSHIP` / `AUDIENCE: BUYERS SEARCHING FOR <YOUR KEYWORD>` / `PLACEMENT: DEDICATED LANDING PAGE` — see if that motif feels right.

3. **How it works** — numbered steps. Probably 3 steps.
   - Suggested: (1) Pick a keyword. (2) Choose tier. (3) Go live in 48 hours.
   - Adjust copy to match actual workflow once design + product agree.

4. **Keyword availability check** — interactive input
   - User types a candidate keyword. We hit `/api/sponsors/keyword/<input>/` (this endpoint exists; returns 404 if no sponsor for that keyword, or 200 with the sponsor data).
   - If 404 → green "available" affordance + "Request this keyword" button (opens the existing `<RequestModal>` from `keyword/index.tsx`).
   - If 200 → red/amber "already taken — by <sponsor name>" affordance, possibly with a "see this sponsor's page →" deep-link.
   - **Empty input state needed too.**

5. **Tier explanation (optional — your call)** — silver / gold / platinum
   - These tiers already exist in the `/join` form's flow (see `frontend/src/public/pages/join/`). Decide whether to surface pricing on this page or punt to "contact sales."
   - If you surface them, match the visual treatment from `/join` so they feel consistent.

6. **FAQ** — collapsible accordion or static cards
   - 3-5 questions. Suggestions: "How exclusive is a keyword?", "What if my keyword has multiple variants?", "How long is the commitment?", "Can I see traffic stats?", "What's the difference between keyword and category sponsorship?"
   - Copy can come from product/sales — Claude Design just needs the visual structure.

7. **Footer** — uses the shared `<Footer>` already in place.

### Interactions to design

- **Keyword search → availability check**: debounced input (400ms), then API call. Loading state, success state, "taken" state, "available" state. Error state if API fails.
- **"Request this keyword" CTA**: opens the existing `<RequestModal>`. Modal is already built; design only the trigger button + how it relates to the search input above.
- **Page-load entrance**: matches the existing pattern — `motion.div` with `opacity:0, x:20 → opacity:1, x:0`, duration 0.15s, ease easeInOut. Page-level entrance is standard; section-level entrances (the FAQ accordion, etc.) are design's call.

### Responsive

- Desktop (≥1024px): main content max-width 960px, centered.
- Tablet (768–1023px): same layout, slightly tighter padding.
- Mobile (<768px): single column, stack sections, the keyword-availability input is full-width.

---

## Deliverable 2 — Search empty-state CTA

When a visitor searches via the navbar search bar (or the in-page search on `/search`) and the API returns 0 results, the page currently shows a generic empty state (look at `frontend/src/public/pages/search/index.tsx` for the current empty render).

Add a card BELOW the existing empty state — same `surface` background, same datasheet feel — with this approximate content:

> **No results for `<the-user's-query>`.**
> Are you a manufacturer or distributor of `<query>` components?
> **→ Sponsor this keyword.**

The CTA links to `/keyword/<the-query>` (Claude Code will wire the routing). The link should pre-fill the query so the sponsor page knows what keyword to show.

Design constraints:
- Card sits BELOW the existing empty state — does not replace it. The user might be searching for a real part and just have a typo; we don't want to derail them.
- Visually quieter than the primary search-action area. Secondary CTA, not primary.
- Same `var(--theme-accent)` / `var(--theme-cta-bg)` palette so it works across all 4 themes.

Mobile: same card stacks naturally; the CTA pill should be tap-target ≥44pt.

---

## What's EXPLICITLY out of scope for this brief

The following are Claude Code's responsibility — design should NOT spec these:

- The route handler — Claude Code adds `<Route path="/keyword" element={<KeywordLandingPage />}>` and the 404 fallback for `/keyword/<empty-string>` edge cases.
- The footer link addition.
- The form fields inside `<RequestModal>` — already built, working, talks to `POST /api/keyword-request`.
- Backend changes — none needed. The existing `Sponsor` model and `/api/sponsors/keyword/<keyword>/` endpoint already provide availability lookup.
- A11y compliance — Claude Code will follow established patterns (aria-labels, keyboard navigation, focus management) once the visual design lands.
- The keyword sponsorship FAQ copy — design just provides the visual shell. Copywriting comes from product / sales.

---

## Deliverables checklist

- [ ] Figma frame: `/keyword/` landing page at 1280px (desktop)
- [ ] Figma frame: `/keyword/` landing page at 430px (mobile)
- [ ] Figma frame: search empty-state CTA card at 1280px
- [ ] Figma frame: search empty-state CTA card at 430px
- [ ] Color tokens used (referenced from `_themes.scss` — list which vars)
- [ ] Component inventory — which existing components are reused vs which are new
- [ ] Copy that's authored (hero / value-prop). Sections where copy is TBD can be marked "[copy TBD]".

---

## Engineering follow-up after design ships

Once Claude Design delivers the visuals + frames:

1. Claude Code converts to React + SCSS Modules matching the existing bounded-context structure (`frontend/src/public/pages/keyword-landing/` or similar).
2. Wires the route in `App.tsx` and adds the footer link.
3. Hooks the availability check to the existing `api.getSponsorByKeyword(...)` service method.
4. Runs `visual-regression-guard` agent to confirm no theme drift on the new surfaces.
5. Adds the design's empty-state card to `SearchPage` with the linked CTA.

Estimated implementation: 4-6 hours once frames are final.

---

## Open questions for product / sales (not for design to answer)

These are decisions the business needs to make BEFORE design ships pricing-related sections. Flagging them here so they're not blockers:

- Are tier prices public on this page, or gated behind "contact sales"?
- Is keyword sponsorship sold per-month, per-year, or one-off? Auto-renewing?
- Is there an exclusivity guarantee per keyword, or can multiple sponsors share?
- What's the SLA on going live after request submission (currently described as "48 hours" speculatively above)?

If any of these are unresolved at design time, mark them as "[business decision TBD]" in the frame so engineering knows not to hardcode.
