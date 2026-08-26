// Per-rep activity — every call one person recorded, newest first.
//
// Reached from a `recorded_by` name in a lead's contact history, so the
// username is a PATH segment. It is passed to the API exactly as routed (the
// server matches `LeadContact.recorded_by == username`); an unknown name is
// not an error, it is simply an empty list — which is also what a typo looks
// like, so the empty state says so rather than claiming the rep made no calls.

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';

import Breadcrumbs from '@admin/components/Breadcrumbs';
import { useAuth } from '@admin/contexts/AuthContext';
import { adminApi } from '@admin/services/adminApi';
import type { RepActivity } from '@admin/types/leads';

import { classifyLeadsError, SESSION_EXPIRED_MESSAGE } from '../loadError';
import { OUTCOME_META, OUTCOME_ORDER, outcomeInkVars } from '../outcome';
import { parseServerTime } from '../time';
import OutcomeDisc from '../OutcomeDisc';
import styles from './RepPage.module.scss';

function formatStamp(iso: string): string {
  const d = new Date(parseServerTime(iso));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function RepPage() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const { username } = useParams<{ username: string }>();

  const [activity, setActivity] = useState<RepActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [demoBlocked, setDemoBlocked] = useState(false);
  // A 401 — see ../loadError.ts.
  const [sessionExpired, setSessionExpired] = useState(false);
  const { logout } = useAuth();

  useEffect(() => {
    if (!username) return undefined;
    let cancelled = false;
    setLoading(true);
    adminApi
      .getRepActivity(username)
      .then((res) => {
        if (cancelled) return;
        setActivity(res);
        setError('');
      })
      .catch((err) => {
        if (cancelled) return;
        const failure = classifyLeadsError(err, 'Could not load this rep\u2019s activity.');
        setDemoBlocked(failure.kind === 'demo');
        setSessionExpired(failure.kind === 'session');
        setError(failure.kind === 'failed' ? failure.message : '');
        if (failure.kind === 'failed') console.error('[RepPage] load failed', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  // Same recovery as the list and the profile: clear the session the 401 proved
  // dead so ProtectedRoute can bounce to the sign-in screen.
  useEffect(() => {
    if (!sessionExpired) return;
    if (localStorage.getItem('admin_token') === null) logout();
  }, [sessionExpired, logout]);

  const crumbs = (
    <Breadcrumbs
      items={[{ label: 'Leads', href: consolePath('/admin/leads') }, { label: username ?? 'Sales rep' }]}
    />
  );

  if (sessionExpired) {
    return (
      <div className={styles.page}>
        {crumbs}
        <div className={styles.panel}>
          <div className={styles.blockedPanel}>
            <p className={styles.blockedTitle}>Signed out</p>
            <p className={styles.blockedBody}>{SESSION_EXPIRED_MESSAGE}</p>
          </div>
        </div>
      </div>
    );
  }

  if (demoBlocked) {
    return (
      <div className={styles.page}>
        {crumbs}
        <div className={styles.panel}>
          <div className={styles.blockedPanel}>
            <p className={styles.blockedTitle}>Not available in demo</p>
            <p className={styles.blockedBody}>
              Call activity names real people and real companies, so the demo account is refused at
              the API.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className={styles.loading}>Loading activity…</div>;
  }

  if (error || !activity) {
    return (
      <div className={styles.page}>
        {crumbs}
        <div className={styles.errorPanel}>{error || 'No activity found.'}</div>
      </div>
    );
  }

  const total = OUTCOME_ORDER.reduce((sum, key) => sum + (activity.outcome_mix[key] ?? 0), 0);

  return (
    <div className={styles.page}>
      {crumbs}

      <header className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1 className={styles.title}>Calls by {activity.username}</h1>
          <p className={styles.subtitle}>
            {total.toLocaleString('en-US')} {total === 1 ? 'outcome' : 'outcomes'} recorded
            &mdash;{' '}
            {activity.contacts.length < total
              ? `showing the newest ${activity.contacts.length.toLocaleString('en-US')}.`
              : 'newest first.'}
          </p>
        </div>
      </header>

      {/* Outcome mix. Three counts, each with its WORD — the colour is a
          second channel, never the only one (the CVD rule in outcome.ts). A
          zero is shown rather than hidden: "no rejections yet" is information. */}
      <div className={styles.mixRow}>
        {OUTCOME_ORDER.map((key) => {
          const meta = OUTCOME_META[key];
          const count = activity.outcome_mix[key] ?? 0;
          return (
            <div key={key} className={styles.mixCard} style={{ borderTopColor: meta.hex }}>
              <span className={styles.mixCount} style={outcomeInkVars(meta)}>
                {count.toLocaleString('en-US')}
              </span>
              <span className={styles.mixWord} style={outcomeInkVars(meta)}>
                <span aria-hidden="true">{meta.glyph}</span>
                {meta.word}
              </span>
            </div>
          );
        })}
      </div>

      <div className={styles.panel}>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.discHead}>
                  <span className={styles.srOnly}>Outcome</span>
                </th>
                <th>Company</th>
                <th>Contact</th>
                <th>Outcome</th>
                <th>Tier</th>
                <th>Note</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {activity.contacts.map((c) => {
                const meta = OUTCOME_META[c.outcome];
                return (
                  <tr key={c.id}>
                    <td className={styles.discCell}>
                      <OutcomeDisc
                        outcome={c.outcome}
                        contactName={c.contact_name}
                        size={22}
                      />
                    </td>
                    <td>
                      <Link to={consolePath(`/admin/leads/${c.lead_id}`)} className={styles.leadLink}>
                        {c.company_name ?? 'Lead'}
                      </Link>
                    </td>
                    <td>
                      {c.contact_name ?? <span className={styles.muted}>&mdash;</span>}
                    </td>
                    <td>
                      <span className={styles.outcomeText} style={outcomeInkVars(meta)}>
                        <span aria-hidden="true">{meta.glyph}</span>
                        {meta.word}
                      </span>
                    </td>
                    <td>
                      {c.sale_tier ? (
                        <span className={styles.tierLabel}>{c.sale_tier}</span>
                      ) : (
                        <span className={styles.muted}>&mdash;</span>
                      )}
                    </td>
                    <td className={styles.noteCell}>
                      {c.note ?? <span className={styles.muted}>&mdash;</span>}
                    </td>
                    <td className={styles.whenCell}>{formatStamp(c.created_at)}</td>
                  </tr>
                );
              })}

              {activity.contacts.length === 0 && (
                <tr>
                  <td colSpan={7} className={styles.emptyRow}>
                    No calls recorded under &ldquo;{activity.username}&rdquo;. Check the spelling &mdash; this
                    page matches the recorded name exactly.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
