// /account/manufacturers — the makers whose products THIS distributor sells.
//
// The staff roster on this URL is a 1,800-row CRM with server-side filtering,
// sorting and paging. This is not that list: it is the caller's own shelf read
// through `part_listings` -> `parts.manufacturer_id`, it arrives complete in
// one response, and it carries none of the roster's provenance — `source`,
// external coverage, merge candidates and the supplier bridge are sales data
// about companies we are selling TO, and none of it belongs to a customer.
//
// So the columns are the three facts that are theirs: who the maker is, where
// to find them, and how many of that maker's parts sit on this shelf.

import { useEffect, useState } from 'react';
import { Factory, Link2Off } from 'lucide-react';

import { useAuth } from '@admin/contexts/AuthContext';
import { accountApi } from '@admin/services/accountApi';
import { useConsolePath } from '@admin/services/consolePath';
import type { AccountManufacturer } from '@admin/types/account';
import { lettermark } from '@shared/utils/lettermark';
import { safeHttpUrl, safeImageUrl } from '@shared/utils/url';

import CatalogSwitch from '../CatalogSwitch';
import { AccountNotice, STAFF_LINKS_ACCOUNTS } from '../AccountCompany';
import { manufacturingPair } from '../accountPairs';
import { stripScheme } from '../supplierLink';
import styles from './ManufacturersPage.module.scss';

const SKELETON_INDEXES = [0, 1, 2, 3, 4, 5];

export default function AccountManufacturersList() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const { isCustomer, account } = useAuth();
  const isSupplier = isCustomer && account?.is_supplier === true;
  const isManufacturer = isCustomer && account?.is_manufacturer === true;

  const [rows, setRows] = useState<AccountManufacturer[]>([]);
  const [loading, setLoading] = useState(isSupplier);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isSupplier) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    accountApi
      .getAccountManufacturers()
      .then((res) => {
        if (cancelled) return;
        setRows(res.manufacturers);
        setError('');
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[AccountManufacturersList] load failed', err);
        setError('Failed to load the manufacturers on your shelf.');
        setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSupplier]);

  const head = (
    <header className={styles.pageHead}>
      <div className={styles.pageHeadLeft}>
        <h1 className={styles.title}>Manufacturers</h1>
        <p className={styles.subtitle}>
          {isSupplier && !loading && !error
            ? `${rows.length.toLocaleString('en-US')} makers whose parts you stock`
            : 'The makers whose products you sell.'}
        </p>
      </div>
      <CatalogSwitch
        halves={manufacturingPair(consolePath, isSupplier, isManufacturer)}
        ariaLabel="Manufacturing view"
      />
    </header>
  );

  if (!isSupplier) {
    return (
      <div className={styles.page}>
        {head}
        <AccountNotice
          icon={<Link2Off size={20} strokeWidth={1.6} />}
          title="No distributor linked"
          body="This page lists the makers whose products you sell, which needs your account linked to a distributor."
          hint={STAFF_LINKS_ACCOUNTS}
        />
      </div>
    );
  }

  if (!loading && !error && rows.length === 0) {
    return (
      <div className={styles.page}>
        {head}
        <AccountNotice
          icon={<Factory size={20} strokeWidth={1.6} />}
          title="No manufacturers on your shelf yet"
          body="Every part you list is credited to its manufacturer, and each of those makers appears here with the count of their parts you stock."
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {head}

      <div className={styles.panel}>
        <div className={styles.tableWrap}>
          <table className={`${styles.table} ${styles.tableCustomer}`}>
            <thead>
              <tr>
                <th>Manufacturer</th>
                <th>Website</th>
                <th>Parts you stock</th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                SKELETON_INDEXES.map((i) => (
                  <tr key={`skel-${i}`} className={styles.skelRow} aria-hidden="true">
                    <td>
                      <span className={`${styles.skel} ${styles.skelWide}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelMed}`} />
                    </td>
                    <td>
                      <span className={`${styles.skel} ${styles.skelNum}`} />
                    </td>
                  </tr>
                ))}

              {!loading &&
                rows.map((m) => {
                  const logoSrc = safeImageUrl(m.logo_url);
                  const site = m.website ? safeHttpUrl(m.website) : null;
                  return (
                    <tr key={m.id}>
                      <td>
                        <span className={styles.makerCell}>
                          <span className={styles.makerLogo}>
                            {logoSrc ? (
                              <img className={styles.makerLogoImg} src={logoSrc} alt="" />
                            ) : (
                              lettermark(m.name)
                            )}
                          </span>
                          {/* Not a link: a manufacturer's detail page is the
                              staff CRM record, and there is no public one. */}
                          <span className={styles.makerName}>{m.name}</span>
                        </span>
                      </td>
                      <td className={styles.siteCell}>
                        {m.website ? (
                          site ? (
                            <a
                              href={site}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={styles.siteLink}
                            >
                              {stripScheme(m.website)}
                            </a>
                          ) : (
                            // safeHttpUrl rejected it — stored text, never a link.
                            <span className={styles.muted}>{stripScheme(m.website)}</span>
                          )
                        ) : (
                          <span className={styles.muted}>&mdash;</span>
                        )}
                      </td>
                      <td className={styles.numCell}>{m.parts_count.toLocaleString('en-US')}</td>
                    </tr>
                  );
                })}

              {!loading && error && (
                <tr>
                  <td colSpan={3} className={styles.emptyRow}>
                    {error}
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
