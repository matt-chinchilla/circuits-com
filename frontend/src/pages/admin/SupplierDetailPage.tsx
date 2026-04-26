import { useState, useEffect, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit, ExternalLink, Upload } from 'lucide-react';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import { adminApi } from '../../services/adminApi';
import type { AdminSupplier, Part, PaginatedResponse } from '../../types/admin';
import styles from './SupplierDetailPage.module.scss';

type Tier = 'featured' | 'platinum' | 'gold' | 'silver';

const TIER_CLASS: Record<Tier, string> = {
  featured: styles.tierFeatured,
  platinum: styles.tierPlatinum,
  gold: styles.tierGold,
  silver: styles.tierSilver,
};

function deriveTier(s: AdminSupplier): Tier {
  const n = s.parts_count ?? 0;
  if (n >= 200) return 'featured';
  if (n >= 100) return 'platinum';
  if (n >= 25) return 'gold';
  return 'silver';
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

function externalHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export default function SupplierDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [supplier, setSupplier] = useState<AdminSupplier | null>(null);
  const [parts, setParts] = useState<PaginatedResponse<Part> | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([adminApi.getSupplier(id), adminApi.getSupplierParts(id, { page })])
      .then(([s, p]) => {
        setSupplier(s);
        setParts(p);
      })
      .catch(() => setError('Failed to load supplier details.'))
      .finally(() => setLoading(false));
  }, [id, page]);

  const tier = useMemo(() => (supplier ? deriveTier(supplier) : null), [supplier]);

  if (loading) {
    return <div className={styles.loading}>Loading supplier details&hellip;</div>;
  }

  if (error || !supplier) {
    return (
      <div className={styles.page}>
        <Breadcrumbs
          items={[
            { label: 'Dashboard', href: '/admin' },
            { label: 'Suppliers', href: '/admin/suppliers' },
            { label: 'Error' },
          ]}
        />
        <div className={styles.errorPanel}>{error || 'Supplier not found.'}</div>
      </div>
    );
  }

  const partRows = parts?.items ?? [];
  const websiteHost = supplier.website ? stripScheme(supplier.website) : null;

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[
          { label: 'Dashboard', href: '/admin' },
          { label: 'Suppliers', href: '/admin/suppliers' },
          { label: supplier.name },
        ]}
      />

      <div className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <button type="button" className={styles.backLink} onClick={() => navigate('/admin/suppliers')}>
            <ArrowLeft size={14} strokeWidth={2} />
            All suppliers
          </button>
          <h1 className={styles.title}>{supplier.name}</h1>
          {tier && (
            <div className={styles.subtitle}>
              <span className={`${styles.supTier} ${TIER_CLASS[tier]}`}>
                {tier.charAt(0).toUpperCase() + tier.slice(1)}
              </span>
              {websiteHost && (
                <>
                  <span>&middot;</span>
                  <a
                    href={externalHref(supplier.website as string)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.extLink}
                  >
                    {websiteHost}
                    <ExternalLink size={11} strokeWidth={2} />
                  </a>
                </>
              )}
            </div>
          )}
        </div>
        <div className={styles.pageHeadActions}>
          <Link to={`/admin/suppliers/${supplier.id}/edit`} className={`${styles.btn} ${styles.btnPrimary}`}>
            <Edit size={14} strokeWidth={2} />
            Edit Supplier
          </Link>
        </div>
      </div>

      <div className={styles.detailGrid}>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Company</h3>
          </div>
          <dl className={styles.kvList}>
            <div>
              <dt>Contact</dt>
              <dd>{supplier.contact_name || '—'}</dd>
            </div>
            <div>
              <dt>Phone</dt>
              <dd className={styles.mono}>{supplier.phone || '—'}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd className={styles.mono}>{supplier.email || '—'}</dd>
            </div>
            <div>
              <dt>Website</dt>
              <dd className={styles.mono}>{websiteHost || '—'}</dd>
            </div>
            <div>
              <dt>Categories</dt>
              <dd>
                {supplier.categories && supplier.categories.length > 0
                  ? supplier.categories.join(', ')
                  : '—'}
              </dd>
            </div>
          </dl>
          {supplier.description && (
            <div className={styles.panelBody}>
              <h4 className={styles.panelSubtitle}>Description</h4>
              <p className={styles.panelText}>{supplier.description}</p>
            </div>
          )}
        </div>

        <div className={styles.sidebarStack}>
          <div className={`${styles.panel} ${styles.miniStat}`}>
            <div className={styles.miniStatLabel}>Parts in catalog</div>
            <div className={styles.miniStatValue}>
              {(supplier.parts_count ?? 0).toLocaleString()}
            </div>
            <div className={styles.miniStatHint}>
              {parts ? `${parts.total} listed in detail view` : 'Loading…'}
            </div>
          </div>
          <div className={`${styles.panel} ${styles.miniStat}`}>
            <div className={styles.miniStatLabel}>Revenue</div>
            <div className={styles.miniStatValue}>
              ${(supplier.revenue_total ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </div>
            <div className={styles.miniStatHint}>Lifetime, all sources</div>
          </div>
          <div className={`${styles.panel} ${styles.miniStat}`}>
            <div className={styles.miniStatLabel}>Categories</div>
            <div className={styles.miniStatValue}>{supplier.categories?.length ?? 0}</div>
            <div className={styles.miniStatHint}>
              {supplier.categories && supplier.categories.length > 0
                ? supplier.categories.slice(0, 2).join(', ')
                : 'None linked yet'}
            </div>
          </div>
        </div>
      </div>

      <div className={`${styles.panel} ${styles.partsPanel}`}>
        <div className={styles.panelHead}>
          <h3 className={styles.panelTitle}>Listed Parts ({parts?.total ?? 0})</h3>
          <Link to="/admin/parts" className={styles.panelLink}>
            All parts &rarr;
          </Link>
        </div>
        {partRows.length === 0 ? (
          <div className={styles.partsEmpty}>
            No parts uploaded yet &mdash; supplier is live but their inventory is empty.
            <div>
              <Link to="/admin/import" className={`${styles.btn} ${styles.btnGhost}`}>
                <Upload size={14} strokeWidth={2} />
                Upload parts CSV
              </Link>
            </div>
          </div>
        ) : (
          <>
            <table className={styles.partsTable}>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Manufacturer</th>
                  <th>Description</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {partRows.map((p) => (
                  <tr key={p.id} onClick={() => navigate(`/admin/parts/${p.id}`)}>
                    <td className={styles.mono}>{p.sku}</td>
                    <td>{p.manufacturer_name}</td>
                    <td>{p.description || '—'}</td>
                    <td>
                      <span className={styles.statusPill}>{p.lifecycle_status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parts && parts.pages > 1 && (
              <div className={styles.pagination}>
                <button
                  type="button"
                  className={styles.pageBtn}
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>
                <span className={styles.pageInfo}>
                  Page {parts.page} of {parts.pages}
                </span>
                <button
                  type="button"
                  className={styles.pageBtn}
                  disabled={page >= parts.pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
