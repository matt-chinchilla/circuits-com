// /account/categories — where this account's catalog actually sits.
//
// The SAME page staff open, drawn from a narrower question. Staff get the
// taxonomy: the whole two-level tree, every node whether or not anything hangs
// off it. A customer gets only the categories their own parts appear in, and
// `parts_count` is the caller's SLICE of each one — a distributor carrying
// three of a subcategory's four parts sees 3. That is the only difference:
// the head, the tree/grid toggle, the search toolbar and the blocks below are
// the staff page's, class for class, so the two renders read as one page.
//
// The server sends those categories FLAT (each subcategory carrying its
// parent's id/name/slug/icon), so the two levels are rebuilt client-side in
// `accountCategoryTree.ts` — pure, and tested there rather than here.
//
// Omitted from the staff body, and only these: the disabled "Add Category"
// button (categories are seeded, and a customer manages none of them) and the
// featured-supplier strips (sponsorship is staff/sales data the account
// contract does not carry).

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  Grid as GridIcon,
  Link2Off,
  List,
  PackageSearch,
  Search,
} from 'lucide-react';

import Breadcrumbs from '@admin/components/Breadcrumbs';
import { useAuth } from '@admin/contexts/AuthContext';
import { accountApi } from '@admin/services/accountApi';
import { useConsolePath } from '@admin/services/consolePath';
import Icon from '@shared/components/Icon';
import { categoryPath } from '@shared/utils/categoryPath';

import { AccountNotice, STAFF_LINKS_ACCOUNTS } from '../manufacturers/AccountCompany';
import {
  filterAccountCategoryTree,
  groupAccountCategories,
  type AccountCategoryNode,
} from './accountCategoryTree';
import styles from './CategoriesPage.module.scss';

type ViewMode = 'tree' | 'grid';

const num = (n: number) => n.toLocaleString('en-US');

