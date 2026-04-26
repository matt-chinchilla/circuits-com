import { useState, useEffect, useMemo } from 'react';
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

          <div className={styles.treeCard}>
            {visible.length === 0 && (
              <div className={styles.empty}>No categories match &ldquo;{query}&rdquo;</div>
            )}
            {visible.map((c) => {
              const isOpen = expanded.has(c.id) || !!c._forceOpen;
              return (
                <div className={styles.treeNode} key={c.id}>
                  <button
                    type="button"
                    className={`${styles.treeParent} ${isOpen ? styles.open : ''}`}
                    onClick={() => toggle(c.id)}
                    aria-expanded={isOpen}
                  >
                    <span className={styles.treeCaret}>
                      <ChevronRight />
                    </span>
                    <span className={styles.treeIcon}>{c.icon}</span>
                    <span className={styles.treeName}>{c.name}</span>
                    <span className={styles.treeSlug}>{c.slug}</span>
                    <span className={styles.treePill}>
                      {c._children.length} subcategories
                    </span>
                    <span className={styles.treeMeta}>
                      <span className={styles.mono}>{c._children.length}</span> subs
                    </span>
                  </button>

                  <div className={`${styles.treeChildren} ${isOpen ? styles.open : ''}`}>
                    {isOpen &&
                      c._children.map((s) => (
                        <div className={styles.treeChild} key={s.id}>
                          <span className={styles.treeRail} />
                          <span className={styles.childIcon}>{s.icon}</span>
                          <span className={styles.childName}>{s.name}</span>
                          <span className={styles.childSlug}>{s.slug}</span>
                          <a
                            className={styles.childView}
                            href={`/category/${c.slug}/${s.slug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            View &rarr;
                          </a>
                        </div>
                      ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {view === 'grid' && (
        <div className={styles.catGrid}>
          {categories.map((c) => (
            <div key={c.id} className={styles.catCard}>
              <div className={styles.catIcon}>{c.icon}</div>
              <div className={styles.catName}>{c.name}</div>
              <div className={styles.catSlug}>{c.slug}</div>
              <div className={styles.catStats}>
                <span className={styles.mono}>{c.children?.length || 0}</span> subs
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
