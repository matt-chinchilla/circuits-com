# Claude Design Brief — `Messages` Admin Section

**Date:** 2026-05-07
**Author:** Matthew Chirichella for John Tietjen + Mike Kennedy (circuits.com)
**Output:** New admin section to extend the existing circuits.com design system you already authored

---

## You already built this

Reference your prior handoff at `design-import/circuits-com-design-system/project/ui_kits/admin/` — that's the existing admin design (sidebar, topbar, dashboard, parts/suppliers/categories/sponsors/reports, the un-themed light surface, DM Sans + JetBrains Mono pairing, the Lucide icon vocabulary, the U1/U2 datasheet motif from the public Contact page). Don't re-derive it. We're adding one new section into the structure you defined.

Anything below that *isn't* explicit is "match the admin you already shipped". Anything below that *is* explicit is either new data, a new motif, or a deliberate departure from what's there.

---

## TL;DR

Add a **Messages** section to the admin SPA. It's the operations dashboard for inbound communication — every contact-form / join-form / keyword-request submission from the public site lands here. Two co-founders (John = U1, Mike = U2) triage it. Future v2 turns it into a two-way email hub with threading. Today the data flies into a logger and gets lost.

The new section needs a list page, a detail page, and a tie-in to the existing notification bell in the topbar. Be opinionated about a handful of "circuits.com-flavored" details that make this feel like part of the system instead of a generic inbox.

---

## What's new

| Element | Status |
|---|---|
| Sidebar slot — "Messages" between Dashboard and Parts | New entry, Catalog group |
| Topbar `Bell` icon | Currently inert — make it functional with badge + dropdown |
| `/admin/messages` (list) and `/admin/messages/:id` (detail) | New pages |
| Message data type (4 kinds: contact / join / keyword / reply) | New domain entity |
| Inline reply UI sending from `no-reply@circuits.com` via existing SMTP path | New surface |

Everything else (chrome, route shell, motion language, iconography, density, color tokens) stays as you designed it.

---

## Where it lives in the existing admin

**Sidebar** — insert in Catalog group, second slot:

```
CATALOG: Dashboard → Messages (new) → Parts → Suppliers → Categories → Sponsors → Reports
SYSTEM:  Import Queue → Settings
```

Lucide `Inbox` or `Mail` icon — your call. The unread count rides as a circular `$error-red` pill flush right of the label, JetBrains Mono numeric, ~600ms pulse on first arrival.

**Topbar bell** — already in your AdminLayout topbar, currently decorative. Wire it up:
- Default: outline `Bell`. Unread present: filled `Bell` + red dot or count chip ("9+" past 9). Slight wiggle on first arrival, static after.
- Click → 380px-wide dropdown anchored to the bell. Last 5 unread. Each row: type-icon (32px tinted circle), sender name + 60-char message preview, relative time ("3m") in JetBrains Mono. Footer "View all messages →" links to `/admin/messages`. Empty state matches the inbox-zero illustration (see §5).

**Routes** — same Plan B nesting you used for Suppliers/Parts:
- `/admin/messages` → `MessagesListPage`
- `/admin/messages/:id` → `MessageDetailPage`
- Archive: a filter chip in the list, NOT a separate route. (Keep the route surface flat.)

---

## Data — the four message types

```ts
type Message = {
  id: string;                                      // UUID; render as MSG-0042 (sequential counter)
  type: 'contact' | 'join' | 'keyword' | 'reply';
  payload: ContactPayload | JoinPayload | KeywordPayload | ReplyPayload;
  status: 'new' | 'read' | 'archived' | 'responded';
  created_at: string;                              // ISO
  read_at?: string;
  responded_at?: string;
  assigned_to?: 'john' | 'mike' | null;
  spam_score?: number;                             // 0–1; only surfaced if > 0.6
  parent_id?: string;                              // for type='reply'; v2 threading hook
};

type ContactPayload = {
  name: string; email: string; subject: string; message: string;
  reason?: 'general' | 'list' | 'data' | 'press' | 'other';
};

type JoinPayload = {
  company_name: string; contact_person: string; email: string; phone: string;
  website?: string; categories_of_interest: string[];
  tier?: 'silver' | 'gold' | 'platinum'; message?: string;
};

type KeywordPayload = {
  company_name: string; email: string; keyword: string; message?: string;
};

type ReplyPayload = {  // v2 — leave room in design, don't render in v1 list
  to: string; subject: string; body: string; sent_by: 'john' | 'mike';
};
```

