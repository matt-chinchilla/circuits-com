// LeadsPanel (customer) — the businesses THEY want to sell to.
//
// The staff panel of this name is the outreach checklist for Circuit Center's
// own sales desk (and it is the one payload the server refuses for the demo
// account). This is the mirror image: the customer's own rows, which start
// empty for everybody, so the empty state is an invitation rather than an
// apology.
//
// Deliberately read-only and deliberately small — five rows and a count. The
// CRM itself is its own screen; this is the window onto it.

import type { AccountLeadsSummary } from '@admin/types/account';
import { count } from '../format';
import styles from '../../DashboardPage.module.scss';
import own from './CustomerPanels.module.scss';

interface LeadsPanelProps {
  summary: AccountLeadsSummary | null;
  loading: boolean;
}

export default function LeadsPanel({ summary, loading }: LeadsPanelProps) {
  const recent = summary?.recent ?? [];
  const total = Number(summary?.total) || 0;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div className={styles.panelHeadMain}>
          <h3 className={styles.panelTitle}>Leads</h3>
          <p className={styles.panelSub}>Businesses you want to sell to</p>
        </div>
        {total > 0 && <span className={styles.leadsChip}>{count(total)} total</span>}
      </div>
      {recent.length === 0 ? (
        <div className={styles.empty}>
          {loading
            ? 'Checking your leads…'
            : 'No leads yet — this is where the businesses you want to sell to will live.'}
        </div>
      ) : (
        <div className={own.leadList}>
          {recent.map((lead, index) => (
            // Index-keyed: two prospects can share a company name, and the row
            // carries no id of its own.
            <div key={`${lead.name}-${index}`} className={own.leadRow}>
              <span className={own.leadName}>{lead.name}</span>
              {lead.status != null && lead.status !== '' && (
                <span className={own.leadStatus}>{lead.status}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
