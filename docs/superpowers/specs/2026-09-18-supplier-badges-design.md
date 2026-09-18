# Supplier Badges — design (2026-09-18)

Owner asks, 2026-09-17/18, in his words: "add the flame-adjustment-page to the badge to all
user accounts … the idea of a 'badge' is going to be a continual thing that gets applied to
customers regularly"; the editor "has sliders for the intensity of the flame, the
transparency of it, the ability to turn on sparks, and we need something to choose the
color"; it "should exist on the individual company pages (i.e.
/admin/suppliers/<id>), be edit-able AND able to be turned-on by admins, and able to be
customized by the users who represent customers when they log on"; "the window for the
badge-selection and the badge-editing should appear as a full screenview window that is
ABOVE the `listed parts` window"; "we do not need the size ladder. The [Platinum, Gold,
Silver] views can remain, they just need to be horizontally-stacked … the viewport should not
be as tall as the editor"; "the companies that join us will all be receiving the badges
anyways. Once the 'founder' period is over, they can have a new badge if they would like
(`badges` can be a table that gets added to suppliers & links to the table you are talking
about)"; "'Founder Badge' is going to have another option … the one you see here can be
`founder_badge_1` and the alternate-appearance … can be `founder_badge_2`".

Decisions taken in brainstorming: a badges table now (not settings on the flag, not JSON);
customers change the LOOK only, admins grant; panel above Listed Parts + a full-viewport
editor overlay shared by both consoles.

## 1. Data model (migration 055)

Two tables. `badges` is the catalogue of what a badge can be; `supplier_badges` is who
holds which one and how it looks.

```
badges
  id            UUID PK
  key           VARCHAR(40) UNIQUE NOT NULL     -- 'founder_badge_1', 'founder_badge_2'
  family        VARCHAR(40) NOT NULL            -- 'founder' (one family = one slot per supplier)
  label         VARCHAR(80) NOT NULL            -- "Founding distributor"
  available     BOOLEAN NOT NULL DEFAULT true   -- false = listed as "coming soon", not selectable
  sort_order    INTEGER NOT NULL DEFAULT 0
  created_at    TIMESTAMPTZ NOT NULL

supplier_badges
  id            UUID PK
  supplier_id   UUID NOT NULL FK suppliers ON DELETE CASCADE
  badge_id      UUID NOT NULL FK badges ON DELETE RESTRICT
  family        VARCHAR(40) NOT NULL            -- denormalised from badges.family for the UNIQUE below
  enabled       BOOLEAN NOT NULL DEFAULT true   -- admins only
  scheme        VARCHAR(12) NOT NULL DEFAULT 'orange'
  intensity     NUMERIC(3,2) NOT NULL DEFAULT 1.00
  opacity       NUMERIC(3,2) NOT NULL DEFAULT 0.75
  sparks        BOOLEAN NOT NULL DEFAULT true
  granted_by    UUID NULL FK users ON DELETE SET NULL
  granted_at    TIMESTAMPTZ NOT NULL
  updated_at    TIMESTAMPTZ NOT NULL
  UNIQUE (supplier_id, family)                  -- one founder badge per supplier; choosing
                                                -- founder_badge_2 UPDATES badge_id, never adds a row
  CHECK scheme IN ('red','orange','yellow','green','blue','indigo','violet','white','black')
  CHECK intensity BETWEEN 0.3 AND 2  CHECK opacity BETWEEN 0.2 AND 1
```
Postgres enforces the CHECKs; SQLite tests assert them via metadata + the Pydantic
validators (the Sponsor XOR pattern). Seed (idempotent, keyed on `key`) inserts the two
founder badges: `founder_badge_1` available, `founder_badge_2` `available=false` until its
design lands (it renders as badge 1 in the meantime — the widget maps an unknown/unavailable
appearance to badge 1).

Backfill in 055: one `supplier_badges` row (`founder_badge_1`, defaults) for every supplier
with `founder = true`, then DROP `suppliers.founder`. `founder` survives as a DERIVED field on
every payload that carries it today (`supplier_to_dict`, the Silver directory,
`_sponsor_board_dict`): `founder = any enabled supplier_badges row in family 'founder'`. Those
payloads also gain `badge: {key, scheme, intensity, opacity, sparks} | null` (the enabled
founder-family row, or null). The admin supplier list/form/detail lose the founder checkbox
(the panel replaces it). Transfer scripts: `founder` leaves `SUPPLIER_SKIP`/the export tuple
(the column is gone); neither new table is exported — they are per-environment state.
`--reseed` truncates `supplier_badges` (owner's call whether to add a carry step later; the
`badges` catalogue reseeds).

