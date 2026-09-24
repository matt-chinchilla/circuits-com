// Source witness for the call list's "Add lead" button gate. The leads table is
// mounted under /account as well as /admin (ConsoleRoutes), so a customer can
// reach this page by URL: the server answers 403 staff_only (classified as an
// ordinary failure, not the quiet blocked panel), and the button must not sit
// beside that error leading to a page with nothing to add.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tsx = readFileSync(join(__dirname, 'index.tsx'), 'utf8');

describe('the Add lead button', () => {
  it('is hidden for view-only accounts AND customers', () => {
    const at = tsx.indexOf("consolePath('/admin/leads/new')");
    expect(at).toBeGreaterThan(0);
    const gate = tsx.slice(tsx.lastIndexOf('{', tsx.lastIndexOf('&& (', at)), at);
    expect(gate).toMatch(/!isReadOnly/);
    expect(gate).toMatch(/!isCustomer/);
    expect(tsx).toMatch(/const \{[^}]*\bisCustomer\b[^}]*\} = useAuth\(\)/);
  });
});
