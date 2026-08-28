// /account/suppliers — the distributors selling THIS manufacturer's products.
//
// Same URL as the staff Suppliers list, a different question: staff see every
// distributor in the catalog, a customer sees only the shelves their own parts
// sit on. `parts_count` is the count of THE CALLER'S parts that distributor
// lists, never the size of that distributor's shelf — the label says so,
// because a bare number in this column would read as inventory we carry.
//
// Read on the manufacturer link (the other side of pair A is /my-supply), so
// an account with no manufacturer link is not making a request whose answer it
// already has: the endpoint returns an empty list rather than an error, and
// the honest screen for it is the notice, not a blank grid.

import { useEffect, useState } from 'react';
import { Link2Off, PackageSearch } from 'lucide-react';

import { useAuth } from '@admin/contexts/AuthContext';
import { accountApi } from '@admin/services/accountApi';
import { useConsolePath } from '@admin/services/consolePath';
import type { AccountSupplier } from '@admin/types/account';
import { lettermark } from '@shared/utils/lettermark';
import { safeHttpUrl, safeImageUrl } from '@shared/utils/url';

import CatalogSwitch from '../../manufacturers/CatalogSwitch';
import { AccountNotice, STAFF_LINKS_ACCOUNTS } from '../../manufacturers/AccountCompany';
import { supplyPair } from '../../manufacturers/accountPairs';
import { stripScheme } from '../../manufacturers/supplierLink';
import styles from './SuppliersPage.module.scss';

export default function AccountSuppliersList() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const { isCustomer, account } = useAuth();
  const isSupplier = isCustomer && account?.is_supplier === true;
  const isManufacturer = isCustomer && account?.is_manufacturer === true;

  const [suppliers, setSuppliers] = useState<AccountSupplier[]>([]);
  const [loading, setLoading] = useState(isManufacturer);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isManufacturer) {
      setSuppliers([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    accountApi
      .getAccountSuppliers()
      .then((res) => {
        if (cancelled) return;
        setSuppliers(res.suppliers);
        setError('');
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[AccountSuppliersList] load failed', err);
        setError('Failed to load the distributors selling your products.');
        setSuppliers([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isManufacturer]);

  const head = (
    <div className={`${styles.pageHead} ${styles.pageHeadSwitch}`}>
      <div className={styles.pageHeadLeft}>
        <h1 className={styles.title}>Suppliers</h1>
        <p className={styles.subtitle}>
          {isManufacturer && !loading && !error
            ? `${suppliers.length.toLocaleString('en-US')} distributors sell your products`
            : 'Distributors selling your products'}
        </p>
      </div>
      <CatalogSwitch
        halves={supplyPair(consolePath, isSupplier, isManufacturer)}
        ariaLabel="Supply view"
      />
    </div>
  );

  if (!isManufacturer) {
    return (
      <div className={styles.page}>
        {head}
        <AccountNotice
          icon={<Link2Off size={20} strokeWidth={1.6} />}
          title="No manufacturer linked"
          body="This page lists the distributors selling your products, which needs your account linked to a manufacturer."
          hint={STAFF_LINKS_ACCOUNTS}
        />
      </div>
    );
  }

  if (!loading && !error && suppliers.length === 0) {
    return (
      <div className={styles.page}>
        {head}
        <AccountNotice
          icon={<PackageSearch size={20} strokeWidth={1.6} />}
          title="No distributor stocks your parts yet"
          body="As soon as a distributor lists one of your parts, their shelf appears here with the count of your parts on it."
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {head}

      <div className={styles.panel}>
        <div className={styles.supGrid}>
          {loading && <div className={styles.empty}>{'Loading distributors…'}</div>}
          {!loading && error && <div className={styles.error}>{error}</div>}
          {!loading &&
            !error &&
            suppliers.map((supplier) => {
              const logoSrc = safeImageUrl(supplier.logo_url);
              const site = supplier.website ? safeHttpUrl(supplier.website) : null;
              return (
                <article
                  key={supplier.id}
                  className={`${styles.supCard} ${styles.supCardStatic}`}
                >
                  <div className={styles.supHead}>
                    <div className={styles.supLogo}>
                      {logoSrc ? (
                        <img className={styles.avatarImg} src={logoSrc} alt="" />
                      ) : (
                        <span>{lettermark(supplier.name)}</span>
                      )}
                    </div>
                    <div className={styles.supHeadBody}>
                      <h3 className={styles.supName}>{supplier.name}</h3>
                      {supplier.website ? (
                        site ? (
                          <a
                            className={styles.supSite}
                            href={site}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {stripScheme(supplier.website)}
                          </a>
                        ) : (
                          // safeHttpUrl rejected it — stored text, never a link.
                          <span className={styles.supSiteMuted}>
                            {stripScheme(supplier.website)}
                          </span>
                        )
                      ) : (
                        <span className={styles.supSiteMuted}>No website on file</span>
                      )}
                    </div>
                  </div>
                  <p className={styles.supDesc}>
                    {supplier.description?.trim() || 'No description provided.'}
                  </p>
                  <div className={styles.supMeta}>
                    <span className={styles.mono}>
                      {supplier.parts_count.toLocaleString('en-US')}
                    </span>
                    <span>of your parts stocked</span>
                  </div>
                </article>
              );
            })}
        </div>
      </div>
    </div>
  );
}
