import { useState, useEffect, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import Papa from 'papaparse';
import { Link } from 'react-router-dom';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import { adminApi } from '../../services/adminApi';
import type { AdminSupplier, BatchImportResult } from '../../types/admin';
import styles from './ImportPage.module.scss';

const STEPS = ['Upload', 'Map Columns', 'Preview', 'Confirm'];

const FIELD_OPTIONS = [
  { value: '', label: '-- Skip --' },
  { value: 'mpn', label: 'MPN (required)' },
  { value: 'manufacturer_name', label: 'Manufacturer (required)' },
  { value: 'description', label: 'Description' },
  { value: 'category_id', label: 'Category ID' },
  { value: 'sku', label: 'SKU' },
  { value: 'stock_quantity', label: 'Stock Quantity' },
  { value: 'unit_price', label: 'Unit Price' },
];

function guessMapping(header: string): string {
  const h = header.toLowerCase().trim();
  if (h === 'mpn' || h === 'part_number' || h === 'part number') return 'mpn';
  if (h.includes('manufacturer') || h === 'mfr') return 'manufacturer_name';
  if (h.includes('desc')) return 'description';
  if (h === 'category_id' || h === 'category') return 'category_id';
  if (h === 'sku') return 'sku';
  if (h.includes('stock') || h.includes('qty') || h.includes('quantity')) return 'stock_quantity';
  if (h.includes('price') || h.includes('cost')) return 'unit_price';
  return '';
}

export default function ImportPage() {
  const [step, setStep] = useState(0);
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

  const canProceedToPreview =
    Object.values(mapping).includes('mpn') && Object.values(mapping).includes('manufacturer_name');

  async function handleImport() {
    if (!supplierId) return;
    setImporting(true);
    try {
      const mapped = buildMappedRows();
      const res = await adminApi.batchImportParts(supplierId, mapped);
      setResult(res);
      setStep(3);
    } catch {
      setResult({ created: 0, errors: [{ row: 0, error: 'Import failed. Please try again.' }] });
      setStep(3);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className={styles.page}>
      <Breadcrumbs items={[{ label: 'Dashboard', href: '/admin' }, { label: 'Import' }]} />

      <h1 className={styles.title}>Import Parts from CSV</h1>
      <p className={styles.subtitle}>Upload a CSV file to bulk-import parts into the system.</p>

      <div className={styles.steps}>
        {STEPS.map((label, i) => (
          <div
            key={label}
            className={`${styles.step} ${i === step ? styles.stepActive : ''} ${i < step ? styles.stepDone : ''}`}
          >
            <span className={styles.stepNumber}>{i < step ? '\u2713' : i + 1}</span>
            {label}
          </div>
        ))}
      </div>

      {/* Step 0: Upload */}
      {step === 0 && (
        <div className={styles.card}>
          <div
            {...getRootProps()}
            className={`${styles.dropzone} ${isDragActive ? styles.dropzoneActive : ''}`}
          >
            <input {...getInputProps()} />
            <span className={styles.dropIcon}>{'\uD83D\uDCC4'}</span>
            <p className={styles.dropText}>Drag and drop a CSV file here, or click to browse</p>
            <p className={styles.dropHint}>Accepts .csv files only</p>
          </div>
          {file && (
            <div className={styles.fileInfo}>
              <span className={styles.fileIcon}>{'\u2705'}</span>
              <div className={styles.fileDetails}>
                <p className={styles.fileName}>{file.name}</p>
                <p className={styles.fileSize}>
                  {(file.size / 1024).toFixed(1)} KB &middot; {csvRows.length} data rows
                </p>
              </div>
              <button className={styles.removeFile} onClick={() => { setFile(null); setCsvHeaders([]); setCsvRows([]); }}>
                Remove
              </button>
            </div>
          )}
          <div className={styles.actions}>
            <div />
            <button
              className={styles.nextBtn}
              disabled={!file || csvHeaders.length === 0}
              onClick={() => setStep(1)}
            >
              Next: Map Columns
            </button>
          </div>
        </div>
      )}

      {/* Step 1: Map Columns */}
      {step === 1 && (
        <div className={styles.card}>
          <div className={styles.supplierField}>
            <label className={styles.label}>
              Supplier <span className={styles.required}>*</span>
            </label>
            <select
              className={styles.select}
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
            >
              <option value="">Select a supplier...</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <h3 className={styles.mappingTitle}>Column Mapping</h3>
          <div className={styles.mappingGrid}>
            <span className={styles.mappingHeader}>CSV Column</span>
            <span className={styles.mappingHeader} />
            <span className={styles.mappingHeader}>Maps To</span>
            {csvHeaders.map((header) => (
              <div key={header} style={{ display: 'contents' }}>
                <span className={styles.csvColumn}>{header}</span>
                <span className={styles.mappingArrow}>{'\u2192'}</span>
                <select
                  className={styles.mappingSelect}
                  value={mapping[header] ?? ''}
                  onChange={(e) => handleMappingChange(header, e.target.value)}
                >
                  {FIELD_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className={styles.actions}>
            <button className={styles.backBtn} onClick={() => setStep(0)}>
              Back
            </button>
            <button
              className={styles.nextBtn}
              disabled={!canProceedToPreview || !supplierId}
              onClick={() => setStep(2)}
            >
              Next: Preview
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Preview */}
      {step === 2 && (
        <div className={styles.card}>
          <h3 className={styles.previewTitle}>Preview Import</h3>
          <p className={styles.previewSubtitle}>
            {csvRows.length} rows will be imported. Showing first {Math.min(csvRows.length, 10)} rows.
          </p>
          <div className={styles.previewTable}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ padding: '10px 12px', textAlign: 'left', borderBottom: '2px solid #e5e7eb', fontSize: '16px' }}>#</th>
                  {Object.entries(mapping)
                    .filter(([, v]) => v)
                    .map(([h, v]) => (
                      <th key={h} style={{ padding: '10px 12px', textAlign: 'left', borderBottom: '2px solid #e5e7eb', fontSize: '16px' }}>
                        {v}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {csvRows.slice(0, 10).map((row, ri) => (
                  <tr key={ri}>
                    <td style={{ padding: '10px 12px', borderBottom: '1px solid #f3f4f6', fontSize: '16px' }}>{ri + 1}</td>
                    {Object.entries(mapping)
                      .filter(([, v]) => v)
                      .map(([h]) => {
                        const colIdx = csvHeaders.indexOf(h);
                        return (
                          <td key={h} style={{ padding: '10px 12px', borderBottom: '1px solid #f3f4f6', fontSize: '16px' }}>
                            {colIdx >= 0 ? row[colIdx] || '\u2014' : '\u2014'}
                          </td>
                        );
                      })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.actions}>
            <button className={styles.backBtn} onClick={() => setStep(1)}>
              Back
            </button>
            <button className={styles.nextBtn} onClick={handleImport} disabled={importing}>
              {importing ? 'Importing...' : `Import ${csvRows.length} Parts`}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Results */}
      {step === 3 && result && (
        <div className={styles.card}>
          <h3 className={styles.resultTitle}>Import Complete</h3>
          <div className={styles.resultStats}>
            <div className={`${styles.resultStat} ${styles.resultStatSuccess}`}>
              <p className={styles.resultStatValue}>{result.created}</p>
              <p className={styles.resultStatLabel}>Created</p>
            </div>
            <div className={styles.resultStat}>
              <p className={styles.resultStatValue}>{csvRows.length}</p>
              <p className={styles.resultStatLabel}>Total Rows</p>
            </div>
            <div className={`${styles.resultStat} ${result.errors.length > 0 ? styles.resultStatError : ''}`}>
              <p className={styles.resultStatValue}>{result.errors.length}</p>
              <p className={styles.resultStatLabel}>Errors</p>
            </div>
          </div>
          {result.errors.length > 0 && (
            <div className={styles.errorList}>
              <p className={styles.errorListTitle}>Errors</p>
              <ul className={styles.errorListItems}>
                {result.errors.map((err, i) => (
                  <li key={i} className={styles.errorListItem}>
                    Row {err.row + 1}: {err.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className={styles.actions}>
            <div />
            <Link to="/admin/parts" className={styles.doneBtn}>
              View All Parts
            </Link>
          </div>
        </div>
      )}

      {importing && (
        <div className={styles.importing}>
          <span className={styles.spinner}>{'\u23F3'}</span>
          <p className={styles.importingText}>Importing parts... please wait.</p>
        </div>
      )}
    </div>
  );
}
