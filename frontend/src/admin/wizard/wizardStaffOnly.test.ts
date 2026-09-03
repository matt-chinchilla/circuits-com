import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The guided-tour wizard is STAFF tooling. AdminLayout is the chrome for BOTH
 * consoles (D16), so without a gate a customer at /account is offered tours
 * that teach the internal catalog and whose steps navigate to /admin routes
 * ProtectedRoute bounces them out of.
 *
 * This harness has no renderer, so the gate is asserted against the source —
 * which is the right level anyway: what must hold is that the module entry
 * every mount imports is the GATED one.
 */
const entry = readFileSync(fileURLToPath(new URL('./index.tsx', import.meta.url)), 'utf8');
const layout = readFileSync(
  fileURLToPath(new URL('../components/AdminLayout.tsx', import.meta.url)),
  'utf8',
);

describe('the wizard entry is staff-gated', () => {
  it('checks isStaff — and refuses a read-only viewer — before rendering', () => {
    // Every tour is a create-flow; a `viewer` (alembic 051) would hit
    // 403 read_only at the first Save, so the gate is ACTING staff.
    expect(entry).toContain("import { isReadOnly, isStaff } from '@admin/services/permissions';");
    expect(entry).toMatch(/if\s*\(!isStaff\(user\)\s*\|\|\s*isReadOnly\(user\)\)\s*return null;/);
  });

  it('does not re-export WizardApp raw', () => {
    // `export { default as Wizard } from './WizardApp'` was the shipped entry:
    // it hands every mount the ungated component.
    expect(entry).not.toMatch(/export\s*\{[^}]*\}\s*from\s*'\.\/WizardApp'/);
  });
});

describe('AdminLayout mounts the gated entry', () => {
  it('imports the wizard from its module entry, not from WizardApp', () => {
    expect(layout).toContain("import { Wizard } from '@admin/wizard';");
    expect(layout).not.toContain('wizard/WizardApp');
  });
});
