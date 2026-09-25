// @vitest-environment happy-dom
/**
 * FindContacts — rendered, with the api stubbed. Owner, 2026-09-25: "prevent
 * people from searching companies that have already been searched for". The
 * server enforces it (test_lead_enrichment.py::TestTheBlock); what THIS file
 * proves is that the panel opens on the free stored read, never on a search,
 * and that a stored company offers no button to search it again.
 *
 * No JSX — a `*.test.ts` is excluded from `tsc -b`/eslint per CLAUDE.md.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminLeadDetail, EnrichmentKind, LeadEnrichment } from '@admin/types/leads';

const getLeadEnrichmentStatus = vi.fn();
const getLeadEnrichment = vi.fn();
const searchLeadEnrichment = vi.fn();

vi.mock('@admin/services/adminApi', () => ({
  adminApi: {
    getLeadEnrichmentStatus: (...a: unknown[]) => getLeadEnrichmentStatus(...a),
    getLeadEnrichment: (...a: unknown[]) => getLeadEnrichment(...a),
    searchLeadEnrichment: (...a: unknown[]) => searchLeadEnrichment(...a),
    updateLead: vi.fn(),
    createLead: vi.fn(),
  },
}));

const { default: FindContacts } = await import('./FindContacts');

const LEAD = {
  id: 'lead-1',
  company_name: 'FDH Electronics',
  contact_name: 'Ian Locke',
  contact_title: null,
  contact_email: null,
  direct_phone: null,
  linkedin_url: null,
  website: 'fdh.com',
  sales_email: null,
  manufacturer_id: null,
} as unknown as AdminLeadDetail;

function answer(pending: EnrichmentKind[], stored: boolean): LeadEnrichment {
  return {
    provider: 'hunter',
    configured: true,
    lead_id: 'lead-1',
    domain: 'fdh.com',
    domain_source: 'website',
    searched: pending.length === 0,
    pending,
    searched_by: stored ? 'anthony' : null,
    searched_at: stored ? '2026-09-25T15:00:00+00:00' : null,
    organization: stored ? 'FDH' : null,
    pattern: stored ? '{first}' : null,
    candidates: stored
      ? [
          {
            first_name: 'Ciaran',
            last_name: 'Lee',
            full_name: 'Ciaran Lee',
            email: 'ciaran@fdh.com',
            position: null,
            phone: null,
            linkedin_url: null,
            confidence: 90,
            verification: 'valid',
            kind: 'personal',
            source: 'hunter',
            existing_lead_id: null,
          },
        ]
      : [],
    contact_email_suggestion: null,
    suggestion_error: null,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(
        MemoryRouter,
        null,
        createElement(FindContacts, {
          lead: LEAD,
          viewer: 'matthew',
          onApplied: vi.fn(),
          onSessionExpired: vi.fn(),
        }),
      ),
    );
  });
  await flush();
  return host;
}

const buttons = (el: HTMLElement) => [...el.querySelectorAll('button')].map((b) => b.textContent);

beforeEach(() => {
  getLeadEnrichmentStatus.mockReset().mockResolvedValue({ configured: true, provider: 'hunter' });
  getLeadEnrichment.mockReset();
  searchLeadEnrichment.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
});

describe('FindContacts', () => {
  it('opens on the stored answer and offers NO search once the company is stored', async () => {
    getLeadEnrichment.mockResolvedValue(answer([], true));
    const el = await render();
    expect(getLeadEnrichment).toHaveBeenCalledTimes(1);
    expect(searchLeadEnrichment).not.toHaveBeenCalled();
    expect(el.textContent).toContain('ciaran@fdh.com');
    expect(el.querySelector('[data-searched-note]')?.textContent).toBe(
      'Searched Sep 25, 2026 by anthony',
    );
    expect(buttons(el).some((t) => t?.includes('Search Hunter'))).toBe(false);
    expect(buttons(el).some((t) => t?.includes('Look up'))).toBe(false);
  });

  it('offers the search on an unsearched company, and the click is the only spend', async () => {
    getLeadEnrichment.mockResolvedValue(answer(['domain-search'], false));
    searchLeadEnrichment.mockResolvedValue(answer([], true));
    const el = await render();
    expect(searchLeadEnrichment).not.toHaveBeenCalled();
    const search = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Search Hunter');
    expect(search).toBeDefined();
    await act(async () => {
      search!.click();
    });
    await flush();
    expect(searchLeadEnrichment).toHaveBeenCalledTimes(1);
    expect(searchLeadEnrichment).toHaveBeenCalledWith('lead-1');
    expect(el.textContent).toContain('ciaran@fdh.com');
    expect(buttons(el).some((t) => t?.includes('Search Hunter'))).toBe(false);
  });

  it('shows a stored company and offers only the new person on a branch row', async () => {
    getLeadEnrichment.mockResolvedValue(answer(['email-finder'], true));
    const el = await render();
    expect(el.textContent).toContain('ciaran@fdh.com');
    expect(buttons(el)).toContain('Look up Ian Locke’s address');
    expect(buttons(el).some((t) => t?.includes('Search Hunter'))).toBe(false);
  });

  it('renders nothing when the server has no Hunter key', async () => {
    getLeadEnrichmentStatus.mockReset().mockRejectedValue(new Error('404'));
    const el = await render();
    expect(el.textContent).toBe('');
    expect(getLeadEnrichment).not.toHaveBeenCalled();
  });
});
