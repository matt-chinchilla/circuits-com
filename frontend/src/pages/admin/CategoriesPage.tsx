import { useState, useEffect } from 'react';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import { adminApi } from '../../services/adminApi';
import type { AdminCategory } from '../../types/admin';
import styles from './CategoriesPage.module.scss';

export default function CategoriesPage() {
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    adminApi
      .getCategories()
      .then(setCategories)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  if (loading) {
    return <div className={styles.loading}>Loading categories...</div>;
  }

  return (
    <div className={styles.page}>
      <Breadcrumbs items={[{ label: 'Dashboard', href: '/admin' }, { label: 'Categories' }]} />

      <h1 className={styles.title}>Categories</h1>
      <p className={styles.subtitle}>Browse the category tree. Categories are managed in the main admin panel.</p>
      <p className={styles.readOnlyNote}>Read-only view. Use the SQLAdmin panel at /admin to edit categories.</p>

      {categories.length === 0 ? (
        <div className={styles.empty}>No categories found.</div>
      ) : (
        <div className={styles.treeCard}>
          {categories.map((cat) => (
            <div key={cat.id}>
              <div
                className={styles.parentRow}
                onClick={() => toggleExpand(cat.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(cat.id); } }}
              >
                <span className={`${styles.expandIcon} ${expanded.has(cat.id) ? styles.expanded : ''}`}>
                  {cat.children.length > 0 ? '\u25B6' : ''}
                </span>
                <span className={styles.categoryIcon}>{cat.icon}</span>
                <span className={styles.categoryName}>{cat.name}</span>
                <span className={styles.categorySlug}>{cat.slug}</span>
                <span className={styles.categoryCount}>
                  {cat.children.length} {cat.children.length === 1 ? 'subcategory' : 'subcategories'}
                </span>
              </div>
              {expanded.has(cat.id) && cat.children.length > 0 && (
                <div className={styles.childrenContainer}>
                  {cat.children.map((child) => (
                    <div key={child.id} className={styles.childRow}>
                      <span className={styles.childIcon}>{child.icon}</span>
                      <span className={styles.childName}>{child.name}</span>
                      <span className={styles.childSlug}>{child.slug}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
