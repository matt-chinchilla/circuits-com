import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';
import { ArrowLeft, Edit, ExternalLink, Upload, Trash2 } from 'lucide-react';
import Breadcrumbs from '@admin/components/Breadcrumbs';
import { adminApi } from '@admin/services/adminApi';
import { useDemo } from '@admin/contexts/DemoContext';
import {
  syncSupplier,
  importSupplier,
  observeSupplierRun,
  syncErrorMessage,
  runOutlivesReader,
  appendCapped,
  tallyEvent,
  tallyTotals,
  EMPTY_RUN_TALLY,
  SyncStreamError,
  type FeedRunInfo,
  type RunTally,
  type SyncEvent,
} from '@admin/services/syncStream';
import type { AdminSupplier, Part, PaginatedResponse } from '@admin/types/admin';
import QuickActionsPanel from './QuickActionsPanel';
import SyncConsole from './SyncConsole';
import NightlyImportToggle from './NightlyImportToggle';
import {
  buildSponsorshipBySupplier,
  supplierSponsorship,
  type SupplierSponsorship,
} from '../sponsorship';
import { lettermark } from '@shared/utils/lettermark';
import { safeImageUrl } from '@shared/utils/url';
import styles from './SupplierDetailPage.module.scss';

const SPONSORSHIP_CLASS: Record<SupplierSponsorship, string> = {
  Platinum: styles.tierPlatinum,
  Gold: styles.tierGold,
  Silver: styles.tierSilver,
  None: styles.tierNone,
};

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

function externalHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export default function SupplierDetailPage() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { demoMode } = useDemo();
  const [supplier, setSupplier] = useState<AdminSupplier | null>(null);
  const [parts, setParts] = useState<PaginatedResponse<Part> | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // The live feed run — a SYNC (refresh what this supplier lists) or an IMPORT
  // (go find what it doesn't). ONE piece of state for both, because one console
  // renders them and only one may be going at a time; `mode` is what the header
  // names. Owned HERE, not in QuickActionsPanel, so the console's feed survives
  // every re-render of the strip that starts it.
  //
  // `running` and `serverRunning` are DIFFERENT facts and the split is the
  // point: the run belongs to the server, so this page's socket can die (a
  // frozen tab, a proxy read-timeout, navigating away and back) while the work
  // carries on spending the day's provider quota. `running` is "this tab is
  // reading"; `serverRunning` is "the run is going". Only the second may gate
  // a second click, and only the second decides whether the console still
  // looks alive.
  //
  // `events` is the display window (capped); `tally` is the run's real
  // arithmetic, folded as each event ARRIVES. They are separate fields
  // because they answer different questions and only one of them may be
  // trimmed — see EVENT_ROW_CAP.
  const [runState, setRunState] = useState<{
    mode: 'sync' | 'import';
    running: boolean;
    serverRunning: boolean;
    reattached: boolean;
    events: SyncEvent[];
    tally: RunTally;
    error: string | null;
  }>({
    mode: 'sync',
    running: false,
    serverRunning: false,
    reattached: false,
    events: [],
    tally: EMPTY_RUN_TALLY,
    error: null,
  });
  // True between a pause click and the run's paused ending arriving on the
  // stream (the ending flips serverRunning off; nothing else needs to).
  const [pausingRun, setPausingRun] = useState(false);
  // True while a reconnect attempt is in flight — the console's button.
  const [reconnecting, setReconnecting] = useState(false);
  // Bumped when a run ends so the load effect refetches — the supplier's real
  // counts and the parts table both move underneath us during a sync.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Separate from the load-error sentinel so a failed delete shows a
  // dismissible inline message in the modal instead of replacing the
  // whole supplier view with the "supplier not found" fallback.
  const [deleteError, setDeleteError] = useState('');

  // Leaving the page DETACHES this reader. It does not cancel the run — the
  // run is owned by a server-side worker and finishes on its own, which is
  // exactly why the operator can come back to it. Aborting here just stops
  // this tab holding a socket open for a console nobody is looking at. ONE
  // controller is enough: one reader at a time. Admin routes remount per `:id`
  // (App.tsx keys the ErrorBoundary on pathname), so this covers both unmount
  // and navigating to another supplier.
  const runAbortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      runAbortRef.current?.abort();
    },
    [id]
  );

  // A run is server-owned, so one may already be going when this page loads:
  // started before a reload, in another tab, or left behind when the operator
  // navigated away. Probe for it and re-fill the console, rather than showing
  // an idle strip whose Sync button can only ever answer 409.
  //
  // Deliberately silent about failure — a probe that shouts would put a red
  // line on a page where nothing is wrong. `attachToRun` is defined below;
  // the callback runs after render, so the binding is live by then.
  useEffect(() => {
    if (!id) return;
    void attachToRun(id).catch(() => {});
    // Keyed on the supplier alone. The cleanup that matters — detaching the
    // reader — belongs to the effect above, which keys on the same id.
  }, [id]);

  // Raised by a finishing run so the refetch it triggers stays SILENT. The
  // loading curtain replaces the whole page, console included, so a noisy
  // refetch would erase the feed the operator just watched — at the exact
  // moment its summary line appears. Consumed by the next effect run.
  const quietRefetchRef = useRef(false);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const quiet = quietRefetchRef.current;
    quietRefetchRef.current = false;
    if (!quiet) setLoading(true);
    Promise.all([adminApi.getSupplier(id), adminApi.getSupplierParts(id, { page })])
      .then(([s, p]) => {
        if (cancelled) return;
        setSupplier(s);
        setParts(p);
      })
      .catch(() => {
        if (cancelled) return;
        // A failed quiet refetch leaves the (now slightly stale) counts and the
        // run's own summary standing; only a failed FIRST load is fatal.
        if (!quiet) setError('Failed to load supplier details.');
      })
      .finally(() => {
        if (!cancelled && !quiet) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, page, refreshNonce]);

  // Badge = this supplier's actual active sponsorship (highest tier) or 'None'.
  // AdminSupplier has no sponsorship field, so cross-reference the sponsor rows.
  const [sponsorship, setSponsorship] = useState<SupplierSponsorship>('None');
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    adminApi
      .getSponsors()
      .then((spons) => {
        if (cancelled) return;
        setSponsorship(supplierSponsorship(id, buildSponsorshipBySupplier(spons)));
      })
      .catch((e) => {
        console.warn('[SupplierDetailPage] getSponsors failed; badge defaults to None', e);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // ONE reader for every way into a run — starting a sync, starting an import,
  // or attaching to one already going. All three speak the same NDJSON stream
  // and everything this page does with it (detach on leave, quiet refetch
  // afterwards, one error sentence) is identical; a second copy of this is how
  // one of them ends up missing the refetch or mis-labelling the run.
  //
  // `replaceOnFirstEvent` is the difference between the doors: a POST starts a
  // run with no history, while an attach REPLAYS the whole run from the top —
  // appending that to what is already on screen would show every event twice.
  // The swap waits for the first event so a 404 (nothing to attach to) leaves
  // the console exactly as it was rather than blanking it.
  const readRun = (
    open: (
      onEvent: (event: SyncEvent) => void,
      options: { signal: AbortSignal; onOpen: (info: FeedRunInfo) => void }
    ) => Promise<boolean | void>,
    seed: { mode?: 'sync' | 'import'; reattached: boolean; replaceOnFirstEvent: boolean }
  ): Promise<boolean> => {
    const controller = new AbortController();
    // Never two readers on one run: the older socket is dropped, not the work.
    runAbortRef.current?.abort();
    runAbortRef.current = controller;
    setRunState((prev) => ({
      ...prev,
      mode: seed.mode ?? prev.mode,
      running: true,
      // A POST *starts* a run, so the run is going the moment the click lands.
      // An ATTACH does not know yet — the server may only be handing back the
      // replay of one that already ended, and it says which in the headers
      // (`onOpen`, one round-trip away). The cards stay locked either way,
      // because `running` already covers the window in between.
      serverRunning: seed.replaceOnFirstEvent ? prev.serverRunning : true,
      reattached: seed.reattached,
      error: null,
      // Both reset together or the counters carry the last run's numbers into
      // this one's first frame.
      events: seed.replaceOnFirstEvent ? prev.events : [],
      tally: seed.replaceOnFirstEvent ? prev.tally : EMPTY_RUN_TALLY,
    }));
    // Tracked out here rather than read off state: a reader that dies mid-run
    // has still seen work that was committed before it was reported (the
    // importer commits per part), so a refetch is owed whenever ANY event
    // arrived. A run that never started owes nothing.
    let receivedAny = false;
    let sawFinish = false;
    // Assume live until the headers say otherwise — an API that predates the
    // header sends nothing, and idling a card over a live run is the worse
    // half of that trade.
    let activeAtOpen = true;
    let swapped = !seed.replaceOnFirstEvent;
    return open(
      (event) => {
        receivedAny = true;
        if (event.kind === 'sync_finished') sawFinish = true;
        const replace = !swapped;
        swapped = true;
        setRunState((prev) => ({
          ...prev,
          // The window is trimmed; the tally never is. Folding here — once per
          // event, as it arrives — is what makes the counters immune to the
          // eviction. The updater stays PURE (it derives from `prev`), so
          // React re-invoking it cannot double-count.
          events: replace ? [event] : appendCapped(prev.events, event),
          tally: tallyEvent(replace ? EMPTY_RUN_TALLY : prev.tally, event),
        }));
      },
      {
        signal: controller.signal,
        // The two routes emit an identical envelope, so the MODE only ever
        // arrives in the headers — without this an attach would label an
        // import as a sync. `active` is the other thing the body cannot say:
        // a replay of a finished run looks exactly like a live one until it
        // ends.
        onOpen: (info) => {
          activeAtOpen = info.active;
          setRunState((prev) => ({ ...prev, mode: info.mode, serverRunning: info.active }));
        },
      }
    )
      // An abort resolves like a clean finish, so both settle paths check the
      // signal first: there is nobody left to show a refetch or an error to,
      // and bumping the nonce would fire a request for a page being torn down.
      .then((attached) => {
        if (controller.signal.aborted) return false;
        // The server closes the stream only when the WORK ends, so a clean
        // finish here means the run is genuinely over.
        setRunState((prev) => ({ ...prev, running: false, serverRunning: false }));
        setPausingRun(false);
        if (receivedAny) {
          quietRefetchRef.current = true;
          setRefreshNonce((n) => n + 1);
        }
        return attached !== false;
      })
      .catch((err) => {
        if (controller.signal.aborted) return false;
        // A dropped socket is NOT a finished run. If events were flowing and
        // no ending arrived, the work is still going server-side — say so and
        // keep the second click blocked. But only for a run that WAS going:
        // the same drop part-way through the replay of a finished one would
        // otherwise strand the console claiming a run nothing can ever end.
        const stillGoing = runOutlivesReader({ activeAtOpen, receivedAny, sawFinish });
        if (!stillGoing) setPausingRun(false);
        setRunState((prev) => ({
          ...prev,
          running: false,
          serverRunning: stillGoing,
          error: syncErrorMessage(err, { runActive: activeAtOpen }),
        }));
        if (receivedAny) {
          quietRefetchRef.current = true;
          setRefreshNonce((n) => n + 1);
        }
        if (err instanceof SyncStreamError) throw err;
        return false;
      });
  };

  // Attach to whatever this supplier already has going. Used three ways: the
  // page's own probe on load, the console's Reconnect button, and the recovery
  // from a 409 (someone — maybe this operator in another tab — got there
  // first). Resolves false when there is nothing to watch.
  const attachToRun = (supplierId: string, reattached = true): Promise<boolean> =>
    readRun(
      (onEvent, options) => observeSupplierRun(supplierId, onEvent, options),
      { reattached, replaceOnFirstEvent: true }
    );

  // Both runs, one function. An import moves MORE than a sync does (new parts,
  // new counts), so the refetch matters at least as much there.
  const pauseRun = () => {
    if (!id || pausingRun) return;
    const watching = runState.running;
    setPausingRun(true);
    adminApi
      .pauseFeedRun(id)
      .then(() => {
        // The wind-down is announced by the run's own `sync_finished`, which
        // only lands on an OPEN stream. Pausing from the detached state (the
        // card offers it there — the run is still spending quota) would
        // otherwise leave this tab claiming a run that had already stopped,
        // with a "Pausing…" button that never resolves. Attach, so the ending
        // has somewhere to arrive.
        if (!watching) void attachToRun(id).catch(() => {});
      })
      .catch(() => {
        // 404 = the run ended between the render and the click — the stream's
        // own ending event resets the button either way.
        setPausingRun(false);
      });
  };

  const startRun = (mode: 'sync' | 'import') => {
    if (!id || runState.running || runState.serverRunning) return;
    // A stale "Pausing…" must not greet a brand-new run: whatever the last
    // pause was waiting for is over, or this click could not have landed.
    setPausingRun(false);
    const openStream = mode === 'import' ? importSupplier : syncSupplier;
    readRun((onEvent, options) => openStream(id, onEvent, options), {
      mode,
      reattached: false,
      replaceOnFirstEvent: false,
    }).catch((err) => {
      // A run was already going when the click landed. That is not a failure
      // to report — it is the run the operator wanted to see, so attach to it
      // instead of leaving them with a red line about a conflict.
      if (
        err instanceof SyncStreamError &&
        err.status === 409 &&
        err.detail === 'feed_run_already_active'
      ) {
        void attachToRun(id);
      }
    });
  };

  const handleReconnect = () => {
    if (!id || reconnecting) return;
    setReconnecting(true);
    attachToRun(id)
      .then((attached) => {
        if (attached) return;
        // Nothing left to watch: the run ended while this tab was away (and
        // fell out of the server's retention window). Stop claiming it is
        // going, and leave the events already on screen alone.
        setPausingRun(false);
        setRunState((prev) => ({
          ...prev,
          serverRunning: false,
          error: 'That run has finished — its results are in the activity feed.',
        }));
      })
      .catch(() => {
        /* readRun already put the sentence on screen */
      })
      .finally(() => setReconnecting(false));
  };

  const handleDelete = async () => {
    if (!supplier) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await adminApi.deleteSupplier(supplier.id);
      navigate(consolePath('/admin/suppliers'));
    } catch (err) {
      // Surface in the modal — don't replace the whole detail view with
      // the load-error fallback. User stays on the page and can retry.
      console.warn('[SupplierDetailPage] deleteSupplier failed', err);
      setDeleteError('Failed to delete supplier. Please try again.');
    } finally {
      setDeleting(false);
    }
  };

  const closeDeleteModal = () => {
    setConfirmDelete(false);
    setDeleteError('');
  };

  if (loading) {
    return <div className={styles.loading}>Loading supplier details&hellip;</div>;
  }

  if (error || !supplier) {
    return (
      <div className={styles.page}>
        <Breadcrumbs
          items={[
            { label: 'Dashboard', href: consolePath('/admin') },
            { label: 'Suppliers', href: consolePath('/admin/suppliers') },
            { label: 'Error' },
          ]}
        />
        <div className={styles.errorPanel}>{error || 'Supplier not found.'}</div>
      </div>
    );
  }

  const partRows = parts?.items ?? [];
  const partsTotal = parts?.total ?? 0;
  const websiteHost = supplier.website ? stripScheme(supplier.website) : null;
  const logoSrc = safeImageUrl(supplier.logo_url);

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[
          { label: 'Dashboard', href: consolePath('/admin') },
          { label: 'Suppliers', href: consolePath('/admin/suppliers') },
          { label: supplier.name },
        ]}
      />

      <div className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <button type="button" className={styles.backLink} onClick={() => navigate(consolePath('/admin/suppliers'))}>
            <ArrowLeft size={14} strokeWidth={2} />
            All suppliers
          </button>
          <div className={styles.titleRow}>
            <div className={styles.avatar}>
              {logoSrc ? (
                <img className={styles.avatarImg} src={logoSrc} alt="" />
              ) : (
                <span>{lettermark(supplier.name)}</span>
              )}
            </div>
            <h1 className={styles.title}>{supplier.name}</h1>
          </div>
          <div className={styles.subtitle}>
            <span className={`${styles.supTier} ${SPONSORSHIP_CLASS[sponsorship]}`}>
              {sponsorship}
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
        </div>
        <div className={styles.pageHeadActions}>
          <button
            type="button"
            data-tour="delete-supplier"
            className={`${styles.btn} ${styles.btnDangerGhost}`}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={14} strokeWidth={2} />
            Delete
          </button>
          <Link to={consolePath(`/admin/suppliers/${supplier.id}/edit`)} className={`${styles.btn} ${styles.btnGhost}`}>
            <Edit size={14} strokeWidth={2} />
            Edit
          </Link>
        </div>
      </div>

      {/* Hero quick-actions strip — full-width row of 4 prominent cards.
          Sits where supplier-detail spends its most-clicked time. The
          first card (Add part) replaces the prior header "Add Part"
          button so the page CTA is the strip itself. */}
      {/* `syncing`/`importing` track the RUN, not the socket: the cards must
          stay out of service across a dropped connection, because the work —
          and the provider quota it spends — carries on without this tab. */}
      <QuickActionsPanel
        supplier={supplier}
        partRows={partRows}
        onSync={() => startRun('sync')}
        syncing={(runState.running || runState.serverRunning) && runState.mode === 'sync'}
        onImport={() => startRun('import')}
        importing={(runState.running || runState.serverRunning) && runState.mode === 'import'}
        serverRunning={runState.serverRunning}
        // Pause is offered ONLY once the server has said a run is going —
        // never merely because this tab has a socket open. The page probes
        // for a run on every load, and a card that flipped to "Pause" during
        // that probe (or during the replay of a run that had already ended)
        // offers a button whose only possible answer is 404.
        serverRunMode={runState.serverRunning ? runState.mode : null}
        onPause={pauseRun}
        pausing={pausingRun}
      />

      {/* The standing-order version of the Import card above: same job, every
          night. Renders nothing until its own fetch lands (and nothing at all
          if that fetch fails). */}
      <NightlyImportToggle supplierId={supplier.id} />

      {/* The run itself, live. Mounts on the first click and stays up
          afterwards so the summary is still readable. */}
      {(runState.running ||
        runState.serverRunning ||
        runState.events.length > 0 ||
        runState.error) && (
        <SyncConsole
          supplierName={supplier.name}
          mode={runState.mode}
          running={runState.running}
          serverRunning={runState.serverRunning}
          reattached={runState.reattached}
          // Offered only when there is something to attach TO: a run still
          // going that this tab is not reading.
          onReconnect={
            runState.serverRunning && !runState.running ? handleReconnect : undefined
          }
          reconnecting={reconnecting}
          events={runState.events}
          // Counted at arrival, NOT from `events` — that array is a capped
          // window and a total walked over it stalls at the cap and then
          // falls as rows are evicted.
          counts={tallyTotals(runState.tally)}
          error={runState.error}
        />
      )}

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
              {demoMode ? (supplier.parts_count ?? 0).toLocaleString() : partsTotal.toLocaleString()}
            </div>
            <div className={styles.miniStatHint}>
              {demoMode
                ? 'Last sync 6h ago'
                : partsTotal > 0
                  ? `${partsTotal} live SKU${partsTotal === 1 ? '' : 's'}`
                  : 'No live listings yet'}
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
          <h3 className={styles.panelTitle}>Listed Parts ({partsTotal})</h3>
          <Link to={consolePath('/admin/parts')} className={styles.panelLink}>
            All parts &rarr;
          </Link>
        </div>
        {partRows.length === 0 ? (
          <div className={styles.partsEmpty}>
            No parts uploaded yet &mdash; supplier is live but their inventory is empty.
            <div>
              <Link to={consolePath('/admin/import')} className={`${styles.btn} ${styles.btnGhost}`}>
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
                  <tr key={p.id} onClick={() => navigate(consolePath(`/admin/parts/${p.id}`))}>
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

      {confirmDelete && (
        <div
          className={styles.modalBackdrop}
          data-modal="confirm-delete"
          onClick={closeDeleteModal}
        >
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Delete {supplier.name}?</h3>
            <p className={styles.modalBody}>
              This removes the supplier from the directory, unlinks them from
              any parts (PartListings), and deletes their sponsorships. This
              action cannot be undone.
            </p>
            {deleteError && <div className={styles.modalError}>{deleteError}</div>}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                onClick={closeDeleteModal}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                data-modal-confirm="true"
                className={`${styles.btn} ${styles.btnDanger}`}
                onClick={handleDelete}
                disabled={deleting}
              >
                <Trash2 size={14} strokeWidth={2} />
                {deleting ? 'Deleting…' : 'Delete supplier'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
