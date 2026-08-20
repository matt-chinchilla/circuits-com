// Placeholder — Lane A replaces this with the sponsors-table pattern list.
import CatalogSwitch from '../CatalogSwitch';

export default function ManufacturersPage() {
  return (
    <div style={{ position: 'relative', paddingTop: 4 }}>
      <div style={{ position: 'relative', minHeight: 46 }}>
        <h1 style={{ margin: 0 }}>Manufacturers</h1>
        <CatalogSwitch />
      </div>
      <p>Loading directory…</p>
    </div>
  );
}
