import type { Flow } from './types';
import { getStore, getRoute } from './helpers';
import { getTrackedDemoEntity, getTrackedDemoListing } from './demoCleanup';
import {
  DEMO_PART_SKU_PREFIX,
  DEMO_SUPPLIER_NAME,
  isDemoPartSku,
  isDemoSupplierName,
} from './demoMarkers';

function supplierNameFromPage(): string {
  return document.querySelector('h1')?.textContent?.trim() || DEMO_SUPPLIER.name;
}

// First CLICKABLE row of the parts table. The loading + "no parts found"
// placeholders are also `tbody tr`, but carry a single colSpan cell and no
// onClick — spotlighting one of those would point the user at a dead row
// while the fetch is still in flight. Cell count is the class-name-agnostic
// discriminator (CSS-module names are hashed).
function firstPartsTableRow(): Element | null {
  const rows = Array.from(document.querySelectorAll('tbody tr'));
  return rows.find((r) => r.querySelectorAll('td').length > 2) ?? null;
}

// ⚠ DATA SAFETY. Part detail renders one [data-tour="delete-listing"] Remove
// button PER distributor row, and this step tells the user to click the
// highlighted one — so a wrong match instructs them to delete REAL catalog
// data (the click-blockers make the highlighted row the ONLY clickable one).
// The exact demo listing id is already known from the tracker, so match on
// it and NOTHING else: no price-string heuristic, no last-row fallback over
// an unordered listings array. No tracked id / not on the page ⇒ null, which
// drops the spotlight and leaves the coach's Next as the way forward.
//
// Ids are UUIDs; anything else can't be safely interpolated into a selector, so
// every id-keyed lookup below refuses rather than risk matching the wrong node.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function demoListingSelector(listingId: string): string | null {
  if (!SAFE_ID.test(listingId)) return null;
  return `[data-tour="delete-listing"][data-listing-id="${listingId}"]`;
}

function demoListingDeleteButton(): Element | null {
  const ref = getTrackedDemoListing();
  if (!ref) return null;
  const sel = demoListingSelector(ref.listingId);
  if (!sel) return null;
  const btn = document.querySelector(sel);
  // Defense in depth: the tracked id already comes from the per-submission
  // create bridge, but ALSO require the rendered row to bear the DEMO- SKU
  // marker — so even a mis-pointed id can never spotlight a real listing.
  if (btn && !isDemoPartSku(btn.getAttribute('data-listing-sku') ?? '')) return null;
  return btn;
}

// ⚠ DATA SAFETY. The confirm modal on part-detail serves BOTH "delete part"
// and "remove listing", so a bare [data-modal="confirm-delete"] match proves
// only that some dialog is open — not that it targets the demo row. Part
// detail stamps the pending target (data-modal-kind / data-modal-listing-id),
// so key on the TRACKED listing id: a dialog raised from a real distributor
// row, or from Delete part, resolves to null and the tour will not tell the
// user to confirm it.
function demoListingConfirmModal(): Element | null {
  const ref = getTrackedDemoListing();
  if (!ref) return null;
  if (!SAFE_ID.test(ref.listingId)) return null;
  const modal = document.querySelector(
    `[data-modal="confirm-delete"][data-modal-kind="listing"][data-modal-listing-id="${ref.listingId}"]`,
  );
  // Defense in depth (mirror of demoListingDeleteButton): the open dialog must
  // also carry the DEMO- SKU marker before the tour tells the user to confirm.
  if (modal && !isDemoPartSku(modal.getAttribute('data-modal-listing-sku') ?? '')) return null;
  return modal;
}

function demoListingConfirmButton(): Element | null {
  return demoListingConfirmModal()?.querySelector('[data-modal-confirm="true"]') ?? null;
}

// Proof-of-deletion for the detach step. Advancing on modal ABSENCE fired on
// Cancel and backdrop clicks too, so the "listing removed" annotation could
// appear while the demo row was still sitting on a real part. The tracked
// row being GONE from a rendered part-detail page is the only honest signal.
function demoListingIsGone(): boolean {
  const ref = getTrackedDemoListing();
  if (!ref) return false;
  // Absence proves nothing unless we're looking at THE part the demo listing
  // hangs off. Every OTHER part-detail page also lacks the row, so a generic
  // "some part detail is rendered" check reported success from any part in the
  // catalog and walked the tour past the detach step with the demo listing
  // still attached.
  if (getRoute() !== `parts/${ref.partId}`) return false;
  if (document.querySelector('[data-tour="add-listing"]') == null) return false;
  const sel = demoListingSelector(ref.listingId);
  if (!sel) return false;
  return document.querySelector(sel) == null;
}

// The entity label the DETAIL page renders — the marker half of the identity
// proof below. Both supplier-detail and part-detail put it in an <h1> inside the
// same page-head block that holds the Delete button, so the lookup walks UP from
// the button rather than querying the document: AdminLayout's topbar renders its
// own <h1> (the static route title) and that one comes FIRST in DOM order, so a
// bare document.querySelector('h1') reads "Parts", not the SKU. Three levels is
// button → actions → pageHead → page, which cannot reach the topbar's separate
// subtree.
function renderedEntityLabel(deleteBtn: Element): string | null {
  let node: Element | null = deleteBtn.parentElement;
  for (let up = 0; up < 3 && node != null; up += 1) {
    const h1 = node.querySelector('h1');
    if (h1 != null) return h1.textContent?.trim() ?? '';
    node = node.parentElement;
  }
  return null;
}