## 2. API

Staff, under `/api/suppliers/{id}/badges` (the existing `require_staff` wall: viewers read,
403 on writes):
- `GET`            → `[{id, key, family, label, enabled, scheme, intensity, opacity, sparks, granted_at}]`
- `POST {key}`     → grant (409 if the family is already held; 422 if the badge is unavailable)
- `PATCH /{family} {key?, enabled?, scheme?, intensity?, opacity?, sparks?}`
- `DELETE /{family}` → revoke
- `GET /api/badges` → the catalogue (staff), for the grant menu.

Customer, under `/api/account/badges` (`require_account_user`, the activated-customer gate;
scoped to `user.supplier_id`, 404 when the account has no supplier):
- `GET`                → the account's rows, same shape.
- `PATCH /{family} {key?, scheme?, intensity?, opacity?, sparks?}` — `extra="forbid"`, so
  `enabled` from a customer is a 422, not silently ignored; `key` must be an AVAILABLE badge
  of the same family.
Every write calls `invalidate_catalog_caches()` AND `category_cache.clear()` (boards are
served from the process cache; a writer that forgets stays stale for up to an hour), and
`data_versions` gains a `badges` scope mapped to `supplier_badges` so the admin cache probe
sees the change.

## 3. Frontend

- The fire-badge element (`fire-badge.vendor.js` + `.d.ts` + `PROVENANCE.md`) and its host
  move from `@public/components/widgets/` to `@shared/components/FounderBadge/` — the public
  boards and the admin/customer editor are the two consumers (≥2-consumer rule; admin cannot
  import public). The host takes `{key, scheme, intensity, opacity, sparks, size}` and sets
  the element's attributes; absent props keep the element's own defaults.
- Boards (`CategorySponsor`, `SponsorBlock`, `SilverPartners`) render `<FounderBadge
  {...s.badge}>` when `s.badge` is non-null (they stop reading `founder`).
- `@admin/components/BadgesPanel` — above Listed Parts on `pages/suppliers/detail` and on the
  customer's own-company page (`pages/suppliers/mine`). Shows each held badge: live flame at
  32px, label, "Edit"; admins also get "Grant…" (menu from `/api/badges`), an Enabled toggle
  and "Revoke". A supplier with no badge shows "Grant…" (admins) or a one-line "Your badge
  will appear here" (customers) — every joining company receives one, per the owner, so this
  is transitional, not a designed empty state.
- `@admin/components/BadgeEditorOverlay` — one component, both consoles. Full viewport,
  `role="dialog"`, Esc/scrim close, focus trapped. Top bar: appearance selector (badge 1 /
  badge 2, unavailable ones shown "coming soon"), scheme `<select>`, intensity slider
  0.3–2 step 0.1, opacity slider 0.2–1 step 0.05, sparks switch, Save / Cancel. Body: the
  nine scheme swatches at 64px (click = select), then Platinum / Gold / Silver previews SIDE
  BY SIDE (the design page's swatches, dark Silver and light Silver), no size ladder, sized to
  fit a 1080p laptop viewport without scrolling. Edits are local until Save (one PATCH).
  Admin-only rows (Enabled, Revoke) render inside the overlay too. Reads go through
  `useCachedQuery` with the `badges` scope; the axios non-GET rule already drops the cache.
- Types: `@admin/types/admin.ts` `SupplierBadge`, `BadgeDef`; `@public/types/sponsor.ts`
  `badge?: BadgeLook | null` on `PlatinumSponsor` and `PartnerSupplier`; `founder?: boolean`
  stays on the public types as the derived flag.

## 4. Tests and proof

API: migration 055 up/down on local Postgres with the backfill row for Chirichella Inc.
checked; CHECK ranges rejected 422 on both engines; the staff wall (viewer GET 200, PATCH
403); customer cannot grant, cannot set `enabled` (422), cannot touch another supplier's
family (404), cannot pick an unavailable badge (422); derived `founder` and `badge` present
on `/api/suppliers/`, the category detail's `silver`, and `/partners`; cache invalidation
called on every write. Frontend: witnesses for the panel (both consoles), the overlay
controls' ranges, the three render sites reading `badge`, and the shared-widget move (no
`@public` import from `@admin`). Proof: screenshots of the panel and the overlay on local for
an admin and for a customer account, and the boards with a non-default scheme.

## 5. Out of scope

`founder_badge_2`'s artwork; automation of the $5,000/month sunset; badges on the keyword
profile hero (open question from the badge round); a reseed carry step.