export default function AccountCategoriesList() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const { isCustomer, account } = useAuth();
  const linked =
    isCustomer && (account?.is_supplier === true || account?.is_manufacturer === true);

  const [nodes, setNodes] = useState<AccountCategoryNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ViewMode>('tree');

  useEffect(() => {
    let cancelled = false;
    accountApi
      .getAccountCategories()
      .then((res) => {
        if (cancelled) return;
        const tree = groupAccountCategories(res.categories);
        setNodes(tree);
        setError('');
        // Default-open the first block, as the staff page does.
        if (tree.length > 0) setExpanded(new Set([tree[0].id]));
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[AccountCategoriesList] load failed', err);
        setError('Failed to load your categories.');
        setNodes([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const visible = useMemo(() => filterAccountCategoryTree(nodes, query), [nodes, query]);

  const totalSubs = nodes.reduce((n, c) => n + c.children.length, 0);
  const totalParts = nodes.reduce((n, c) => n + c.parts_count, 0);
  const hasCategories = nodes.length > 0;

  if (loading) {
    return <div className={styles.loading}>{'Loading categories…'}</div>;
  }

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[{ label: 'Dashboard', href: consolePath('/admin') }, { label: 'Categories' }]}
      />

      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Categories</h1>
          <p className={styles.subtitle}>
            {hasCategories ? (
              <>
                {nodes.length} top-level categories &middot; {totalSubs} subcategories &middot;{' '}
                <span className={styles.mono}>{num(totalParts)}</span> of your parts
              </>
            ) : (
              'Where your parts sit in the catalog.'
            )}
          </p>
        </div>
        {hasCategories && (
          <div className={styles.headActions}>
            <div className={styles.seg} role="tablist" aria-label="View mode">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'tree'}
                className={`${styles.segBtn} ${view === 'tree' ? styles.on : ''}`}
                onClick={() => setView('tree')}
              >
                <List />
                Tree
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'grid'}
                className={`${styles.segBtn} ${view === 'grid' ? styles.on : ''}`}
                onClick={() => setView('grid')}
              >
                <GridIcon />
                Grid
              </button>
            </div>
          </div>
        )}
      </div>

      {error && <AccountNotice title="Could not load your categories" body={error} />}

      {!error && !hasCategories && !linked && (
        <AccountNotice
          icon={<Link2Off size={20} strokeWidth={1.6} />}
          title="No catalog linked yet"
          body="This page shows the categories your parts appear in, which needs your account linked to the company that supplies or makes them."
          hint={STAFF_LINKS_ACCOUNTS}
        />
      )}

      {!error && !hasCategories && linked && (
        <AccountNotice
          icon={<PackageSearch size={20} strokeWidth={1.6} />}
          title="None of your parts are indexed yet"
          body="As soon as one of your parts lands in the catalog, the category it sits in appears here with your count."
        />
      )}

      {!error && hasCategories && view === 'tree' && (
        <>
          <div className={styles.toolbar}>
            <div className={styles.search}>
              <Search />
              <input
                type="text"
                placeholder="Filter categories or subcategories..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button
                  type="button"
                  className={styles.searchClear}
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                >
                  &times;
                </button>
              )}
            </div>
            <button
              type="button"
              className={styles.toolbarBtn}
              onClick={() => setExpanded(new Set(nodes.map((c) => c.id)))}
            >
              Expand all
            </button>
            <button
              type="button"
              className={styles.toolbarBtn}
              onClick={() => setExpanded(new Set())}
            >
              Collapse all
            </button>
            <span className={styles.count}>
              {visible.length} / {nodes.length}
            </span>
          </div>

          <div className={styles.treeStack}>
            {visible.length === 0 && (
              <div className={styles.empty}>No categories match &ldquo;{query}&rdquo;</div>
            )}
            {visible.map((c) => {
              // A top-level category the caller holds parts in DIRECTLY has no
              // children here, so there is nothing to expand: its head is the
              // link to the category instead of a toggle. Same markup, same
              // classes — the caret reads as "go" rather than "open".
              const hasChildren = c.children.length > 0;
              const isOpen = hasChildren && (expanded.has(c.id) || c.forceOpen);
              const head = (
                <>
                  <span className={styles.headCaret}>
                    <ChevronRight />
                  </span>
                  <span className={styles.headIcon}><Icon name={c.icon} /></span>
                  <span className={styles.headTitle}>
                    <span className={styles.headName}>{c.name}</span>
                    <span className={styles.headSlug}>{c.slug}</span>
                  </span>
                  <span className={styles.headStats}>
                    <span className={styles.headPill}>
                      <span className={styles.mono}>{c.children.length}</span> subs
                    </span>
                    <span className={styles.headPill}>
                      <span className={styles.mono}>{num(c.parts_count)}</span> parts
                    </span>
                  </span>
                </>
              );
              return (
                <article
                  key={c.id}
                  className={`${styles.catBlock} ${isOpen ? styles.open : ''}`}
                >
                  {hasChildren ? (
                    <button
                      type="button"
                      className={styles.catBlockHead}
                      onClick={() => toggle(c.id)}
                      aria-expanded={isOpen}
                    >
                      {head}
                    </button>
                  ) : (
                    <Link
                      to={categoryPath(c.slug)}
                      className={`${styles.catBlockHead} ${styles.catCardLink}`}
                    >
                      {head}
                    </Link>
                  )}

                  {isOpen && (
                    <div className={styles.subGrid}>
                      {c.children.map((s) => (
                        <Link
                          key={s.id}
                          to={categoryPath(s.slug, c.slug)}
                          className={styles.subTile}
                        >
                          <span className={styles.subIcon}><Icon name={s.icon} /></span>
                          <span className={styles.subName}>{s.name}</span>
                          <span className={styles.subSlug}>{s.slug}</span>
                          <span className={styles.subView}>{num(s.parts_count)} parts &rarr;</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}

      {!error && hasCategories && view === 'grid' && (
        <div className={styles.catGrid}>
          {nodes.map((c) => (
            <Link
              key={c.id}
              to={categoryPath(c.slug)}
              className={`${styles.catCard} ${styles.catCardLink}`}
            >
              <div className={styles.catIcon}><Icon name={c.icon} /></div>
              <div className={styles.catName}>{c.name}</div>
              <div className={styles.catSlug}>{c.slug}</div>
              <div className={styles.catStats}>
                <span className={styles.mono}>{num(c.parts_count)}</span> parts
                <span className={styles.dotSep}>&middot;</span>
                <span className={styles.mono}>{c.children.length}</span> subs
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
