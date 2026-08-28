// The customer console's own-company kit — the shell, the card and the empty
// state behind /account/my-supply and /account/my-manufacturing.
//
// Co-owned by the two `my-*` pages, like CatalogSwitch and TableSearch are
// co-owned by the two lists, and it lives beside them for the same reason: one
// company card rendered from two page directories, so a fix cannot land on the
// distributor's page and miss the manufacturer's. `AccountNotice` is imported
// more widely still — every customer surface that can legitimately have
// nothing to show renders it, so the sentence explaining WHY has one home.
//
// Nothing here is editable. There is no account-side write endpoint for a
// company row, so the card states plainly who maintains it rather than
// offering a control the API would refuse.

import type { ReactNode } from 'react';
import { lettermark } from '@shared/utils/lettermark';
import { safeHttpUrl, safeImageUrl } from '@shared/utils/url';
import type { AccountTier } from '@admin/types/account';

import CatalogSwitch, { type CatalogSwitchHalf } from './CatalogSwitch';
import { stripScheme } from './supplierLink';
import styles from './AccountCompany.module.scss';

/**
 * The one sentence that explains an unlinked account, wherever it surfaces.
 * Staff do the linking — a customer cannot fix this from the console, so the
 * copy points at the only thing that can.
 */
export const STAFF_LINKS_ACCOUNTS =
  'Circuit Center staff link an account to its company. Message us and we will connect yours.';

interface MyCompanyShellProps {
  title: string;
  subtitle: string;
  /** Only the halves this account holds a link for; one half renders none. */
  halves: CatalogSwitchHalf[];
  switchLabel: string;
  children: ReactNode;
}

/** Page frame: title block, the centered pair switch, and the body below. */
export function MyCompanyShell({
  title,
  subtitle,
  halves,
  switchLabel,
  children,
}: MyCompanyShellProps) {
  return (
    <div className={styles.page}>
      {/* position:relative + a floor height so the absolutely centered switch
          sits ON the title row rather than pushing it around. */}
      <header className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </div>
        <CatalogSwitch halves={halves} ariaLabel={switchLabel} />
      </header>
      {children}
    </div>
  );
}

const TIER_LABEL: Record<AccountTier, string> = {
  free: 'No active sponsorship',
  silver: 'Silver',
  gold: 'Gold',
  platinum: 'Platinum',
};

interface MyCompanyCardProps {
  name: string;
  logoUrl: string | null;
  website: string | null;
  /** Only the supplier row carries one; the maker row has no description. */
  description?: string | null;
  partsCount: number;
  /** What the count MEANS here — parts stocked vs. parts made. */
  partsLabel: string;
  /**
   * The account's tier, derived from the highest ACTIVE sponsorship its linked
   * supplier holds. Labelled "Account tier" rather than dropped onto the
   * company, because a manufacturer cannot hold a placement today.
   */
  tier?: AccountTier | null;
}

export function MyCompanyCard({
  name,
  logoUrl,
  website,
  description,
  partsCount,
  partsLabel,
  tier,
}: MyCompanyCardProps) {
  // Both guards are the stored-value ones: a logo may legitimately BE a
  // data-URL (uploads), an external site may not.
  const logoSrc = safeImageUrl(logoUrl);
  const site = website ? safeHttpUrl(website) : null;
  const desc = description?.trim();
  const tierLabel = TIER_LABEL[tier ?? 'free'];

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <div className={styles.logo}>
          {logoSrc ? (
            <img className={styles.logoImg} src={logoSrc} alt="" />
          ) : (
            <span>{lettermark(name)}</span>
          )}
        </div>
        <div className={styles.headBody}>
          <h2 className={styles.name}>{name}</h2>
          {website ? (
            site ? (
              <a className={styles.site} href={site} target="_blank" rel="noopener noreferrer">
                {stripScheme(website)}
              </a>
            ) : (
              // safeHttpUrl rejected it — show the stored text, never link it.
              <span className={styles.siteMuted}>{stripScheme(website)}</span>
            )
          ) : (
            <span className={styles.siteMuted}>No website on file</span>
          )}
        </div>
        {tier && tier !== 'free' && (
          <span className={styles.tierPill} data-tier={tier}>
            {tierLabel}
          </span>
        )}
      </div>

      {desc && <p className={styles.desc}>{desc}</p>}

      {/* dt before dd is the only legal order; `.stat` reverses the column so
          the figure still reads above its label. */}
      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>{partsLabel}</dt>
          <dd className={styles.statNum}>{partsCount.toLocaleString('en-US')}</dd>
        </div>
        <div className={styles.stat}>
          <dt className={styles.statLabel}>Account tier</dt>
          <dd className={styles.statWord}>{tierLabel}</dd>
        </div>
      </dl>

      <p className={styles.cardFoot}>
        Circuit Center maintains these company details. Message us to change anything here.
      </p>
    </section>
  );
}

interface AccountNoticeProps {
  /** A lucide glyph from the calling page — this component stays dumb about
   *  which state it is illustrating. */
  icon?: ReactNode;
  title: string;
  body: string;
  /** `STAFF_LINKS_ACCOUNTS` where the state is "no link yet", nothing where
   *  the account IS linked and simply has nothing to show. */
  hint?: string;
}

/** The designed empty state — never an error card, because an unlinked or
 *  empty account is a supported state rather than a failure. */
export function AccountNotice({ icon, title, body, hint }: AccountNoticeProps) {
  return (
    <div className={styles.notice}>
      {icon && (
        <span className={styles.noticeIcon} aria-hidden="true">
          {icon}
        </span>
      )}
      <h2 className={styles.noticeTitle}>{title}</h2>
      <p className={styles.noticeBody}>{body}</p>
      {hint && <p className={styles.noticeHint}>{hint}</p>}
    </div>
  );
}

/** Busy line for a single-card page, where a skeleton would out-weigh it. */
export function AccountBusy({ label }: { label: string }) {
  return (
    <p className={styles.busy} role="status">
      {label}
    </p>
  );
}