// ⚠ DATA SAFETY. The same rule the detach step above follows, applied to the
// three tours that delete a whole ENTITY. Those steps used a bare
// [data-tour="delete-supplier"] / [data-tour="delete-part"] selector, which
// resolves on ANY supplier/part detail page — so a tour whose create went
// untracked (or that the user navigated elsewhere during) would spotlight the
// Delete button of whatever REAL row was on screen and instruct them to remove
// it, with the click-blockers making it the only clickable control.
//
// Identity proof: a detail route IS the entity's id, so the tracked demo id
// must equal the id in the URL. Anything else — no tracked id, a different
// entity's page, a list page — resolves to null: no spotlight, no
// click-blockers, and the coach's Next is the way forward.
function demoEntityDeleteButton(
  kind: 'supplier' | 'part',
  collection: 'suppliers' | 'parts',
  tour: 'delete-supplier' | 'delete-part',
): Element | null {
  const id = getTrackedDemoEntity(kind);
  if (!id || !SAFE_ID.test(id)) return null;
  if (getRoute() !== `${collection}/${id}`) return null;
  const btn = document.querySelector(`[data-tour="${tour}"]`);
  if (btn == null) return null;
  // Where the page stamps its entity id on the control (part detail does), it
  // must MATCH — a belt to the route's braces.
  const stamped = btn.getAttribute('data-entity-id');
  if (stamped != null && stamped !== id) return null;
  // ⚠ MARKER PROOF, and the reason the id checks above aren't enough. Every
  // check so far only proves "the page we're on is the id we RECORDED" — it
  // says nothing about whether that id was recorded correctly. If it ever
  // pointed at a real row (a stale localStorage key, a hand-edited value, a
  // UUID reassigned by a reseed) the tour would spotlight a customer's Delete
  // button and, with the click-blockers making it the only clickable control,
  // instruct them to press it. So require the SAME marker cleanup requires —
  // the rendered name/SKU — using the SAME predicates (demoMarkers.ts), which
  // is what keeps "the tour offers to delete it" and "cleanup will delete it"
  // from ever disagreeing. Unreadable label ⇒ null, the fail-closed direction.
  const label = renderedEntityLabel(btn);
  const bearsMarker = kind === 'supplier' ? isDemoSupplierName(label) : isDemoPartSku(label);
  if (!bearsMarker) return null;
  return btn;
}

function demoSupplierDeleteButton(): Element | null {
  return demoEntityDeleteButton('supplier', 'suppliers', 'delete-supplier');
}

function demoPartDeleteButton(): Element | null {
  return demoEntityDeleteButton('part', 'parts', 'delete-part');
}

// The confirm half of the same pair: the open dialog is the tour's own only
// when the delete control it was raised from still resolves to the tracked demo
// entity — which now includes that control's rendered marker, since this
// delegates to demoEntityDeleteButton rather than re-deriving the checks. On
// part detail ONE modal serves both "delete part" and "remove listing", so the
// kind stamp has to say `part` as well.
function demoEntityConfirmButton(
  resolveDeleteButton: () => Element | null,
  modalKind: 'part' | null,
): Element | null {
  if (resolveDeleteButton() == null) return null;
  const modal = document.querySelector('[data-modal="confirm-delete"]');
  if (modal == null) return null;
  if (modalKind != null && modal.getAttribute('data-modal-kind') !== modalKind) return null;
  return modal.querySelector('[data-modal-confirm="true"]');
}

function demoSupplierConfirmButton(): Element | null {
  return demoEntityConfirmButton(demoSupplierDeleteButton, null);
}

function demoPartConfirmButton(): Element | null {
  return demoEntityConfirmButton(demoPartDeleteButton, 'part');
}

// Where a tour's delete step should stand: the tracked demo entity's own detail
// page. Falls back to the current detail route (then the list) when nothing is
// tracked — the spotlight resolves to null there, so the fallback can only ever
// show the user a page, never a delete instruction.
function trackedDemoEntityRoute(
  kind: 'supplier' | 'part',
  collection: 'suppliers' | 'parts',
): string {
  const id = getTrackedDemoEntity(kind);
  if (id && SAFE_ID.test(id)) return `${collection}/${id}`;
  const r = getRoute();
  if (new RegExp(`^${collection}/[^/]+$`).test(r) && r !== `${collection}/new`) return r;
  return collection;
}

// Demo data — short, recognizably fake, easy for the user to spot and
// delete at the end of each tour. The name/SKU markers live in demoMarkers.ts:
// cleanup re-reads the row and refuses to delete anything that doesn't still
// carry them, so a tour's demo data MUST be built from those constants.
export const DEMO_SUPPLIER = {
  name: DEMO_SUPPLIER_NAME,
  description: 'Demo distributor created during the guided tour — safe to delete.',
  contactPerson: 'Jane Doe',
  website: 'demo-components.com',
  phone: '555-100-2000',
  email: 'sales@demo-components.com',
} as const;

export const DEMO_PART = {
  sku: `${DEMO_PART_SKU_PREFIX}100`,
  manufacturer: 'Demo Components Inc.',
  description: 'Tutorial 10uF X7R Capacitor — safe to delete.',
  category: 'pmic',
  price: '1.25',
  stock: '5',
} as const;

// The attach tour's distributor order code (PartListing.sku).
//
// ⚠ DATA SAFETY, not cosmetics. This is the ONLY marker a demo listing carries:
// the row hangs off a REAL catalog part, so cleanup can't identify it by its
// parent, and the tracked id is only ever as good as the bridge that published
// it. demoCleanup re-reads the listing off its part and refuses to detach
// anything whose `sku` doesn't still start with DEMO- — so an unmarked listing
// survives the tour, and a real distributor row can never be removed. The tour
// autofills this value (and its advance won't pass without a DEMO- one).
//
// The 4-char suffix is cosmetic — it keeps consecutive runs distinguishable in
// the listings panel. Only the PREFIX is read by anything. Well inside the
// backend's Field(max_length=100) / the form's maxLength={100}.
export const DEMO_LISTING_SKU = `${DEMO_PART_SKU_PREFIX}LST-${Date.now()
  .toString(36)
  .slice(-4)
  .toUpperCase()}`;

export const SAMPLE_CSV_TEXT = `sku,description,manufacturer,category,stock,price_usd
DEMO-CAP-100,Tutorial 10uF X7R Capacitor,Demo Components Inc.,pmic,5000,1.25
DEMO-MCU-200,Tutorial ARM Cortex-M0 MCU,Demo Components Inc.,mcu,3200,2.85
DEMO-RES-300,Tutorial 10k 1% Resistor,Demo Components Inc.,analog,80000,0.05
`;

// The category we feature the demo supplier into for the "see it live" step.
// Microcontrollers-processors is a high-traffic category that always has a
// featured slot to fill.
export const PREVIEW_CATEGORY_SLUG = 'microcontrollers-processors';

