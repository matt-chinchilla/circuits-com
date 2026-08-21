/** SheetJS is ~400KB — loaded ONLY when an .xls/.xlsx actually lands
 * (spec §7.1). The .catch(() => {}) preload convention is NOT used here:
 * a real load failure must surface as a named parse error, not silence. */
export async function readSpreadsheet(file: File): Promise<string> {
  const XLSX = await import('xlsx');
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: 'array' });
  const first = wb.SheetNames[0];
  const sheet = first == null ? undefined : wb.Sheets[first];
  if (!sheet) throw new Error('That workbook has no sheets to read.');
  return XLSX.utils.sheet_to_csv(sheet);
}
