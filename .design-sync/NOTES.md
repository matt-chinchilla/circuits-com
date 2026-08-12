# design-sync notes — circuits-com

## Shape (why this repo is `manual`)

`circuits-com` is a private Vite **application**, not a bundlable component
library: `frontend/package.json` is `private: true` with no `main`/`module`/
`exports`, there is no Storybook and no `*.stories.*`, and components are
coupled to react-router, `useAuth`, and `adminApi`. The converter
(`package-build.mjs`) has no library entry point to compile, so the skill's
package and storybook shapes both fail on arrival. Verified again 2026-08-11.

The Claude Design project (`Circuits.com Design System`) is likewise
**hand-authored** — `ui_kits/` prototypes + `preview/*.html` cards — not the
converter's `components/<group>/<Name>/` layout, and it carries no
`_ds_sync.json` anchor. Syncs are therefore authored in place, additively,
following the project's own conventions.

## Kit conventions (ui_kits/website)

- Plain JSX loaded by `@babel/standalone` from `index.html` script tags —
  **a new component must be added there or it never mounts**.
- No imports. `React` is global; hooks are destructured with per-file aliases
  (`const { useState: useStateAdv } = React`) because every file shares one
  scope. Each file ends `window.<Name> = <Name>;`.
- Pages take `onNavigate(page, arg)`. Registering a page means editing
  `App.jsx` in four places: `VALID_PAGES`, `bandPages`, the
  `PageHeaderBand` title/subtitle ternaries, and the route render list.
- Data comes from `window.CIRCUITS_DATA`; styling from the kit's own class
  vocabulary (`glow-btn`, `mono`, `link`, `join-*`, `ph-light ph-<icon>`).

## Uploaded 2026-08-11

`Advertise.jsx` (new, the /pricing page), `advertise.css` (new),
`Navbar.jsx` + `App.jsx` + `index.html` (wiring + the nav change that dropped
"Home"), and `ADVERTISE_MERGE_BRIEF.md` — the brief for merging Advertise
into Join, including the live contradictions it must resolve.

## Known-stale in the project (deliberately NOT rewritten)

Flagged in the brief rather than silently fixed, because each is a business
decision, not a sync decision:

- `Join.jsx` still offers Silver $0 / Gold $249 / Platinum $849 listing tiers.
  Those prices exist nowhere in the business; sponsorship is $100/$600/$2,400.
- The kit brands as "Circuits.com"; the company is now **Circuit Center**.
- `Sponsor.jsx` prices a Silver *keyword* at $200 while a Silver *board* slot
  is $100 — possibly different products, open question for the owner.
- Copy says "month to month — cancel anytime"; a **12-month minimum term**
  has been decided but is not built yet.
- `SilverPartners.jsx` predates the purchase affordance (slots now read
  "$100/mo · Sponsor this slot →" plus a Q1-Q3 partners-desk strip), and the
  kit has no `SilverCheckoutModal` equivalent.
