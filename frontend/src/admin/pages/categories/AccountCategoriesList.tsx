// /account/categories — where this account's catalog actually sits.
//
// FLAT, and count-ordered: the staff tree is the taxonomy (15 parents, 75
// children, every node whether or not anything hangs off it), while this list
// answers "where are my parts". Categories holding none of them are absent
// rather than listed at zero, so a tree rebuilt client-side would be mostly
// empty branches drawn around a handful of leaves. The server already sorts
// count DESC — the busiest category is the answer to the question.
//
// `parts_count` is the caller's SLICE of the category, never its total: a
// distributor carrying three of a subcategory's four parts sees 3.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Link2Off, PackageSearch } from 'lucide-react';

import Breadcrumbs from '@admin/components/Breadcrumbs';
import { useAuth } from '@admin/contexts/AuthContext';
import { accountApi } from '@admin/services/accountApi';
import { useConsolePath } from '@admin/services/consolePath';
import type { AccountCategory } from '@admin/types/account';
import Icon from '@shared/components/Icon';
import { categoryPath } from '@shared/utils/categoryPath';

import { AccountNotice, STAFF_LINKS_ACCOUNTS } from '../manufacturers/AccountCompany';
import styles from './CategoriesPage.module.scss';

export default function AccountCategoriesList() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const { isCustomer, account } = useAuth();
  const linked =
    isCustomer && (account?.is_supplier === true || account?.is_manufacturer === true);

  const [categories, setCategories] = useState<AccountCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    accountApi
      .getAccountCategories()
      .then((res) => {
        if (cancelled) return;
        setCategories(res.categories);
        setError('');
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[AccountCategoriesList] load failed', err);
        setError('Failed to load your categories.');
        setCategories([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const totalParts = categories.reduce((n, c) => n + c.parts_count, 0);

  const head = (
    <div className={styles.head}>
      <div className={styles.headText}>
        <h1 className={styles.title}>Categories</h1>
        <p className={styles.subtitle}>
          {categories.length === 0 ? (
            'Where your parts sit in the catalog.'
          ) : (
            <>
              {categories.length} categories hold your parts &middot;{' '}
              <span className={styles.mono}>{totalParts.toLocaleString('en-US')}</span> parts
              indexed
            </>
          )}
        </p>
      </div>
    </div>
  );

  if (loading) {
    return <div className={styles.loading}>{'Loading categories…'}</div>;
  }

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[{ label: 'Dashboard', href: consolePath('/admin') }, { label: 'Categories' }]}
      />
      {head}

      {error && (
        <AccountNotice title="Could not load your categories" body={error} />
      )}

      {!error && categories.length === 0 && !linked && (
        <AccountNotice
          icon={<Link2Off size={20} strokeWidth={1.6} />}
          title="No catalog linked yet"
          body="This page shows the categories your parts appear in, which needs your account linked to the company that supplies or makes them."
          hint={STAFF_LINKS_ACCOUNTS}
        />
      )}

      {!error && categories.length === 0 && linked && (
        <AccountNotice
          icon={<PackageSearch size={20} strokeWidth={1.6} />}
          title="None of your parts are indexed yet"
          body="As soon as one of your parts lands in the catalog, the category it sits in appears here with your count."
        />
      )}

      {!error && categories.length > 0 && (
        <div className={styles.catGrid}>
          {categories.map((c) => (
            <Link
              key={c.id}
              to={categoryPath(c.slug, c.parent_slug)}
              className={`${styles.catCard} ${styles.catCardLink}`}
            >
              <div className={styles.catIcon}>
                <Icon name={c.icon} />
              </div>
              {c.parent_name && <div className={styles.catParent}>{c.parent_name}</div>}
              <div className={styles.catName}>{c.name}</div>
              <div className={styles.catSlug}>{c.slug}</div>
              <div className={styles.catStats}>
                <span className={styles.mono}>{c.parts_count.toLocaleString('en-US')}</span> of
                your parts
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
