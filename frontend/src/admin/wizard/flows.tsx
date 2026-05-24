import type { Flow } from './types';
import { getStore, getRoute } from './helpers';

// Demo data — short, recognizably fake, easy for the user to spot and
// delete at the end of each tour.
export const DEMO_SUPPLIER = {
  name: 'Demo Components Inc.',
  description: 'Demo distributor created during the guided tour — safe to delete.',
  contactPerson: 'Jane Doe',
  website: 'demo-components.com',
  phone: '555-100-2000',
  email: 'sales@demo-components.com',
} as const;

export const DEMO_PART = {
  sku: 'DEMO-100',
  manufacturer: 'Demo Components Inc.',
  description: 'Tutorial 10uF X7R Capacitor — safe to delete.',
  category: 'pmic',
  price: '1.25',
  stock: '5',
} as const;

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
        body: (
          <>
            Here&apos;s the detail page for <b>{DEMO_SUPPLIER.name}</b>. The colored cards at the
            top are <i>Quick Actions</i> — they pre-fill the Add-Part, Import-CSV, and Sponsorship
            forms with this supplier&apos;s context. Below, you&apos;d see all the parts in their
            catalog.
          </>
        ),
        hint: "No parts listed yet — that's what the next tour covers.",
        advance: { kind: 'manual' },
      },
      {
        type: 'preview',
        preview: { page: 'category', arg: PREVIEW_CATEGORY_SLUG },
        title: 'See it on the live site',
        body: (
          <>
            This is the public-facing Circuits.com — note how <b>{DEMO_SUPPLIER.name}</b> now
            appears as the <i>Featured Supplier</i> in the category page sidebar. Adding through
            the admin propagates to the directory immediately.
          </>
        ),
        advance: { kind: 'manual' },
      },
      {
        goto: () => {
          // Navigate back to the demo supplier so the delete button is on-screen.
          // We don't have a sync supplier cache, but the route is still
          // /admin/suppliers/<id> from step 9. Re-navigate to itself so the
          // route-based advance picks up the goto-driven path.
          const r = getRoute();
          if (/^suppliers\/[^/]+$/.test(r) && r !== 'suppliers/new') return r;
          return 'suppliers';
        },
        selector: '[data-tour="delete-supplier"]',
        title: "Now let's clean up",
        body: (
          <>
            Demo data shouldn&apos;t outlive the tutorial. Click <b>Delete</b> in the header —
            you&apos;ll get a confirmation dialog.
          </>
        ),
        advance: { kind: 'modal' },
      },
      {
        selector: '[data-modal-confirm="true"]',
        title: 'Confirm the delete',
        body: (
          <>
            Click <b>Confirm</b> to remove <b>{DEMO_SUPPLIER.name}</b>. The supplier is gone from
            the directory, and from the public site, in the same beat.
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
    minutes: 2,
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
        advance: { kind: 'value', fieldName: 'category_id', test: (v) => !!v && v.length > 1 },
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
        selector: '[data-tour="delete-part"]',
        title: 'Delete the demo SKU',
        body: (
          <>
            Click <b>Delete</b> and confirm to remove the tutorial part. Distributor listings
            linked to it are unlinked automatically.
          </>
        ),
        advance: { kind: 'modal' },
      },
      {
        selector: '[data-modal-confirm="true"]',
        title: 'Confirm',
        body: <>Wipe the tutorial part.</>,
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
            <p>The file must be UTF-8 CSV with this header — order matters:</p>
            <p>
              <code>sku,description,manufacturer,category,stock,price_usd</code>
            </p>
            <p>Example row:</p>
            <p>
              <code>DEMO-CAP-100,Tutorial 10uF Cap,Demo Co.,pmic,5000,1.25</code>
            </p>
          </>
        ),
        hint: 'The "Required columns" disclosure on the upload page has the same schema — bookmark it.',
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
        body: (
          <>
            The 3 demo SKUs all start with <code>DEMO-</code>. You can delete them individually
            from the Parts page, or leave them — they&apos;ll get wiped on the next{' '}
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
            The new row appears in the sponsors table. Sponsors are stored in browser localStorage
            for now — they don&apos;t round-trip to the API yet.
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
            delete action. The list is local-only so clearing your browser&apos;s storage also
            wipes it.
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
        selector: '[data-tour="reply-text"]',
        title: 'Compose your reply',
        body: (
          <>
            Type a response — three or four sentences is the house style. Plain text, no signature
            (the system adds <code>no-reply@circuits.com</code>).
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
  // bestPrice step is dropped per the data model: general parts don't
  // have a price until a supplier lists them.
  // ──────────────────────────────────────────────────────────────────────
  {
    id: 'add-part-general',
    title: 'Add a Part (no supplier context)',
    summary: 'Add a SKU directly from the Parts page — supplier picked separately later.',
    icon: 'package',
    accent: 'rose',
    minutes: 2,
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
        body: <>Manufacturer part number. We&apos;ll use a clearly-fake tutorial SKU.</>,
        suggested: 'DEMO-GEN-100',
        advance: { kind: 'value', fieldName: 'sku', test: (v) => v.trim().length >= 3 },
      },
      {
        fieldName: 'manufacturer_name',
        title: 'Manufacturer',
        body: <>The chip&apos;s actual maker (not the distributor selling it).</>,
        suggested: 'Demo Components Inc.',
        advance: { kind: 'value', fieldName: 'manufacturer_name', test: (v) => v.trim().length >= 2 },
      },
      {
        fieldName: 'description',
        title: 'Spec-string description',
        body: <>BOM-order specs: voltage / current / package / role.</>,
        suggested: 'Tutorial 3.3V 500mA LDO Regulator',
        advance: { kind: 'value', fieldName: 'description', test: (v) => v.trim().length >= 10 },
      },
      {
        fieldName: 'category_id',
        title: 'Category',
        body: <>Pick any category from the dropdown.</>,
        advance: { kind: 'value', fieldName: 'category_id', test: (v) => !!v && v.length > 1 },
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
        selector: '[data-tour="delete-part"]',
        title: 'Clean up',
        body: (
          <>
            Click <b>Delete</b> and confirm to remove the tutorial SKU.
          </>
        ),
        advance: { kind: 'modal' },
      },
      {
        selector: '[data-modal-confirm="true"]',
        title: 'Confirm delete',
        body: <>Wipe the demo part.</>,
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
];
