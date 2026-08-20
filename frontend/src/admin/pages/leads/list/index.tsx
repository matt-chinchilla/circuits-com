// Placeholder — Lane B replaces this with the call checklist.
import CatalogSwitch from '../../manufacturers/CatalogSwitch';

export default function LeadsPage() {
  return (
    <div style={{ position: 'relative', paddingTop: 4 }}>
      <div style={{ position: 'relative', minHeight: 46 }}>
        <h1 style={{ margin: 0 }}>Leads</h1>
        <CatalogSwitch />
      </div>
      <p>Loading call list…</p>
    </div>
  );
}