The detail view should branch its layout on `type` — JOIN reads as an *application* (commercial intent → premium feel), CONTACT reads as a *letter* (narrative), KEYWORD reads as a *spec sheet* (the keyword IS the hero).

---

## Brand applications (what circuits.com-ness shows up here)

You already built the brand. Three places to apply it:

1. **Designators.** Every message gets one — `MSG-0042`, JetBrains Mono, shown beside the subject in both list and detail. Mirror of U1/U2 from the Contact page.
2. **Type-by-color.** Subtle. Each type chip uses an existing token:
   - `CONTACT` → `$executive-blue` (PCB green) — public Contact page accent
   - `JOIN` → `$sponsor-gold` — applicant intent earns premium-tier color
   - `KEYWORD` → `$nav-blue` (#44bd13) — sponsorship-adjacent, brighter
   - `REPLY` → neutral `$admin-text-secondary`
3. **Datasheet card on detail view.** The detail-page header card gets the crop-mark corner brackets + 24px PCB grid background at 3.5% opacity — same treatment as the public Contact page founder cards. Direct echo of the strongest brand signal in the codebase. Optional, but encouraged on the detail header at minimum.

For v2 (threading), the signature feature is **SVG wire-traces between parent and reply nodes** — like a circuit schematic. Don't build it now; just leave architectural room.

---

## UI surfaces — only the parts that need detail

### `MessagesListPage`

Standard admin page shell (your AdminLayout chrome). Page header: "Messages" / "Inbound from the public site" / right-aligned filter cluster (type chips: All · Contact · Join · Keyword) + sort dropdown (Newest / Oldest / Unread first) + 320px search input.

The inbox table is the heart of the page. ~64px rows. Hover background `#f0f2f5`. Click → detail. Columns:

1. Status dot — solid `$error-red` if new, hollow ring if read, none if archived. 24px gutter.
2. Designator — `MSG-0042`, JetBrains Mono 12px secondary. 90px.
3. Type chip — `[CONTACT]` / `[JOIN]` / `[KEYWORD]` per the color rules above. JetBrains Mono 11px in a padded pill. 110px.
4. Sender — two lines, name semibold + email secondary. Flex grow.
5. Subject preview — single-line ellipsis. For Join: `"wants to list — {company_name}"`. For Keyword: `"{keyword}"`. Flex grow 2x.
6. Time — relative ("3m", "yesterday", "Mar 4"), JetBrains Mono 12px secondary. 80px right-aligned.
7. `MoreVertical` action menu — 24px button, dropdown: Mark read/unread, Archive, Assign to John/Mike, Mark as spam.

**Empty states:** inbox-zero (see §6) and filtered-no-match (text-only "No messages match this filter. [Clear filters]").

### `MessageDetailPage`

Header: back-link `← Messages` (ghost) → `MSG-0042 [TYPE]` row → subject → status pill + action buttons (Reply / Archive / Mark unread). Apply the datasheet-card treatment here.

Body branches on type:

- **CONTACT** — narrative letter. Sender card on left (initials avatar, name, email, optional phone), message body on right in a 720px-max typographic card with generous line-height. Forensic strip below: User-Agent, source URL, IP-region if available.
- **JOIN** — application. Top: 3-col summary (Company / Contact / Tier badge — gold-foil treatment). Mid: categories-of-interest as Lucide-iconed pills. Bottom: optional message. Sidebar: phone, website (linked), `View company → Suppliers` deep-link if a match exists in `/admin/suppliers/`.
- **KEYWORD** — keyword as hero. Render the keyword in `JetBrains Mono 36px`, on a card with a 1px inset `$executive-blue` border. Smaller secondary card below with company + email + optional message. *If the operator saw nothing else, this would be enough.*

**Reply panel** — anchored bottom of detail page, collapsed by default. Bar: "Reply to {sender_name}" + Reply icon. Click expands: textarea (auto-grow), preset template chips above ("Acknowledged — will follow up" / "Thanks — let's set up a call" / "Not currently a fit"), Send button (`$executive-blue`), footnote "Replies send from no-reply@circuits.com". On send: success toast → status flips to Responded → reply appended to activity log.

**Activity log** — compact timeline (right rail or below body). "Arrived 2026-05-07 14:32 EDT" / "Read by John 14:35" / "Archived by Mike 09:12". JetBrains Mono timestamps. Lucide icons per event (`Inbox`, `Eye`, `Archive`, `Send`).

---

## Functional requirements

**Must-haves (v1):**
- List view with type-filter, sort, full-text search across name/email/company/subject/message
- Click-through detail
- Mark read/unread (per-row + bulk)
- Archive (per-row + bulk)
- Reply (sends via SMTP path, status auto-flips to Responded)
- Unread badge on sidebar entry + topbar bell
- Bell dropdown — last 5 unread + "View all"
- Empty states (inbox-zero + filtered-no-match)
- Spam-score warning chip on detail when `spam_score > 0.6`

**Nice-to-haves (your call whether to mock):**
- Bulk-select toolbar (Linear-style action bar replacing page header)
- Keyboard shortcuts: `j/k` navigate, `e` archive, `r` reply, `?` shortcut overlay
- Assigned-to chip with avatar
- Activity log timeline per-message
- Right-click contextual menu

**Out of scope for v1:**
- Threading (the wire-trace feature is v2 — leave data-model room)
- Per-customer inbox for the future "company" role (separate brief)
- Email digest / push subscriptions (settings work)
- AI summary / suggested replies (could be v3 hero)

---

## Cool / aesthetic ideas — pick 4–6

This is where you flex. Ground them in the brand, ship the ones that earn their keep:

1. **Inbox-zero state.** SVG of an opened envelope with a single electron tracing along an unfurling circuit-line into a green checkmark. "Inbox zero" headline in JetBrains Mono. ~280px tall. Tasteful.
2. **Status-dot pulse on first arrival.** Pulse the red dot for ~1.5s on a newly-arrived row. Don't shake the whole row.
3. **Keyboard hint footer.** 32px footer pinned to list-page bottom: `j/k navigate · e archive · r reply · / search`. JetBrains Mono 11px secondary. Surfaces only after first keyboard interaction (don't condescend on load).
4. **Datasheet detail-header card.** Crop-mark corner brackets (4 × L-shaped 10×10px) + 24px PCB grid bg at 3.5% opacity. Direct echo of the Contact-page founder cards.
5. **Type-icon tinted circle.** 32px circle, 6%-tint background `color-mix(in srgb, var(--type-color) 6%, white)`, 100%-color icon. Use in bell dropdown + inbox rows.
6. **"Reply trace" send animation.** Thin 2px green line draws from the textarea up to the message header on send-success (300ms ease-out). Easter egg, only on success.
7. **Sender-domain favicon.** 16px favicon left of sender name (Arrow Electronics' favicon → instant recognition). Fall back to Lucide `Mail`.
8. **Status-pill micro-icons.** Tiny 10px Lucide icon leading each pill: `Inbox` for new, `Eye` for read, `Archive` for archived, `CheckCircle2` for responded.
9. **Subtle PCB-grid hover bg.** On row hover, fade in a 24px PCB grid at 2% opacity over the hover background. Most users won't notice — but it's there, and it's the brand.
10. **Reply template chips.** Horizontal Lucide-iconed chips above the textarea. Match the Contact-page reason-chip styling.
11. **Spam-score visualization.** `AlertCircle` next to designator with tooltip ("Low confidence sender — score 0.78") when score > 0.6. Don't auto-hide — operator decides.
12. **Time-of-arrival cluster headers.** Group rows by relative day with sticky cluster headers ("Today", "Yesterday", "This week", "Earlier"). JetBrains Mono 11px secondary.
13. **Soft "unread-first" sort.** Default sort floats unread up with a 1px `$error-red` left-rail accent. After click-through and back, row stays where it was — don't re-sort under the cursor.

---

## Sample data to mock against

```ts
const sampleMessages: Message[] = [
  {
    id: '0d2e8f...', type: 'join', status: 'new', spam_score: 0.02,
    created_at: '2026-05-07T14:32:11Z',
    payload: {
      company_name: 'Arrow Electronics', contact_person: 'Jane Buyer',
      email: 'jane.buyer@arrow.com', phone: '631-555-0143', website: 'arrow.com',
      categories_of_interest: ['Resistors', 'Capacitors', 'ICs'],
      tier: 'platinum',
      message: "We'd like to list our full distribution catalog with priority placement on top categories. Open to discussion on tier flexibility.",
    },
  },
  {
    id: '8b1c44...', type: 'contact', status: 'read', spam_score: 0.01,
    created_at: '2026-05-07T11:08:55Z', read_at: '2026-05-07T11:14:22Z',
    assigned_to: 'john',
    payload: {
      name: 'Tom Reilly', email: 't.reilly@gizmodo.com', reason: 'press',
      subject: 'Press inquiry — directory comparison piece',
      message: 'Working on a piece comparing electronic-component directories. Would love 15 min with John or Mike. Deadline next Friday.',
    },
  },
  {
    id: 'f23ab9...', type: 'keyword', status: 'responded',
    created_at: '2026-05-06T16:44:01Z',
    read_at: '2026-05-06T16:50:13Z', responded_at: '2026-05-06T17:02:47Z',
    payload: {
      company_name: 'Vishay Intertechnology', email: 'partnerships@vishay.com',
      keyword: 'low-noise op-amps',
      message: 'Interested in keyword sponsorship for our LNA-series. 12-month commit OK.',
    },
  },
  {
    id: 'cc8847...', type: 'contact', status: 'archived', spam_score: 0.94,
    created_at: '2026-05-06T03:21:09Z',
    payload: {
      name: 'asdfasdf', email: 'qwerty1234@throwaway.email', reason: 'other',
      subject: 'aaaaaaa', message: 'click here for free crypto crypto crypto',
    },
  },
  // ...10–15 more for variety: aged contact, urgent join with platinum tier,
  // multi-keyword inquiry, contact replied-to-then-archived, etc.
];
```

---

## Open design questions — answer through the design

1. Single-column or two-column detail layout?
2. Inline reply (anchored bottom) or modal-based?
3. Filter chips horizontal at top or sidebar-style left rail?
4. Sticky cluster headers for time grouping or just per-row timestamps?
5. Bulk-select toolbar slides in, or replaces the page header?
6. Per-row checkbox always-on or hover-revealed?
7. Assigned-to: chip in row or detail-only?

Pick what fits the velocity of the tool. We trust you here.

---

## Output expected

Components for the new section, in the same idiom as your prior bundle:
`MessagesListPage`, `MessageDetailPage`, `MessageRow`, `MessageTypeChip`, `MessageStatusBadge`, `MessageReplyPanel`, `BellDropdown`, `MessagePreviewRow`, `InboxZeroEmptyState`, `KeyboardHintFooter`, `SpamScoreWarning`.

Optional: a Storybook-ish demo page rendering all states (new / read / archived / responded / spam) so we can pick which to wire up first.

We'll handle backend, routing, and data plumbing on this end.

---

## Success criteria

When the design ships and we wire it up, John should open `/admin/messages` first thing in the morning, see what's new since last night at a glance, triage 10 messages in under a minute, and reply to one without losing context — all without leaving the keyboard.

If it accomplishes that *and* it reads as unmistakably part of circuits.com (designators, datasheet card, type-by-color), it's done.