export const FLOWS: Flow[] = [
  // ──────────────────────────────────────────────────────────────────────
  // Add a Supplier — the canonical 14-step flow. Demonstrates the whole
  // create → propagate → cleanup loop.
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'add-supplier',
    title: 'Add a Supplier',
    summary: 'Create a distributor, watch it appear on the live site, then clean up.',
    icon: 'buildings',
    accent: 'primary',
    minutes: 3,
    steps: [
      {
        goto: '',
        selector: '[data-tour="side-suppliers"]',
        title: 'Open Suppliers',
        body: (
          <>
            Find the <b>Suppliers</b> link in the sidebar, under <i>Catalog</i>. Click it to open
            the directory of distributors.
          </>
        ),
        advance: { kind: 'route', test: (r) => r === 'suppliers' || /^suppliers\/[^/]+$/.test(r) },
      },
      {
        selector: '[data-tour="add-supplier"]',
        title: 'Add a new supplier',
        body: (
          <>
            Click <b>Add Supplier</b> in the top-right. This opens the New-Supplier form.
          </>
        ),
        advance: { kind: 'route', test: (r) => r === 'suppliers/new' },
      },
      {
        fieldName: 'name',
        title: 'Type the company name',
        body: (
          <>
            Enter the distributor&apos;s company name. For this walkthrough we suggest{' '}
            <code>Demo Components Inc.</code> — it&apos;s clearly a tutorial entry.
          </>
        ),
        suggested: DEMO_SUPPLIER.name,
        advance: { kind: 'value', fieldName: 'name', test: (v) => v.trim().length >= 3 },
      },
      {
        fieldName: 'description',
        title: 'Add a one-line description',
        body: (
          <>
            The description shows up underneath the company name on each supplier card. Keep it
            short — one sentence is plenty.
          </>
        ),
        suggested: DEMO_SUPPLIER.description,
        advance: { kind: 'value', fieldName: 'description', test: (v) => v.trim().length >= 12 },
      },
      {
        fieldName: 'website',
        title: 'Their website',
        body: (
          <>
            Drop in the supplier&apos;s home URL — no <code>https://</code> needed, just the bare
            domain.
          </>
        ),
        suggested: DEMO_SUPPLIER.website,
        advance: {
          kind: 'value',
          fieldName: 'website',
          test: (v) => v.includes('.') && v.length >= 5,
        },
      },
      {
        fieldName: 'phone',
        title: 'A phone number',
        body: <>Sales line is fine — format doesn&apos;t matter, the field is free-form.</>,
        suggested: DEMO_SUPPLIER.phone,
        advance: {
          kind: 'value',
          fieldName: 'phone',
          test: (v) => v.replace(/\D/g, '').length >= 7,
        },
      },
      {
        fieldName: 'email',
        title: 'A sales email',
        body: <>Where buyers should reach the supplier directly.</>,
        suggested: DEMO_SUPPLIER.email,
        advance: { kind: 'value', fieldName: 'email', test: (v) => /\S+@\S+\.\S+/.test(v) } },
      {
        fieldName: 'contact_name',
        title: 'Primary contact?',
        body: (
          <>
            This is the supplier-side person you&apos;d email when there&apos;s a price-sync
            question or sponsorship decision to make.
          </>
        ),
        suggested: DEMO_SUPPLIER.contactPerson,
        advance: { kind: 'value', fieldName: 'contact_name', test: (v) => v.trim().length >= 2 },
      },
      {
        selector: '[data-tour="submit-supplier"]',
        title: 'Save the supplier',
        body: (
          <>
            Hit <b>Create supplier</b>. The form persists to the catalog and you&apos;ll land on
            the new supplier&apos;s detail page.
          </>
        ),
        advance: {
          kind: 'route',
          test: (r) => /^suppliers\/[^/]+$/.test(r) && r !== 'suppliers/new',
        },
      },
      {
        type: 'annotation',
        title: 'Meet your new supplier',
        body: () => (
          <>
            Here&apos;s the detail page for <b>{supplierNameFromPage()}</b>. The colored cards at
            the top are <i>Quick Actions</i> — they pre-fill the Add-Part, Import-CSV, and
            Sponsorship forms with this supplier&apos;s context. Below, you&apos;d see all the parts
            in their catalog.
          </>
        ),
        hint: "No parts listed yet — that's what the next tour covers.",
        advance: { kind: 'manual' },
      },
      {
        type: 'preview',
        preview: { page: 'category', arg: PREVIEW_CATEGORY_SLUG },
        title: 'See it on the live site',
        body: () => (
          <>
            This is the public-facing Circuit Center — note how <b>{supplierNameFromPage()}</b> now
            appears as the <i>Featured Supplier</i> in the category page sidebar. Adding through
            the admin propagates to the directory immediately.
          </>
        ),
        advance: { kind: 'manual' },
      },
      {
        // Back to the demo supplier so the delete button is on-screen — by
        // TRACKED id when we have one (the preview modal may have left us
        // anywhere), otherwise the detail page we're already on.
        goto: () => trackedDemoEntityRoute('supplier', 'suppliers'),
        selector: demoSupplierDeleteButton,
        title: "Now let's clean up",
        // Nothing highlighted ⇒ the tour can't prove this page is its own demo
        // supplier, so the copy must NOT tell the user to delete it.
        body: () =>
          demoSupplierDeleteButton() != null ? (
            <>
              <b>{supplierNameFromPage()}</b> was just for the tutorial. Click <b>Delete</b> in the
              header — you&apos;ll get a confirmation dialog.
            </>
          ) : (
            <>
              Nothing is highlighted: the tour couldn&apos;t identify the supplier it created.{' '}
              <b>Don&apos;t delete the supplier on screen</b> — it may be real catalog data. Click{' '}
              <b>Next</b> to move on; the tour still removes its own demo row when it ends.
            </>
          ),
        advance: { kind: 'modal' },
      },
      {
        // Identity-keyed like the step above: resolved only inside a dialog
        // raised from the tracked demo supplier's own Delete button.
        selector: demoSupplierConfirmButton,
        title: 'Confirm the delete',
        body: () =>
          demoSupplierConfirmButton() != null ? (
            <>
              Click <b>Confirm</b> to remove <b>{supplierNameFromPage()}</b>. The supplier is gone
              from the directory, and from the public site, in the same beat.
            </>
          ) : (
            <>
              Nothing is highlighted: this dialog isn&apos;t the one the tour opened for its own
              demo supplier. <b>Cancel it</b> rather than confirming — then click <b>Next</b>.
            </>
          ),
        advance: { kind: 'route', test: (r) => r === 'suppliers' },
      },
      {
        type: 'annotation',
        title: "That's the full loop",
        body: (
          <>
            Create → land on detail → propagate to the live site → delete. Every flow in the admin
            follows this shape. The other tours show off the variations.
          </>
        ),
        advance: { kind: 'manual' },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Add a Part to a Supplier — uses the Quick Actions strip on the
  // supplier-detail page to pre-fill the part form.
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'add-part-to-supplier',
    title: 'Add a Part to a Supplier',
    summary: "Use a supplier's Quick Actions to add a SKU with pre-filled context.",
    icon: 'package',
    accent: 'blue',
    minutes: 3,
    steps: [
      {
        goto: 'suppliers',
        selector: '[data-tour="supplier-card"]',
        title: 'Pick any supplier',
        body: <>Click any supplier card to open their detail page.</>,
        advance: {
          kind: 'route',
          test: (r) => /^suppliers\/[^/]+$/.test(r) && r !== 'suppliers/new',
        },
      },
      {
        selector: '[data-tour="qa-add-part"]',
        title: 'Use the Quick Action',
        body: (
          <>
            The dark <b>Add a part</b> card is the supplier-context shortcut — clicking it
            pre-fills the manufacturer, supplier, and category on the new-part form.
          </>
        ),
        advance: { kind: 'route', test: (r) => r === 'parts/new' },
      },
      {
        fieldName: 'sku',
        title: 'Enter the part SKU',
        body: (
          <>
            This is the manufacturer&apos;s part number. We&apos;ll use <code>DEMO-100</code> for
            the tutorial.
          </>
        ),
        suggested: DEMO_PART.sku,
        advance: { kind: 'value', fieldName: 'sku', test: (v) => v.trim().length >= 3 },
      },
      {
        fieldName: 'manufacturer_name',
        title: 'Manufacturer',
        body: (
          <>
            This may already be filled from the Quick Action — that&apos;s the pre-fill bus at
            work. If empty, type a manufacturer name.
          </>
        ),
        suggested: DEMO_PART.manufacturer,
        advance: { kind: 'value', fieldName: 'manufacturer_name', test: (v) => v.trim().length >= 2 },
      },
      {
        fieldName: 'description',
        title: 'Spec-string description',
        body: (
          <>
            This is what shows up in the parts table. Write it the way an engineer reads a BOM
            line — the leading specs first.
          </>
        ),
        suggested: DEMO_PART.description,
        advance: { kind: 'value', fieldName: 'description', test: (v) => v.trim().length >= 10 },
      },
      {
        fieldName: 'category_id',
        title: 'Pick a category',
        body: (
          <>
            Categories drive the public-site taxonomy. Pick whichever one fits — for the demo,
            anything works.
          </>
        ),
        suggested: '__auto_select__',
        suggestedLabel: 'First available category',
        advance: { kind: 'value', fieldName: 'category_id', test: (v) => !!v && v.length > 1 },
      },
      {
        fieldName: 'lifecycle_status',
        title: 'Lifecycle status',
        body: (
          <>
            Where the part sits in its production lifecycle. <i>Active</i> means in full production;{' '}
            <i>NRND</i> and <i>EOL</i> flag parts winding down.
          </>
        ),
        suggested: 'active',
        suggestedLabel: 'Active (in production)',
        advance: { kind: 'value', fieldName: 'lifecycle_status', test: (v) => !!v },
      },
      {
        fieldName: 'datasheet_url',
        title: 'Datasheet URL',
        body: (
          <>
            Link to the manufacturer&apos;s PDF datasheet — engineers click through from the part
            detail page.
          </>
        ),
        suggested: 'ti.com/lit/ds/symlink/lm358.pdf',
        advance: {
          kind: 'value',
          fieldName: 'datasheet_url',
          test: (v) => v.includes('.') && v.length >= 5,
        },
      },
      {
        fieldName: 'initial_stock_quantity',
        title: 'Stock quantity',
        body: (
          <>
            How many units this supplier has in stock right now. This feeds the public-site stock
            column and availability badges.
          </>
        ),
        suggested: DEMO_PART.stock,
        advance: {
          kind: 'value',
          fieldName: 'initial_stock_quantity',
          test: (v) => Number(v) > 0,
        },
      },
      {
        fieldName: 'initial_unit_price',
        title: 'Set a starting price',
        body: (
          <>
            The initial listing&apos;s unit price in USD. This is what the supplier charges per
            unit; it shows up in the public BOM comparison table.
          </>
        ),
        suggested: DEMO_PART.price,
        advance: {
          kind: 'value',
          fieldName: 'initial_unit_price',
          test: (v) => Number(v) > 0,
        },
      },
      {
        selector: '[data-tour="submit-part"]',
        title: 'Create the part',
        body: (
          <>
            Hit <b>Create part</b>. You&apos;ll land on the new part&apos;s detail page — the part
            and its initial listing are saved atomically.
          </>
        ),
        advance: {
          kind: 'route',
          test: (r) => /^parts\/[^/]+$/.test(r) && r !== 'parts/new',
        },
      },
      {
        type: 'annotation',
        title: 'Part is live',
        body: (
          <>
            The part now shows in the supplier&apos;s <i>Listed Parts</i> table. The
            supplier&apos;s part-count badge in the sidebar will bump up too — those counts are
            derived from the catalog, not hand-maintained.
          </>
        ),
        advance: { kind: 'manual' },
      },
      {
        goto: () => trackedDemoEntityRoute('part', 'parts'),
        selector: demoPartDeleteButton,
        title: 'Delete the demo SKU',
        body: () =>
          demoPartDeleteButton() != null ? (
            <>
              Click <b>Delete</b> and confirm to remove the tutorial part. Distributor listings
              linked to it are unlinked automatically.
            </>
          ) : (
            <>
              Nothing is highlighted: the tour couldn&apos;t identify the part it created.{' '}
              <b>Don&apos;t delete the part on screen</b> — it may be real catalog data. Click{' '}
              <b>Next</b> to move on; the tour still removes its own demo SKU when it ends.
            </>
          ),
        advance: { kind: 'modal' },
      },
      {
        selector: demoPartConfirmButton,
        title: 'Confirm',
        body: () =>
          demoPartConfirmButton() != null ? (
            <>Wipe the tutorial part.</>
          ) : (
            <>
              Nothing is highlighted: this dialog isn&apos;t the one the tour opened for its own
              demo SKU. <b>Cancel it</b> rather than confirming — then click <b>Next</b>.
            </>
          ),
        advance: { kind: 'route', test: (r) => r === 'parts' || /^suppliers\/[^/]+$/.test(r) },
      },
      {
        type: 'annotation',
        title: 'Cleaned up',
        body: <>Part removed. The supplier&apos;s parts-count is back where it was.</>,
        advance: { kind: 'manual' },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Import CSV — bulk-upload using the documented schema, with a sample
  // CSV ready to drop in.
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'import-csv',
    title: 'Import a CSV to a Supplier',
    summary: 'Bulk-upload parts using the documented CSV schema.',
    icon: 'upload-simple',
    accent: 'cyan',
    minutes: 3,
    steps: [
      {
        goto: 'suppliers',
        selector: '[data-tour="supplier-card"]',
        title: 'Open any supplier',
        body: (
          <>
            CSV imports are tagged to a supplier, so the flow starts from a supplier&apos;s detail
            page.
          </>
        ),
        advance: {
          kind: 'route',
          test: (r) => /^suppliers\/[^/]+$/.test(r) && r !== 'suppliers/new',
        },
      },
      {
        selector: '[data-tour="qa-import-csv"]',
        title: 'Click "Import CSV"',
        body: (
          <>
            The blue Quick Action sends you to the import wizard with the supplier already locked
            in.
          </>
        ),
        advance: { kind: 'route', test: (r) => r === 'import' },
      },
      {
        type: 'annotation',
        title: 'The required CSV format',
        body: (
          <>
            <p>UTF-8 CSV with this header — order matters:</p>
            <div className="wiz-csv-scroll">
              <table className="wiz-csv-grid">
                <thead>
                  <tr>
                    <th>sku</th>
                    <th>description</th>
                    <th>mfr</th>
                    <th>cat</th>
                    <th>stock</th>
                    <th>price</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>DEMO-CAP-100</td>
                    <td>10uF Cap</td>
                    <td>Demo</td>
                    <td>pmic</td>
                    <td>5000</td>
                    <td>1.25</td>
                  </tr>
                  <tr>
                    <td>DEMO-MCU-200</td>
                    <td>ARM M0</td>
                    <td>Demo</td>
                    <td>mcu</td>
                    <td>3200</td>
                    <td>2.85</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        ),
        hint: 'The "Required columns" disclosure on the upload page has the same schema.',
        advance: { kind: 'manual' },
      },
      {
        selector: '[data-tour="csv-dropzone"]',
        title: 'Drop your CSV here',
        body: (
          <>
            Either drag a file from your desktop or click the zone to browse. For the demo
            we&apos;ll attach a sample CSV with three fake rows — click <b>Use sample CSV</b>{' '}
            below.
          </>
        ),
        suggested: '__sample_csv__',
        suggestedLabel: 'demo-import.csv (3 rows)',
        advance: {
          kind: 'predicate',
          test: () =>
            document.querySelector('[data-tour="csv-dropzone"][data-file-staged="true"]') != null,
        },
      },
      {
        selector: '[data-tour="import-continue"]',
        title: 'Continue to mapping',
        body: (
          <>
            The supplier dropdown is already filled (you came from a supplier page) and the file
            is staged. Hit <b>Continue</b>.
          </>
        ),
        advance: {
          kind: 'predicate',
          test: () => document.querySelector('[data-tour="import-step-mapping"]') != null,
        },
      },
      {
        type: 'annotation',
        title: 'Column mapping',
        body: (
          <>
            The wizard auto-detected your headers and matched them to the schema. The <code>sku</code>{' '}
            and <code>manufacturer</code> columns are required — everything else is optional.
          </>
        ),
        advance: { kind: 'manual' },
      },
      {
        selector: '[data-tour="import-continue"]',
        title: 'Continue to review',
        body: <>Confirm the mapping and move to the final review step.</>,
        advance: {
          kind: 'predicate',
          test: () => document.querySelector('[data-tour="import-step-review"]') != null,
        },
      },
      {
        selector: '[data-tour="import-continue"]',
        title: 'Queue the import',
        body: (
          <>
            Click <b>Import parts</b>. The parts are inserted in a single transaction; you&apos;ll
            land on a results screen showing what was created vs skipped.
          </>
        ),
        advance: {
          kind: 'predicate',
          test: () => document.querySelector('[data-tour="import-step-done"]') != null,
        },
      },
      {
        selector: '[data-tour="import-done-summary"]',
        title: 'Import complete',
        body: (
          <>
            The parts are now in the catalog under the supplier you picked. In production a
            reviewer would gate this; in the demo it&apos;s immediate.
          </>
        ),
        advance: { kind: 'manual' },
      },
      {
        type: 'annotation',
        title: 'Cleaning up',
        // ⚠ DELIBERATE AND EXPLICIT: the batch import is the ONE tour with no
        // automatic cleanup, and that is the accepted trade-off — not an
        // oversight to be "fixed" later.
        //
        // Why: `batchImportParts` publishes no id bridge, so the 3 synthetic
        // rows are UNTRACKED. The single-id tracker can only own one row per
        // kind, and a 3-row array key would have to be kept in step with a
        // partial import (some rows created, some skipped by dedupe) — so the
        // copy states the manual path outright instead of implying the wizard
        // will tidy up. Both backstops hold regardless: all 3 SKUs carry the
        // DEMO- marker (SAMPLE_CSV_TEXT), and `--reseed` wipes them.
        //
        // ⚠ And NOTHING in this step can reach a non-DEMO part: it is an
        // `annotation` — no `selector`, no `fieldName`, no resolver, no delete.
        // It renders copy and waits for Next. Do not add a delete affordance
        // here; there is no tracked id to prove which rows are the tour's, so
        // any spotlight would have to guess at real catalog data.
        body: (
          <>
            This tour is the one that <b>doesn&apos;t</b> clean up after itself — all 3 demo SKUs
            stay in the catalog. They all start with <code>DEMO-</code>: delete them individually
            from the Parts page, or leave them and they&apos;ll be wiped by the next{' '}
            <code>./deploy.sh --reseed</code>.
          </>
        ),
        advance: { kind: 'manual' },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Add a Sponsorship — paid placement via category banner or keyword.
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'add-sponsorship',
    title: 'Add a Sponsorship',
    summary: 'Configure a paid placement: category banner or keyword takeover.',
    icon: 'star',
    accent: 'gold',
    minutes: 2,
    steps: [
      {
        goto: 'suppliers',
        selector: '[data-tour="supplier-card"]',
        title: 'Open a supplier',
        body: <>Sponsorships are always tied to a supplier. Pick one to start.</>,
        advance: {
          kind: 'route',
          test: (r) => /^suppliers\/[^/]+$/.test(r) && r !== 'suppliers/new',
        },
      },
      {
        selector: '[data-tour="qa-add-sponsorship"]',
        title: 'Click "Add sponsorship"',
        body: (
          <>
            The gold Quick Action opens the sponsor form with the supplier and a sensible default
            tier pre-filled.
          </>
        ),
        advance: { kind: 'route', test: (r) => r === 'sponsors/new' },
      },
      {
        fieldName: 'tier',
        title: 'Pick a tier',
        body: (
          <>
            Tiers control price + placement. <i>Platinum</i> = most prominent, <i>Silver</i> =
            budget. Default&apos;s fine for the demo.
          </>
        ),
        advance: { kind: 'value', fieldName: 'tier', test: (v) => !!v },
      },
      {
        fieldName: 'amount',
        title: 'Set the monthly amount',
        body: (
          <>
            The agreed monthly fee in USD. Stripe will be the system-of-truth in production; here
            it&apos;s just a stored number.
          </>
        ),
        suggested: '1500',
        advance: { kind: 'value', fieldName: 'amount', test: (v) => Number(v) > 0 },
      },
      {
        selector: '[data-tour="submit-sponsor"]',
        title: 'Create the sponsorship',
        body: (
          <>
            Hit <b>Create sponsorship</b>. The placement goes active immediately based on the
            start date.
          </>
        ),
        advance: {
          kind: 'route',
          test: (r) => r === 'sponsors' || /^sponsors\/[^/]+$/.test(r) || /^suppliers\/[^/]+$/.test(r),
        },
      },
      {
        type: 'annotation',
        title: 'Sponsorship is live',
        body: (
          <>
            The new row appears in the sponsors table and is live on the public site — the Category
            Sponsor board on the target category will show this company.
          </>
        ),
        advance: { kind: 'manual' },
      },
      {
        type: 'annotation',
        title: 'Cleanup',
        body: (
          <>
            To remove the demo sponsorship, go to <b>Sponsors</b>, find the row, and use the
            delete action. Unlike the supplier and part flows, sponsorships have no automatic
            wizard cleanup — delete it manually.
          </>
        ),
        advance: { kind: 'manual' },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Reply to a Message — uses the message detail page reply panel.
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'reply-message',
    title: 'Reply to a Message',
    summary: 'Open an inbound contact, write a response, and send it.',
    icon: 'chat-circle',
    accent: 'violet',
    minutes: 2,
    steps: [
      {
        goto: '',
        selector: '[data-tour="side-messages"]',
        title: 'Open Messages',
        body: (
          <>
            The inbox holds inbound Contact, Join, and Keyword-sponsorship inquiries. Click{' '}
            <b>Messages</b> in the sidebar.
          </>
        ),
        advance: { kind: 'route', test: (r) => r === 'messages' || /^messages\//.test(r) },
      },
      {
        selector: () => document.querySelector('tr[data-msg-status="new"]'),
        title: 'Open a fresh message',
        body: <>Rows with a green dot are unread. Click the first one to open it.</>,
        advance: { kind: 'route', test: (r) => /^messages\/.+/.test(r) },
      },
      {
        fieldName: 'reply_text',
        title: 'Compose your reply',
        body: (
          <>
            Type a response — three or four sentences is the house style. Plain text, no signature
            (the system adds <code>no-reply@circuitcenter.ai</code>).
          </>
        ),
        suggested:
          "Thanks for reaching out — we'd love to chat. I'll send a calendar link separately and follow up with our standard packet. Quick question: what timeline are you working against?",
        advance: {
          kind: 'predicate',
          test: () => {
            const ta = document.querySelector('[data-tour="reply-text"]') as HTMLTextAreaElement | null;
            return !!ta && ta.value.trim().length >= 20;
          },
        },
      },
      {
        selector: '[data-tour="reply-send"]',
        title: 'Send the reply',
        body: (
          <>
            Click <b>Send reply</b>. The message status flips to <i>responded</i> and an activity
            event is recorded.
          </>
        ),
        advance: {
          kind: 'predicate',
          test: () => {
            const route = getRoute();
            const id = route.split('/')[1];
            const m = getStore().messages.find((x) => x.id === id);
            return !!m && m.status === 'responded';
          },
        },
      },
      {
        type: 'annotation',
        title: 'Reply sent',
        body: (
          <>
            Status updated, the activity log on the right shows the new event, and the sidebar
            badge dropped. No cleanup needed — replies aren&apos;t destructive.
          </>
        ),
        advance: { kind: 'manual' },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Use the Import Queue — overview-only flow, no mutations.
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'import-queue',
    title: 'Use the Import Queue',
    summary: 'Inspect pending imports and understand the review flow.',
    icon: 'list-checks',
    accent: 'amber',
    minutes: 2,
    steps: [
      {
        goto: '',
        selector: '[data-tour="side-import"]',
        title: 'Open the Import Queue',
        body: (
          <>
            The Import section is under <i>System</i> in the sidebar. Click it.
          </>
        ),
        advance: { kind: 'route', test: (r) => r === 'import' },
      },
      {
        selector: '[data-tour="import-stepper"]',
        title: 'Three-step upload flow',
        body: (
          <>
            Every CSV passes through <b>Upload</b> → <b>Mapping</b> → <b>Review</b>. You
            can&apos;t skip ahead — each step gates on validating the previous one.
          </>
        ),
        advance: { kind: 'manual' },
      },
      {
        selector: '[data-tour="csv-dropzone"]',
        title: 'Adding new imports',
        body: (
          <>
            To add an upload, pick a supplier and drop a CSV here. The earlier <i>Import CSV</i>{' '}
            tour walks through the full sequence — re-launch it from the help menu if needed.
          </>
        ),
        advance: { kind: 'manual' },
      },
      {
        type: 'annotation',
        title: 'How approvals work in production',
        body: (
          <>
            Today the import inserts directly into the catalog on the final step. In production
            we&apos;ll add an approval gate so a reviewer can preview validated rows before they
            go live.
          </>
        ),
        advance: { kind: 'manual' },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Add a Part (no supplier context) — straight from the Parts page.
  // Uses a real-world component (AMS1117-3.3 LDO regulator) so the
  // tutorial demonstrates realistic data entry. bestPrice step is
  // dropped per the data model: general parts don't have a price until
  // a supplier lists them.
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'add-part-general',
    title: 'Add a Part (no supplier context)',
    summary: 'Add a SKU directly from the Parts page — supplier picked separately later.',
    icon: 'package',
    accent: 'rose',
    minutes: 3,
    steps: [
      {
        goto: '',
        selector: '[data-tour="side-parts"]',
        title: 'Open the Parts page',
        body: (
          <>
            The Parts section under <i>Catalog</i> shows every SKU across the catalog.
          </>
        ),
        advance: { kind: 'route', test: (r) => r === 'parts' || /^parts\//.test(r) },
      },
      {
        selector: '[data-tour="add-part"]',
        title: 'Click "Add Part"',
        body: (
          <>
            Adding from here doesn&apos;t pre-fill a supplier — you can list distributor
            relationships separately from the parts catalog.
          </>
        ),
        advance: { kind: 'route', test: (r) => r === 'parts/new' },
      },
      {
        fieldName: 'sku',
        title: 'Part SKU',
        body: (
          <>
            The manufacturer&apos;s part number — this is the universal identifier engineers search
            by. We&apos;ll use a real-world component, prefixed <code>DEMO-</code> so it can never
            collide with (or be mistaken for) the real AMS1117 in the catalog.
          </>
        ),
        // ⚠ The DEMO- prefix is load-bearing, not cosmetic: cleanup re-reads the
        // part and only deletes SKUs carrying it (see demoMarkers.ts). A bare
        // 'AMS1117-3.3' would be indistinguishable from real catalog data, so
        // the tour's own row could never be safely removed.
        suggested: `${DEMO_PART_SKU_PREFIX}AMS1117-3.3`,
        advance: { kind: 'value', fieldName: 'sku', test: (v) => v.trim().length >= 3 },
      },
      {
        fieldName: 'manufacturer_name',
        title: 'Manufacturer',
        body: (
          <>
            The IC maker — not the distributor. This part is made by Advanced Monolithic Systems.
          </>
        ),
        suggested: 'Advanced Monolithic Systems',
        advance: { kind: 'value', fieldName: 'manufacturer_name', test: (v) => v.trim().length >= 2 },
      },
      {
        fieldName: 'description',
        title: 'Spec-string description',
        body: (
          <>
            Write specs the way an engineer reads a BOM line — leading parameters first, then
            package.
          </>
        ),
        suggested: '3.3V 1A Fixed Output LDO Regulator, SOT-223',
        advance: { kind: 'value', fieldName: 'description', test: (v) => v.trim().length >= 10 },
      },
      {
        fieldName: 'category_id',
        title: 'Category',
        body: (
          <>
            Pick the category this part belongs to. The AMS1117 is a voltage regulator — choose the
            closest match from the dropdown.
          </>
        ),
        suggested: '__auto_select__',
        suggestedLabel: 'First available category',
        advance: { kind: 'value', fieldName: 'category_id', test: (v) => !!v && v.length > 1 },
      },
      {
        fieldName: 'lifecycle_status',
        title: 'Lifecycle status',
        body: (
          <>
            Where the part sits in its production lifecycle. <i>Active</i> = in production,{' '}
            <i>NRND</i> = not recommended for new designs, <i>EOL</i> = end-of-life.
          </>
        ),
        suggested: 'active',
        suggestedLabel: 'Active (in production)',
        advance: { kind: 'value', fieldName: 'lifecycle_status', test: (v) => !!v },
      },
      {
        fieldName: 'datasheet_url',
        title: 'Datasheet URL',
        body: (
          <>
            Link to the manufacturer&apos;s PDF datasheet — engineers click through from the part
            detail page.
          </>
        ),
        suggested: 'ams.com/ams1117',
        advance: {
          kind: 'value',
          fieldName: 'datasheet_url',
          test: (v) => v.includes('.') && v.length >= 5,
        },
      },
      {
        selector: '[data-tour="submit-part"]',
        title: 'Save the part',
        body: (
          <>
            Hit <b>Create part</b>. Since no supplier was selected, the SKU exists in the catalog
            but no distributor lists it yet.
          </>
        ),
        advance: {
          kind: 'route',
          test: (r) => /^parts\/[^/]+$/.test(r) && r !== 'parts/new',
        },
      },
      {
        goto: () => trackedDemoEntityRoute('part', 'parts'),
        selector: demoPartDeleteButton,
        title: 'Clean up',
        body: () =>
          demoPartDeleteButton() != null ? (
            <>
              Click <b>Delete</b> and confirm to remove the tutorial part.
            </>
          ) : (
            <>
              Nothing is highlighted: the tour couldn&apos;t identify the part it created.{' '}
              <b>Don&apos;t delete the part on screen</b> — it may be real catalog data. Click{' '}
              <b>Next</b> to move on; the tour still removes its own demo SKU when it ends.
            </>
          ),
        advance: { kind: 'modal' },
      },
      {
        selector: demoPartConfirmButton,
        title: 'Confirm delete',
        body: () =>
          demoPartConfirmButton() != null ? (
            <>Remove the tutorial entry.</>
          ) : (
            <>
              Nothing is highlighted: this dialog isn&apos;t the one the tour opened for its own
              demo SKU. <b>Cancel it</b> rather than confirming — then click <b>Next</b>.
            </>
          ),
        advance: { kind: 'route', test: (r) => r === 'parts' },
      },
      {
        type: 'annotation',
        title: 'Done',
        body: (
          <>
            Same shape as the other flows: create → land on detail → delete. Now you&apos;ve seen
            every variant.
          </>
        ),
        advance: { kind: 'manual' },
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────
  // Add a Part (supplier context) — the mirror image of add-part-general:
  // the SKU already exists in the catalog, we attach a supplier to it via
  // POST /parts/{id}/listings. Nothing in the parts table is created OR
  // deleted here; the only demo row is the listing, which the last two
  // steps remove. WizardApp also tracks that listing for abandon-cleanup —
  // deleting the borrowed part would be data loss, so cleanup is
  // listing-scoped (see demoCleanup's 'listing' kind).
  //
  // The tour stamps DEMO_LISTING_SKU into the listing's own order code so that
  // cleanup has a marker to verify before detaching anything. Tracking the id
  // is NOT sufficient on its own: every attach submission — tour or real admin
  // work — publishes the same id bridge, so the marker is what makes a real
  // distributor row un-deletable by the wizard.
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'add-part-supplier',
    title: 'Add a Part (supplier context)',
    summary: 'Attach an existing catalog SKU to a distributor, then detach it again.',
    icon: 'link-simple',
    accent: 'teal',
    minutes: 3,
    steps: [
      {
        goto: '',
        selector: '[data-tour="side-parts"]',
        title: 'Open the Parts page',
        body: (
          <>
            This tour doesn&apos;t create a part — it takes one that already exists and adds a
            distributor to it. Start from <b>Parts</b> under <i>Catalog</i>.
          </>
        ),
        advance: { kind: 'route', test: (r) => r === 'parts' || /^parts\//.test(r) },
      },
      {
        selector: firstPartsTableRow,
        title: 'Open any existing part',
        body: (
          <>
            Click the first row in the table. Any real SKU works — we&apos;re only adding a
            listing to it, so the part itself is never modified.
          </>
        ),
        advance: {
          kind: 'route',
          test: (r) => /^parts\/[^/]+$/.test(r) && r !== 'parts/new',
        },
      },
      {
        selector: '[data-tour="add-listing"]',
        title: 'Add a distributor',
        body: (
          <>
            The <i>Distributor listings</i> panel shows every supplier that stocks this part. Click{' '}
            <b>Add distributor</b> to open the attach form.
          </>
        ),
        advance: { kind: 'route', test: (r) => /^parts\/[^/]+\/listings\/new$/.test(r) },
      },
      {
        fieldName: 'supplier_id',
        title: 'Pick the supplier',
        body: (
          <>
            Choose which distributor stocks this SKU. A supplier can only be listed once per part —
            picking one that&apos;s already listed comes back as a duplicate error.
          </>
        ),
        suggested: '__auto_select__',
        suggestedLabel: 'First available supplier',
        advance: { kind: 'value', fieldName: 'supplier_id', test: (v) => !!v && v.length > 1 },
      },
      {
        fieldName: 'initial_stock_quantity',
        title: 'Stock quantity',
        body: (
          <>
            How many units this distributor has on hand. It feeds the public part page&apos;s stock
            column and rolls into the part&apos;s total availability.
          </>
        ),
        suggested: DEMO_PART.stock,
        advance: {
          kind: 'value',
          fieldName: 'initial_stock_quantity',
          test: (v) => Number(v) > 0,
        },
      },
      {
        fieldName: 'initial_unit_price',
        title: 'Unit price',
        body: (
          <>
            What this distributor charges per unit, in USD. The lowest price across all listings
            becomes the part&apos;s <i>best price</i> on the public site.
          </>
        ),
        suggested: DEMO_PART.price,
        advance: {
          kind: 'value',
          fieldName: 'initial_unit_price',
          test: (v) => Number(v) > 0,
        },
      },
      {
        // ⚠ NOT an optional nicety. This field is what MARKS the row as the
        // tour's own: the listing hangs off a real catalog part, so its `sku` is
        // the only thing cleanup can check before detaching it. Leave it blank
        // and the demo listing is unprovable — cleanup will refuse to touch it
        // and it stays attached (fail-closed). Hence the DEMO- advance test.
        fieldName: 'listing_sku',
        title: 'Give it a demo order code',
        body: (
          <>
            The distributor&apos;s own part number for this SKU. We fill in a{' '}
            <code>{DEMO_LISTING_SKU}</code> value on purpose — that <code>DEMO-</code> prefix is
            the marker the tour reads back before it removes this listing, so cleanup can never
            detach one of the real distributor rows next to it.
          </>
        ),
        suggested: DEMO_LISTING_SKU,
        advance: { kind: 'value', fieldName: 'listing_sku', test: isDemoPartSku },
      },
      {
        selector: '[data-tour="submit-listing"]',
        title: 'Attach the listing',
        body: (
          <>
            Hit <b>Add distributor</b>. You&apos;ll land back on the part&apos;s detail page with
            the new listing row in place.
          </>
        ),
        advance: {
          kind: 'route',
          test: (r) =>
            /^parts\/[^/]+$/.test(r) && r !== 'parts/new' && !r.endsWith('/listings/new'),
        },
      },
      {
        type: 'annotation',
        title: 'The part is now listed',
        body: (
          <>
            The distributor shows in the listings panel with its stock and price, and the
            supplier&apos;s parts-count badge bumps up — same catalog row, one more source. This is
            how a real SKU picks up competing distributors over time.
          </>
        ),
        advance: { kind: 'manual' },
      },
      {
        selector: demoListingDeleteButton,
        title: 'Detach the demo listing',
        // Nothing highlighted ⇒ the tour can't prove which row is its own, so
        // the copy must NOT tell the user to remove one. Every other row on
        // this page is real catalog data.
        body: () =>
          demoListingDeleteButton() != null ? (
            <>
              Click <b>Remove</b> on the highlighted row — the listing we just added. Only the
              listing goes; the part stays in the catalog, because it was never ours to delete.
            </>
          ) : (
            <>
              Nothing is highlighted: the tour couldn&apos;t identify the listing it added.{' '}
              <b>Don&apos;t remove any of the rows shown</b> — they&apos;re real catalog data.
              Click <b>Next</b> to move on.
            </>
          ),
        hint: 'Leave the other distributor rows alone — those are real catalog data.',
        // Requires OUR row to still be identifiable AND the open dialog to be
        // the one raised for it — not just "a modal is open": with no spotlight
        // there are no click-blockers either, so a confirm dialog opened from a
        // REAL row must never walk the tour on to "Confirm the detach" and tell
        // the user to go through with it.
        advance: {
          kind: 'predicate',
          test: () =>
            demoListingDeleteButton() != null && demoListingConfirmModal() != null,
        },
      },
      {
        // Identity-keyed, same as the step above: the confirm button is only
        // resolved inside the dialog stamped with the tracked listing id.
        selector: demoListingConfirmButton,
        title: 'Confirm the detach',
        body: () =>
          demoListingConfirmButton() != null ? (
            <>
              Confirm to drop the listing and its price breaks. The part&apos;s best price and
              total stock recalculate from whatever distributors remain.
            </>
          ) : (
            <>
              Nothing is highlighted: this dialog isn&apos;t the one the tour opened for its own
              listing. <b>Cancel it</b> rather than confirming — then click <b>Next</b>.
            </>
          ),
        // Deliberately NOT modalGone — Cancel and backdrop clicks dismiss the
        // modal too, and the next annotation would then claim a still-present
        // listing was removed. Advance only once the row is actually gone.
        advance: { kind: 'predicate', test: demoListingIsGone },
      },
      {
        type: 'annotation',
        title: 'Back to where we started',
        body: (
          <>
            Attach → verify → detach, with the catalog part untouched throughout. That&apos;s the
            supplier-context half of parts management.
          </>
        ),
        advance: { kind: 'manual' },
      },
    ],
  },
];
