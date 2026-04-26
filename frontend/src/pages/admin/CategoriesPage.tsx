import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Search, ChevronRight, List, Grid as GridIcon, Plus } from 'lucide-react';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import { adminApi } from '../../services/adminApi';
import type { AdminCategory } from '../../types/admin';
import styles from './CategoriesPage.module.scss';

type ViewMode = 'tree' | 'grid';

interface FilteredCategory extends AdminCategory {
  _show: boolean;
  _children: AdminCategory['children'];
  _forceOpen?: boolean;
}

export default function CategoriesPage() {
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ViewMode>('tree');

  useEffect(() => {
    adminApi
      .getCategories()
      .then((cats) => {
        setCategories(cats);
        // Default-open first category for visual continuity with the bundle
        if (cats.length > 0) setExpanded(new Set([cats[0].id]));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function expandAll() {
    setExpanded(new Set(categories.map((c) => c.id)));
  }

  function collapseAll() {
    setExpanded(new Set());
  }

  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);

  const filtered = useMemo<FilteredCategory[]>(() => {
    return categories.map((c) => {
      const subs = c.children || [];
      const subMatches = subs.filter((s) => matches(s.name) || matches(s.slug));
      const parentMatches = matches(c.name) || matches(c.slug);
      if (!q) return { ...c, _show: true, _children: subs };
      if (parentMatches) return { ...c, _show: true, _children: subs };
      if (subMatches.length) return { ...c, _show: true, _children: subMatches, _forceOpen: true };
      return { ...c, _show: false, _children: [] };
    });
  }, [categories, q]);

  const visible = filtered.filter((c) => c._show);
  const totalSubs = categories.reduce((n, c) => n + (c.children?.length || 0), 0);
  const totalParts = categories.reduce((n, c) => {
    const childParts = (c.children || []).reduce(
      (m, ch) => m + (ch.parts_count || 0),
      0,
    );
    return n + (c.parts_count || 0) + childParts;
  }, 0);

  if (loading) {
    return <div className={styles.loading}>Loading categories...</div>;
  }

  return (
    <div className={styles.page}>
      <Breadcrumbs items={[{ label: 'Dashboard', href: '/admin' }, { label: 'Categories' }]} />

      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Categories</h1>
          <p className={styles.subtitle}>
            {categories.length} top-level categories &middot; {totalSubs} subcategories
            &middot;{' '}
            <span className={styles.mono}>{totalParts.toLocaleString()}</span> parts indexed
          </p>
        </div>
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
          <button
            type="button"
            className={styles.addBtn}
            disabled
            title="Categories are managed via seed.py in this build"
          >
            <Plus />
            Add Category
          </button>
        </div>
      </div>

      {view === 'tree' && (
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
            <button type="button" className={styles.toolbarBtn} onClick={expandAll}>
              Expand all
            </button>
            <button type="button" className={styles.toolbarBtn} onClick={collapseAll}>
              Collapse all
            </button>
            <span className={styles.count}>
              {visible.length} / {categories.length}
            </span>
          </div>

          <div className={styles.treeStack}>
            {visible.length === 0 && (
              <div className={styles.empty}>No categories match &ldquo;{query}&rdquo;</div>
            )}
            {visible.map((c) => {
              const isOpen = expanded.has(c.id) || !!c._forceOpen;
              const childParts = c._children.reduce(
                (n, ch) => n + (ch.parts_count || 0),
                0,
              );
              const totalCatParts = (c.parts_count || 0) + childParts;
              return (
                <article
                  key={c.id}
                  className={`${styles.catBlock} ${isOpen ? styles.open : ''}`}
                >
                  <button
                    type="button"
                    className={styles.catBlockHead}
                    onClick={() => toggle(c.id)}
                    aria-expanded={isOpen}
                  >
                    <span className={styles.headCaret}>
                      <ChevronRight />
                    </span>
                    <span className={styles.headIcon}>{c.icon}</span>
                    <span className={styles.headTitle}>
                      <span className={styles.headName}>{c.name}</span>
                      <span className={styles.headSlug}>{c.slug}</span>
                    </span>
                    <span className={styles.headStats}>
                      <span className={styles.headPill}>
                        <span className={styles.mono}>{c._children.length}</span> subs
                      </span>
                      <span className={styles.headPill}>
                        <span className={styles.mono}>
                          {totalCatParts.toLocaleString()}
                        </span>{' '}
                        parts
                      </span>
                    </span>
                  </button>

                  {isOpen && (
                    <div className={styles.subGrid}>
                      {c._children.map((s) => (
                        <Link
                          key={s.id}
                          to={`/category/${s.slug}`}
                          className={styles.subTile}
                        >
                          <span className={styles.subIcon}>{s.icon}</span>
                          <span className={styles.subName}>{s.name}</span>
                          <span className={styles.subSlug}>{s.slug}</span>
                          <span className={styles.subView}>View &rarr;</span>
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

      {view === 'grid' && (
        <div className={styles.catGrid}>
          {categories.map((c) => {
            const childParts = (c.children || []).reduce(
              (n, ch) => n + (ch.parts_count || 0),
              0,
            );
            const totalCatParts = (c.parts_count || 0) + childParts;
            return (
              <div key={c.id} className={styles.catCard}>
                <div className={styles.catIcon}>{c.icon}</div>
                <div className={styles.catName}>{c.name}</div>
                <div className={styles.catSlug}>{c.slug}</div>
                <div className={styles.catStats}>
                  <span className={styles.mono}>{totalCatParts.toLocaleString()}</span> parts
                  <span className={styles.dotSep}>&middot;</span>
                  <span className={styles.mono}>{c.children?.length || 0}</span> subs
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
