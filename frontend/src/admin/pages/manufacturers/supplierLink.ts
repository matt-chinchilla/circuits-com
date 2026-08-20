// Pure helpers behind the Manufacturers→Supplier bridge (detail page).
//
// Kept out of the component because every branch here decides what an admin is
// allowed to do NEXT: offer the wrong button and the API refuses the click, or
// worse, a second Supplier row gets created for a company that already has one.
// The API is the enforcement point — this file only keeps the UI honest about
// what the API will accept.

import type { AdminManufacturerDetail } from '@admin/types/manufacturers';

/**
 * The External-coverage cell/row label.
 *
 * `external_part_count` is a SNAPSHOT of what the manufacturer lists somewhere
 * else, taken on `external_part_count_as_of` — it is NOT our inventory. Printed
 * bare in a parts column it reads as "we carry 12,400 of these", which is a lie
 * by omission, so the number only ever appears as the denominator of a labelled
 * ratio. With no snapshot (null, or a zero that means "never measured") the
 * catalog count stands alone.
 *
 * Thousands separators are pinned to en-US rather than the ambient locale: the
 * admin is a single-tenant US console and a locale-dependent label is a
 * locale-dependent test.
 */
export function coverageLabel(catalog: number, external: number | null): string {
  const listed = catalog.toLocaleString('en-US');
  if (external == null || external <= 0) return listed;
  return `${listed} of ~${external.toLocaleString('en-US')} listed`;
}

/**
 * Why "Promote to supplier" must not be offered — or null when it may be.
 *
 * Mirrors the two states `POST /promote` rejects outright: an existing link
 * (409 already_linked) and a manufacturer with no usable name (the Supplier row
 * would be born nameless). Everything else is the server's call.
 */
export function promoteBlockedReason(detail: AdminManufacturerDetail): string | null {
  if (detail.linked_supplier_id != null) {
    return `Already linked to ${detail.linked_supplier_name ?? 'a supplier'}.`;
  }
  if (!detail.name.trim()) {
    return 'This manufacturer has no name to create a supplier from.';
  }
  return null;
}

export interface PromoteFailure {
  /** Sentence shown to the admin. Never a bare machine code. */
  message: string;
  /**
   * True ONLY for the one conflict a human can resolve in place: a Supplier
   * already owns this name, so the right move is to LINK the two rows rather
   * than mint a duplicate company. Any other failure leaves the picker shut —
   * offering it would invite a link the server is about to refuse anyway.
   */
  showPicker: boolean;
}

/**
 * Translate a `POST /promote` 4xx detail (already run through `apiErrorDetail`,
 * which turns the demo-gate code into prose and passes everything else through)
 * into what the page should say and do.
 */
export function promoteFailure(detail: string | undefined): PromoteFailure {
  switch (detail) {
    case 'supplier_name_exists_use_link':
      return {
        message:
          'A supplier already uses this exact name. Link this manufacturer to that supplier instead of creating a second company for it.',
        showPicker: true,
      };
    case 'already_linked':
      return {
        message: 'This manufacturer is already linked to a supplier. Reload to see the current link.',
        showPicker: false,
      };
    case 'supplier_already_linked':
      return {
        message: 'That supplier is already linked to another manufacturer. Choose a different one.',
        showPicker: false,
      };
    default:
      return {
        message: detail ?? 'Could not promote this manufacturer. Please try again.',
        showPicker: false,
      };
  }
}
