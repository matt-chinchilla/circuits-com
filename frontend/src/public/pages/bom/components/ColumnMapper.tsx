import { useMemo } from 'react';
import type { BomRole } from '../lib/headerAliases';
import { previewRows } from '../lib/parseBom';
import { BOM_ROLES } from '../lib/mapMemory';
import styles from '../BomPage.module.scss';

/**
 * The column mapper — the one screen that asks the person a question.
 *
 * It exists for the BOMs the alias table cannot read: a template with columns
 * named after a company's own conventions, or an export with no header row at
 * all. Rather than guessing and pricing the wrong column, the tool shows what
 * it read and lets the answer be given once (the page remembers it by header
 * signature, so the same template never asks twice).
 *
 * Controlled on purpose: the roles live in the page, because the page is what
 * re-materializes the source text with them (`applyRoleMap`). The mapper only
 * renders the question.
 *
 * A native `<select>` is correct here — the options are plain text with no
 * Icon markup, which is the case the custom admin listbox exists to solve and
 * this one does not have.
 */

const ROLE_LABELS: Record<BomRole, string> = {
  mpn: 'Manufacturer part number',
  manufacturer: 'Manufacturer',
  refs: 'Designators / references',
  qty: 'Quantity',
  value: 'Value',
  footprint: 'Footprint',
  description: 'Description',
  datasheet: 'Datasheet',
  dnp: 'Do not populate',
  distributor_pn: 'Distributor part number',
};

/** The part-identity floor: without an MPN or a value there is nothing to
 *  price, and every other column is decoration. */
export function canPrice(roles: (BomRole | null)[]): boolean {
  return roles.some((role) => role === 'mpn' || role === 'value');
}

const PREVIEW_ROWS = 3;

interface ColumnMapperProps {
  headers: string[];
  roles: (BomRole | null)[];
  /** The raw source, for the preview cells only — never re-parsed for data. */
  text: string;
  onChange: (roles: (BomRole | null)[]) => void;
  onContinue: () => void;
}

export default function ColumnMapper({
  headers,
  roles,
  text,
  onChange,
  onContinue,
}: ColumnMapperProps) {
  const sample = useMemo(() => previewRows(text, PREVIEW_ROWS), [text]);

  // The materializer takes the FIRST column holding a role, so a role picked
  // twice quietly does nothing on the later column. Say so on the row instead
  // of letting the person believe both are being read.
  const firstColumnFor = useMemo(() => {
    const first: Partial<Record<BomRole, number>> = {};
    roles.forEach((role, i) => {
      if (role !== null && first[role] === undefined) first[role] = i;
    });
    return first;
  }, [roles]);

  const setRole = (index: number, next: BomRole | null) => {
    const copy = roles.slice();
    copy[index] = next;
    onChange(copy);
  };

  const ready = canPrice(roles);

  return (
    <section className={styles.mapper} aria-labelledby="bom-mapper-title">
      <h2 id="bom-mapper-title" className={styles.phaseTitle}>
        Match your columns
      </h2>
      <p className={styles.phaseText}>
        We could not tell which column holds the part. Point us at it and we will remember this
        layout the next time you upload the same export.
      </p>

      <ul className={styles.mapList}>
        {headers.map((header, i) => {
          const role = roles[i] ?? null;
          const shadowed = role !== null && firstColumnFor[role] !== i;
          const cells = sample
            .map((row) => (row[i] ?? '').trim())
            .filter((cell) => cell !== '');
          const selectId = `bom-col-${i}`;
          return (
            <li key={`${header}-${i}`} className={styles.mapRow}>
              <div className={styles.mapCol}>
                <label className={styles.mapHeader} htmlFor={selectId}>
                  {header.trim() === '' ? `Column ${i + 1}` : header}
                </label>
                {cells.length > 0 ? (
                  <ul className={styles.mapSample}>
                    {cells.map((cell, j) => (
                      <li key={`${cell}-${j}`}>{cell}</li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.mapSampleEmpty}>No sample values</p>
                )}
              </div>

              <div className={styles.mapPick}>
                <select
                  id={selectId}
                  className={styles.mapSelect}
                  value={role ?? ''}
                  onChange={(e) => setRole(i, e.target.value === '' ? null : (e.target.value as BomRole))}
                >
                  <option value="">Ignore this column</option>
                  {BOM_ROLES.map((option) => (
                    <option key={option} value={option}>
                      {ROLE_LABELS[option]}
                    </option>
                  ))}
                </select>
                {shadowed && (
                  <p className={styles.mapNote}>
                    Already taken by an earlier column &mdash; that one is the one we read.
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className={styles.mapFoot}>
        <button
          type="button"
          className={styles.mapContinue}
          onClick={onContinue}
          disabled={!ready}
        >
          Price this BOM
        </button>
        {!ready && (
          <p className={styles.mapHint}>
            Pick the column holding the part number or the value first &mdash; everything else is
            optional.
          </p>
        )}
      </div>
    </section>
  );
}
