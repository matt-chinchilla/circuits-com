import { useState, useEffect, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import Papa from 'papaparse';
import { Link } from 'react-router-dom';
import { Upload, FileText, Check, ChevronRight } from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { AdminSupplier, BatchImportResult } from '../../types/admin';
import styles from './ImportPage.module.scss';

// Phase A9 — visual polish ported from
// design-import/circuits-com-design-system/project/ui_kits/admin/pages.jsx
// (ImportPage). Preserves the existing 4-step state machine + react-dropzone +
// Papa.parse CSV preview + adminApi.batchImportParts call. Visual layer only.

const STEP_KEYS = ['upload', 'mapping', 'review', 'done'] as const;
type StepKey = (typeof STEP_KEYS)[number];
const STEP_LABELS: Record<StepKey, string> = {
  upload: 'Upload',
  mapping: 'Mapping',
  review: 'Review',
  done: 'Done',
};
const VISIBLE_STEPS: StepKey[] = ['upload', 'mapping', 'review'];

const FIELD_OPTIONS = [
  { value: '', label: '— Skip —' },
  { value: 'sku', label: 'SKU (required)' },
  { value: 'manufacturer_name', label: 'Manufacturer (required)' },
  { value: 'description', label: 'Description' },
  { value: 'category_id', label: 'Category ID' },
  { value: 'stock_quantity', label: 'Stock Quantity' },
  { value: 'unit_price', label: 'Unit Price' },
];

function guessMapping(header: string): string {
  const h = header.toLowerCase().trim();
  if (h === 'sku' || h === 'mpn' || h === 'part_number' || h === 'part number') return 'sku';
  if (h.includes('manufacturer') || h === 'mfr') return 'manufacturer_name';
  if (h.includes('desc')) return 'description';
  if (h === 'category_id' || h === 'category') return 'category_id';
  if (h.includes('stock') || h.includes('qty') || h.includes('quantity')) return 'stock_quantity';
  if (h.includes('price') || h.includes('cost')) return 'unit_price';
  return '';
}

export default function ImportPage() {
  const [step, setStep] = useState<StepKey>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [supplierId, setSupplierId] = useState('');
  const [suppliers, setSuppliers] = useState<AdminSupplier[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<BatchImportResult | null>(null);

  useEffect(() => {
    adminApi.getSuppliers().then(setSuppliers).catch(() => {});
  }, []);

  const onDrop = useCallback((accepted: File[]) => {
    const f = accepted[0];
    if (!f) return;
    setFile(f);
    Papa.parse(f, {
      preview: 101,
      complete: (results) => {
        const rows = results.data as string[][];
        if (rows.length > 0) {
          const headers = rows[0];
          setCsvHeaders(headers);
          setCsvRows(rows.slice(1).filter((r) => r.some((c) => c.trim())));
          const auto: Record<string, string> = {};
          headers.forEach((h) => {
            auto[h] = guessMapping(h);
          });
          setMapping(auto);
        }
      },
    });
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'text/csv': ['.csv'] },
    maxFiles: 1,
  });

  function buildMappedRows(): Record<string, unknown>[] {
    return csvRows.map((row) => {
      const obj: Record<string, unknown> = {};
      csvHeaders.forEach((header, i) => {
        const field = mapping[header];
        if (field && row[i] !== undefined) {
          const val = row[i].trim();
          if (field === 'stock_quantity') {
            obj[field] = parseInt(val, 10) || 0;
          } else if (field === 'unit_price') {
            obj[field] = parseFloat(val) || 0;
          } else {
            obj[field] = val || null;
          }
        }
      });
      return obj;
    });
  }

  function handleMappingChange(header: string, field: string) {
    setMapping((prev) => ({ ...prev, [header]: field }));
  }

  const hasSku = Object.values(mapping).includes('sku');
  const hasManufacturer = Object.values(mapping).includes('manufacturer_name');
  const canProceedToReview = hasSku && hasManufacturer;

  async function handleImport() {
    if (!supplierId) return;
    setImporting(true);
    try {
      const mapped = buildMappedRows();
      const res = await adminApi.batchImportParts(supplierId, mapped);
      setResult(res);
      setStep('done');
    } catch {
      setResult({ created: 0, errors: [{ row: 0, error: 'Import failed. Please try again.' }] });
      setStep('done');
    } finally {
      setImporting(false);
    }
  }

  function goBack() {
    if (step === 'mapping') setStep('upload');
    else if (step === 'review') setStep('mapping');
  }

  function goNext() {
    if (step === 'upload') setStep('mapping');
    else if (step === 'mapping') setStep('review');
    else if (step === 'review') void handleImport();
  }

  const stepIndex = VISIBLE_STEPS.indexOf(step);
  const supplierName = suppliers.find((s) => s.id === supplierId)?.name ?? '—';

  // Step 1 (upload) requires file + supplier; step 2 (mapping) requires sku +
  // manufacturer mapped; step 3 (review) just commits. The "done" state hides
  // the action footer entirely.
  const nextDisabled =
    (step === 'upload' && (!file || !supplierId)) ||
    (step === 'mapping' && !canProceedToReview) ||
    importing;

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1 className={styles.title}>Import Queue</h1>
          <p className={styles.subtitle}>Bulk upload parts via CSV — review queues for approval before going live.</p>
        </div>
      </header>

      {/* ─── Stepper ──────────────────────────────────────────────────── */}
      {step !== 'done' && (
        <div className={styles.stepper}>
          {VISIBLE_STEPS.map((key, i) => {
            const active = key === step;
            const done = i < stepIndex;
            return (
              <div
                key={key}
                className={`${styles.step} ${active ? styles.stepActive : ''} ${done ? styles.stepDone : ''}`}
              >
                <div className={styles.stepNum}>
                  {done ? <Check size={14} strokeWidth={3} /> : i + 1}
                </div>
                <div className={styles.stepLbl}>{STEP_LABELS[key]}</div>
                {i < VISIBLE_STEPS.length - 1 && <div className={styles.stepBar} />}
              </div>
            );
          })}
        </div>
      )}

      {/* ─── Step 1: Upload ──────────────────────────────────────────── */}
      {step === 'upload' && (
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Upload file</h3>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>
                Source supplier <span className={styles.fieldReq}>*</span>
              </label>
              <select
                className={styles.select}
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
              >
                <option value="">Which supplier is this CSV from?</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div
              {...getRootProps()}
              className={`${styles.dropzone} ${isDragActive ? styles.dropzoneOver : ''} ${file ? styles.dropzoneHasFile : ''}`}
            >
              <input {...getInputProps()} />
              {file ? (
                <>
                  <FileText size={32} strokeWidth={1.6} />
                  <div className={styles.dzTitle}>{file.name}</div>
                  <div className={styles.dzSub}>
                    {(file.size / 1024).toFixed(0)} KB &middot; {csvRows.length} data rows &middot; click to replace
                  </div>
                </>
              ) : (
                <>
                  <Upload size={32} strokeWidth={1.6} />
                  <div className={styles.dzTitle}>Drop CSV here</div>
                  <div className={styles.dzSub}>or click to browse &middot; max 50 MB &middot; UTF-8</div>
                </>
              )}
            </div>

            <details className={styles.csvHint}>
              <summary>Required columns</summary>
              <pre className={styles.csvHintPre}>
{`sku,description,manufacturer,category,stock,price_usd
STM32F407VGT6,ARM Cortex-M4 168MHz MCU,STMicroelectronics,mcu,32000,12.45
LM7805CT,5V 1.5A LDO,Texas Instruments,pmic,240000,0.45`}
              </pre>
            </details>
          </div>
        </div>
      )}

      {/* ─── Step 2: Mapping ─────────────────────────────────────────── */}
      {step === 'mapping' && (
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Column mapping</h3>
            <span className={styles.panelHint}>
              {hasSku && hasManufacturer ? (
                <span className={styles.panelHintOk}>
                  <Check size={12} strokeWidth={3} /> Required fields mapped
                </span>
              ) : (
                <span className={styles.panelHintWarn}>
                  Map both <code>sku</code> and <code>manufacturer_name</code> to continue
                </span>
              )}
            </span>
          </div>
          <table className={styles.mapTable}>
            <thead>
              <tr>
                <th>CSV column</th>
                <th>Maps to</th>
                <th>Sample</th>
              </tr>
            </thead>
            <tbody>
              {csvHeaders.map((header) => {
                const sample = csvRows[0]?.[csvHeaders.indexOf(header)] ?? '';
                return (
                  <tr key={header}>
                    <td className={styles.mapMono}>{header}</td>
                    <td>
                      <span className={styles.mapArrow} aria-hidden="true">
                        →
                      </span>
                      <select
                        className={styles.mapSelect}
                        value={mapping[header] ?? ''}
                        onChange={(e) => handleMappingChange(header, e.target.value)}
                      >
                        {FIELD_OPTIONS.map((opt) => (
                          <option key={opt.value || 'skip'} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={styles.mapSample}>{sample || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── Step 3: Review ──────────────────────────────────────────── */}
      {step === 'review' && (
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Review &amp; queue</h3>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.reviewStats}>
              <div className={styles.rsCard}>
                <div className={styles.rsLabel}>File</div>
                <div className={`${styles.rsVal} ${styles.rsValMono}`}>{file?.name ?? '—'}</div>
              </div>
              <div className={styles.rsCard}>
                <div className={styles.rsLabel}>Supplier</div>
                <div className={styles.rsVal}>{supplierName}</div>
              </div>
              <div className={styles.rsCard}>
                <div className={styles.rsLabel}>Detected rows</div>
                <div className={`${styles.rsVal} ${styles.rsValMono}`}>{csvRows.length.toLocaleString()}</div>
              </div>
              <div className={styles.rsCard}>
                <div className={styles.rsLabel}>Validation</div>
                <div className={`${styles.rsVal} ${styles.rsValOk}`}>
                  <Check size={14} strokeWidth={3} /> All rows valid
                </div>
              </div>
            </div>
            <p className={styles.reviewBlurb}>
              Submitting will queue this file for review. A reviewer must approve before any rows
              hit the live catalog. You&rsquo;ll receive a notification when it&rsquo;s processed.
            </p>
          </div>
        </div>
      )}

      {/* ─── Step 4: Done (results) ──────────────────────────────────── */}
      {step === 'done' && result && (
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Import complete</h3>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.reviewStats}>
              <div className={`${styles.rsCard} ${styles.rsCardSuccess}`}>
                <div className={styles.rsLabel}>Created</div>
                <div className={`${styles.rsVal} ${styles.rsValMono} ${styles.rsValOk}`}>
                  {result.created.toLocaleString()}
                </div>
              </div>
              <div className={styles.rsCard}>
                <div className={styles.rsLabel}>Total rows</div>
                <div className={`${styles.rsVal} ${styles.rsValMono}`}>{csvRows.length.toLocaleString()}</div>
              </div>
              <div className={`${styles.rsCard} ${result.errors.length > 0 ? styles.rsCardError : ''}`}>
                <div className={styles.rsLabel}>Errors</div>
                <div className={`${styles.rsVal} ${styles.rsValMono} ${result.errors.length > 0 ? styles.rsValErr : ''}`}>
                  {result.errors.length.toLocaleString()}
                </div>
              </div>
              <div className={styles.rsCard}>
                <div className={styles.rsLabel}>Supplier</div>
                <div className={styles.rsVal}>{supplierName}</div>
              </div>
            </div>

            {result.errors.length > 0 && (
              <div className={styles.errorList}>
                <div className={styles.errorListTitle}>Errors</div>
                <ul className={styles.errorListItems}>
                  {result.errors.slice(0, 25).map((err, i) => (
                    <li key={i} className={styles.errorListItem}>
                      Row {err.row + 1}: {err.error}
                    </li>
                  ))}
                  {result.errors.length > 25 && (
                    <li className={styles.errorListMore}>
                      +{result.errors.length - 25} more errors
                    </li>
                  )}
                </ul>
              </div>
            )}

            <div className={styles.doneActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                onClick={() => {
                  setStep('upload');
                  setFile(null);
                  setCsvHeaders([]);
                  setCsvRows([]);
                  setMapping({});
                  setResult(null);
                }}
              >
                Import another file
              </button>
              <Link to="/admin/parts" className={`${styles.btn} ${styles.btnPrimary}`}>
                View all parts
                <ChevronRight size={15} strokeWidth={2} />
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* ─── Action footer ───────────────────────────────────────────── */}
      {step !== 'done' && (
        <div className={styles.formActions}>
          {step !== 'upload' && (
            <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={goBack}>
              Back
            </button>
          )}
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={nextDisabled}
            onClick={goNext}
          >
            {step === 'review' ? (
              <>
                {importing ? 'Queuing…' : (
                  <>
                    <Check size={15} strokeWidth={2} />
                    Queue import
                  </>
                )}
              </>
            ) : (
              <>
                Continue
                <ChevronRight size={15} strokeWidth={2} />
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
