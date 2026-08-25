import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  Archive,
  Eye,
  MoreVertical,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  Designator,
  MessageTypeChip,
  SpamScoreWarning,
  StatusDot,
} from '@admin/components/messages/MessageChips';
import {
  dayBucket,
  relTime,
  senderEmail,
  senderName,
  subjectFor,
} from '@admin/components/messages/messageHelpers';
import InboxZeroEmptyState from '@admin/components/messages/InboxZeroEmptyState';
import KeyboardHintFooter from '@admin/components/messages/KeyboardHintFooter';
import ConfirmDialog from '@admin/components/ConfirmDialog';
import {
  archive as archiveMsg,
  assignTo,
  loadMessages,
  markSpam,
  refreshMessages,
  toggleRead,
} from '@admin/services/messageStore';
import { adminApi } from '@admin/services/adminApi';
import { apiErrorDetail } from '@admin/services/apiError';
import {
  canDeleteMessages,
  isOwnerOnly,
  OWNER_ONLY_MESSAGE,
} from '@admin/services/permissions';
import type { BulkDeleteResult, Message } from '@admin/types/messages';
import { useAuth } from '@admin/contexts/AuthContext';
import {
  chunkIds,
  confirmDeleteCopy,
  deleteFailureMessage,
  deleteOutcomeMessage,
  deselectIds,
  headerSelectionState,
  normalizeBulkResult,
  pruneSelection,
  selectRowLabel,
  selectionLabel,
  toggleAllVisible,
  toggleSelected,
  visibleSelectedIds,
} from './selection';
import styles from './MessagesListPage.module.scss';

/** Where the company's mail lives. The address is derived from the signed-in
 *  username because mailbox local-parts ARE the usernames (lower-cased —
 *  `Anthony` owns `anthony@`). Kept beside the URL so both move together if
 *  the mail host ever changes. */
const WEBMAIL_URL = 'https://mail.circuitcenter.ai';
const MAIL_DOMAIN = 'circuitcenter.ai';

/**
 * Columns after the leading select checkbox: dot, designator, type, sender,
 * subject, time, actions. The select column only exists for the owner (it is
 * the entry point to a delete), so the table renders at 7 or 8 columns and the
 * <col> list, every <td> and every colSpan below are computed from these two
 * numbers rather than hard-coded — a literal 8 would silently misalign the
 * cluster headers for staff.
 */
const CONTENT_COLUMNS = 7;

type Filter = 'all' | 'contact' | 'join' | 'keyword' | 'archived';
type Sort = 'unread' | 'newest' | 'oldest';

interface RowProps {
  m: Message;
  onOpen: (id: string) => void;
  onAction: (kind: ActionKind, m: Message) => void;
  onDelete: (m: Message) => void;
  isFresh: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  /** Owner-only: renders the select cell AND the row-menu Delete item. */
  canDelete: boolean;
}

type ActionKind =
  | 'toggle_read'
  | 'archive'
  | 'assign_daniel'
  | 'assign_anthony'
  | 'assign_ronald'
  | 'spam';

/** The axios error's HTTP status + `detail`, without dragging axios in here. */
function httpFailure(err: unknown): { status?: number; detail?: unknown } {
  const res = (
    err as { response?: { status?: number; data?: { detail?: unknown } } } | null
  )?.response;
  return { status: res?.status, detail: res?.data?.detail };
}

function MessageRow({
  m,
  onOpen,
  onAction,
  onDelete,
  isFresh,
  selected,
  onToggleSelect,
  canDelete,
}: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const rowClass = [
    styles.row,
    m.status === 'new' && styles.isNew,
    m.status === 'archived' && styles.isArc,
    selected && styles.isSel,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <tr
      className={rowClass}
      data-msg-id={m.id}
      data-msg-status={m.status}
      onClick={() => onOpen(m.id)}
    >
      {/* Same stopPropagation guard as the row-action cell below: a click that
          selects must never also navigate to the detail page. */}
      {canDelete && (
        <td className={styles.cSel} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={selected}
            onChange={() => onToggleSelect(m.id)}
            aria-label={selectRowLabel(m.seq)}
          />
        </td>
      )}
      <td className={styles.cDot}>
        <StatusDot status={m.status} isFresh={isFresh} />
      </td>
      <td className={styles.cDes}>
        <Designator seq={m.seq} />
      </td>
      <td className={styles.cType}>
        <MessageTypeChip type={m.type} />
      </td>
      <td className={styles.cSender}>
        <div className={styles.senderName}>
          {senderName(m)}
          {(m.spam_score ?? 0) > 0.6 && <SpamScoreWarning score={m.spam_score} />}
        </div>
        <div className={styles.senderEmail}>{senderEmail(m)}</div>
      </td>
      <td className={styles.cSubject}>
        <div className={styles.subject}>{subjectFor(m)}</div>
      </td>
      <td className={styles.cTime}>{relTime(m.created_at)}</td>
      <td className={styles.cAct} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className={styles.rowAction}
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Row actions"
        >
          <MoreVertical size={14} strokeWidth={2} />
        </button>
        {menuOpen && (
          <>
            <div
              className={styles.menuBackdrop}
              onClick={() => setMenuOpen(false)}
            />
            <div className={styles.rowMenu}>
              <button
                type="button"
                onClick={() => {
                  onAction('toggle_read', m);
                  setMenuOpen(false);
                }}
              >
                <Eye size={13} strokeWidth={2} />
                Mark {m.status === 'new' ? 'read' : 'unread'}
              </button>
              <button
                type="button"
                onClick={() => {
                  onAction('archive', m);
                  setMenuOpen(false);
                }}
              >
                <Archive size={13} strokeWidth={2} />
                Archive
              </button>
              <div className={styles.rowMenuSep} />
              <button
                type="button"
                onClick={() => {
                  onAction('assign_daniel', m);
                  setMenuOpen(false);
                }}
              >
                Assign to Daniel
              </button>
              <button
                type="button"
                onClick={() => {
                  onAction('assign_anthony', m);
                  setMenuOpen(false);
                }}
              >
                Assign to Anthony
              </button>
              <button
                type="button"
                onClick={() => {
                  onAction('assign_ronald', m);
                  setMenuOpen(false);
                }}
              >
                Assign to Ronald
              </button>
              <div className={styles.rowMenuSep} />
              <button
                type="button"
                className={styles.danger}
                onClick={() => {
                  onAction('spam', m);
                  setMenuOpen(false);
                }}
              >
                <AlertCircle size={13} strokeWidth={2} />
                Mark as spam
              </button>
              {canDelete && (
                <button
                  type="button"
                  className={styles.danger}
                  onClick={() => {
                    onDelete(m);
                    setMenuOpen(false);
                  }}
                >
                  <Trash2 size={13} strokeWidth={2} />
                  Delete
                </button>
              )}
            </div>
          </>
        )}
      </td>
    </tr>
  );
}

/** Header checkbox. `indeterminate` is a DOM property with no HTML attribute,
 *  so it can only be set through a ref. */
function SelectAllCheckbox({
  state,
  onToggle,
}: {
  state: 'none' | 'some' | 'all';
  onToggle: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className={styles.checkbox}
      checked={state === 'all'}
      onChange={onToggle}
      aria-label={
        state === 'all'
          ? 'Clear selection of all messages in view'
          : 'Select all messages in view'
      }
    />
  );
}

export default function MessagesListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  // Hidden for the public demo account, which has no mailbox — a prospect
  // clicking through to a login screen they can't pass is a dead end.
  const mailboxAddress =
    user ? `${user.username.toLowerCase()}@${MAIL_DOMAIN}` : null;
  // Owner-only (2026-08-19). The server's `owner_only` 403 is the enforcement;
  // this keeps staff from ever meeting a control that only 403s. It gates BOTH
  // ways into a delete — the multi-select column with its selection bar, and
  // the row menu's Delete item.
  const canDelete = canDeleteMessages(user);
  const [messages, setMessages] = useState<Message[]>(() => loadMessages());
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('unread');
  const [q, setQ] = useState('');
  const [kbdHint, setKbdHint] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Ids awaiting confirmation. null = dialog closed; deletion is irreversible,
  // so nothing is ever sent without passing through here.
  const [pendingIds, setPendingIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  // The BUTTON is disabled while `deleting`, but a double-click can dispatch
  // both clicks before that state lands (and runDelete's own read of it is a
  // stale closure). A ref is set synchronously, so the second call bails —
  // otherwise the re-run's all-`missing` toast would overwrite the true one.
  const deleteInFlight = useRef(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Track which messages were 'new' on first server-load so the dot pulse
  // fires exactly once per page-mount cycle. Populated lazily by the refresh
  // effect below (cache may be empty on initial render before the API
  // resolves).
  const freshIds = useRef<Set<string>>(new Set()).current;
  const freshIdsSeeded = useRef(false);

  const refresh = () => setMessages(loadMessages());

  // Pull fresh messages from the API on mount, then seed freshIds from the
  // first non-empty load. Subsequent local mutations (read/archive/etc.) hit
  // the optimistic cache via refresh() — no need to re-fetch.
  useEffect(() => {
    let cancelled = false;
    refreshMessages().then(() => {
      if (cancelled) return;
      const fresh = loadMessages();
      if (!freshIdsSeeded.current) {
        fresh
          .filter((m) => m.status === 'new')
          .forEach((m) => freshIds.add(m.id));
        freshIdsSeeded.current = true;
      }
      setMessages(fresh);
    });
    return () => {
      cancelled = true;
    };
  }, [freshIds]);

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.matches?.('input, textarea')) return;
      const k = e.key.toLowerCase();
      if (['j', 'k', 'e', 'r', '/'].includes(k)) setKbdHint(true);
      if (e.key === '/') {
        e.preventDefault();
        document
          .querySelector<HTMLInputElement>(`.${styles.searchInput}`)
          ?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(() => {
    let rows = messages.slice();
    if (filter === 'archived') {
      rows = rows.filter((m) => m.status === 'archived');
    } else {
      rows = rows.filter((m) => m.status !== 'archived');
      if (filter !== 'all') rows = rows.filter((m) => m.type === filter);
    }
    if (q) {
      const Q = q.toLowerCase();
      rows = rows.filter((m) => {
        const blob = JSON.stringify(m.payload).toLowerCase();
        return blob.includes(Q) || subjectFor(m).toLowerCase().includes(Q);
      });
    }
    if (sort === 'newest') {
      rows.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
    } else if (sort === 'oldest') {
      rows.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
    } else {
      // unread first, then newest within
      rows.sort((a, b) => {
        if ((a.status === 'new') !== (b.status === 'new')) {
          return a.status === 'new' ? -1 : 1;
        }
        return +new Date(b.created_at) - +new Date(a.created_at);
      });
    }
    return rows;
  }, [messages, filter, sort, q]);

  const visibleIds = useMemo(() => filtered.map((m) => m.id), [filtered]);

  // Rows selected AND still on screen — the only ones any bulk action touches.
  const chosenIds = useMemo(
    () => visibleSelectedIds(selected, visibleIds),
    [selected, visibleIds],
  );

  // A filter change (or a completed delete) must not leave invisible rows armed
  // for deletion. pruneSelection returns the same Set when nothing dropped, so
  // this settles in one pass instead of looping.
  useEffect(() => {
    setSelected((prev) => pruneSelection(prev, visibleIds));
  }, [visibleIds]);

  // Group by day-bucket cluster header.
  const grouped = useMemo<
    Array<{ kind: 'header'; label: string } | { kind: 'row'; m: Message }>
  >(() => {
    const out: Array<{ kind: 'header'; label: string } | { kind: 'row'; m: Message }> = [];
    let last: string | null = null;
    for (const m of filtered) {
      const b = dayBucket(m.created_at);
      if (b !== last) {
        out.push({ kind: 'header', label: b });
        last = b;
      }
      out.push({ kind: 'row', m });
    }
    return out;
  }, [filtered]);

  const counts = useMemo(
    () => ({
      all: messages.filter((m) => m.status !== 'archived').length,
      contact: messages.filter(
        (m) => m.type === 'contact' && m.status !== 'archived',
      ).length,
      join: messages.filter(
        (m) => m.type === 'join' && m.status !== 'archived',
      ).length,
      keyword: messages.filter(
        (m) => m.type === 'keyword' && m.status !== 'archived',
      ).length,
      archived: messages.filter((m) => m.status === 'archived').length,
    }),
    [messages],
  );

  function onAction(kind: ActionKind, m: Message) {
    switch (kind) {
      case 'archive':
        archiveMsg(m.id);
        setToast('Archived');
        break;
      case 'spam':
        markSpam(m.id);
        setToast('Marked as spam');
        break;
      case 'toggle_read':
        toggleRead(m.id);
        setToast(m.status === 'new' ? 'Marked read' : 'Marked unread');
        break;
      case 'assign_daniel':
        assignTo(m.id, 'Daniel');
        setToast('Assigned to Daniel');
        break;
      case 'assign_anthony':
        assignTo(m.id, 'Anthony');
        setToast('Assigned to Anthony');
        break;
      case 'assign_ronald':
        assignTo(m.id, 'Ronald');
        setToast('Assigned to Ronald');
        break;
    }
    refresh();
  }

  /** One id goes through DELETE /{id}; a 404 there means the same thing the
   *  bulk route calls `missing`, so both paths report identically. */
  async function deleteOne(id: string): Promise<BulkDeleteResult> {
    try {
      await adminApi.deleteMessage(id);
      return { deleted: 1, missing: 0 };
    } catch (err) {
      if (httpFailure(err).status === 404) return { deleted: 0, missing: 1 };
      throw err;
    }
  }

  async function runDelete(ids: string[]) {
    setPendingIds(null);
    if (ids.length === 0 || deleteInFlight.current) return;
    deleteInFlight.current = true;
    setDeleting(true);
    setDeleteError(null);

    const tally: BulkDeleteResult = { deleted: 0, missing: 0 };
    let failure: unknown = null;
    try {
      if (ids.length === 1) {
        const one = await deleteOne(ids[0]);
        tally.deleted += one.deleted;
        tally.missing += one.missing;
      } else {
        // Batched: the route 422s past BULK_DELETE_MAX ids, and an inbox
        // filtered to "All" can hold more than that.
        for (const batch of chunkIds(ids)) {
          const part = normalizeBulkResult(
            await adminApi.bulkDeleteMessages(batch),
          );
          tally.deleted += part.deleted;
          tally.missing += part.missing;
        }
      }
    } catch (err) {
      failure = err;
    } finally {
      // Re-read the server either way: a failure can still be PARTIAL (one
      // batch landed, the next did not), and the list must not keep showing
      // rows that are gone. The prune effect drops their selection on the
      // next render.
      //
      // `finally`, not trailing statements: the in-flight ref is what re-arms
      // the Delete button, so ANY future throw between here and the reset
      // would wedge it shut for the rest of the session with no way back but
      // a reload (review-caught — safe today only because nothing in this
      // window happens to throw).
      await refreshMessages();
      setMessages(loadMessages());
      setDeleting(false);
      deleteInFlight.current = false;
    }

    if (failure) {
      const { status, detail } = httpFailure(failure);
      // The demo 403 already raised the console-wide read-only notice inside
      // the axios interceptor — a second sentence here would just repeat it.
      {
        // `tally` is passed, NOT dropped: a batch that landed before the throw
        // deleted real messages for good, and the operator has to be told.
        // The owner-only 403 gets a sentence rather than the raw `owner_only`
        // code — reachable if a role changed under a tab that still has the
        // button (review-caught).
        const reason = isOwnerOnly(status, detail)
          ? OWNER_ONLY_MESSAGE
          : apiErrorDetail(failure);
        setDeleteError(deleteFailureMessage(tally, reason));
      }
      return;
    }

    // Only the ids this run touched — a row deleted from its own menu must not
    // clear a selection the operator built up elsewhere.
    setSelected((prev) => deselectIds(prev, ids));
    setToast(deleteOutcomeMessage(tally));
  }

  const empty = filtered.length === 0;
  const isInboxZero = empty && q === '' && filter === 'all';
  const headerState = headerSelectionState(selected, visibleIds);
  // Keeps <col>, <td> and every colSpan agreeing in BOTH states.
  const columnCount = canDelete ? CONTENT_COLUMNS + 1 : CONTENT_COLUMNS;
  const confirmCopy = confirmDeleteCopy(pendingIds?.length ?? 0);

  const FILTER_TABS: ReadonlyArray<[Filter, string, number]> = [
    ['all', 'All', counts.all],
    ['contact', 'Contact', counts.contact],
    ['join', 'Join', counts.join],
    ['keyword', 'Keyword', counts.keyword],
    ['archived', 'Archived', counts.archived],
  ];

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      <div className={styles.pageHead}>
        <div className={styles.pageHeadMain}>
          <h1 className={styles.title}>Messages</h1>
          <p className={styles.subtitle}>Inbound from the public site</p>
        </div>
        {mailboxAddress && (
          <a
            className={styles.mailboxLink}
            href={WEBMAIL_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className={styles.mailboxLabel}>Open mailbox</span>
            <span className={styles.mailboxAddress}>{mailboxAddress}</span>
          </a>
        )}
      </div>

      <div className={styles.panel}>
        <div className={styles.toolbar}>
          <div className={styles.chips}>
            {FILTER_TABS.map(([k, l, n]) => (
              <button
                key={k}
                type="button"
                className={`${styles.filterChip} ${filter === k ? styles.active : ''}`}
                onClick={() => setFilter(k)}
              >
                {l}
                <span className={styles.chipCount}>{n}</span>
              </button>
            ))}
          </div>

          <div className={styles.tools}>
            <div className={styles.selectWrap}>
              <select
                className={styles.select}
                value={sort}
                onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                  setSort(e.target.value as Sort)
                }
              >
                <option value="unread">Unread first</option>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
              </select>
            </div>

            <div className={styles.search}>
              <Search size={14} strokeWidth={2} />
              <input
                className={styles.searchInput}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
                }}
                placeholder="Search name, email, company, subject…"
              />
            </div>
          </div>
        </div>

        {canDelete && chosenIds.length > 0 && (
          <div className={styles.selBar} onClick={(e) => e.stopPropagation()}>
            <span className={styles.selCount}>
              {selectionLabel(chosenIds.length)}
            </span>
            <div className={styles.selSpacer} />
            <button
              type="button"
              className={styles.selClear}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
            <button
              type="button"
              className={styles.selDelete}
              onClick={() => setPendingIds(chosenIds)}
              disabled={deleting}
            >
              <Trash2 size={13} strokeWidth={2} />
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        )}

        {deleteError && (
          <div className={styles.selError} role="alert">
            <AlertCircle size={14} strokeWidth={2} />
            <span>{deleteError}</span>
            <button
              type="button"
              className={styles.selErrorClose}
              onClick={() => setDeleteError(null)}
              aria-label="Dismiss error"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        )}

        {isInboxZero ? (
          <InboxZeroEmptyState />
        ) : empty ? (
          <div className={styles.emptyState}>
            <span>No messages match this filter.</span>
            <button
              type="button"
              className={styles.clearBtn}
              onClick={() => {
                setFilter('all');
                setQ('');
              }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <table className={styles.table}>
            <colgroup>
              {canDelete && <col style={{ width: 40 }} />}
              <col style={{ width: 26 }} />
              <col style={{ width: 92 }} />
              <col style={{ width: 96 }} />
              {/* sender + subject auto-size to content; subject grows last */}
              <col />
              <col style={{ width: '100%' }} />
              <col style={{ width: 80 }} />
              <col style={{ width: 36 }} />
            </colgroup>
            <thead>
              <tr className={styles.headRow}>
                {canDelete && (
                  <th className={styles.cSel} scope="col">
                    <SelectAllCheckbox
                      state={headerState}
                      onToggle={() =>
                        setSelected((prev) => toggleAllVisible(prev, visibleIds))
                      }
                    />
                  </th>
                )}
                <th colSpan={CONTENT_COLUMNS} scope="col">
                  <span className={styles.srOnly}>Message</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((g, i) =>
                g.kind === 'header' ? (
                  <tr key={`h-${i}`} className={styles.cluster}>
                    <td colSpan={columnCount}>{g.label}</td>
                  </tr>
                ) : (
                  <MessageRow
                    key={g.m.id}
                    m={g.m}
                    onOpen={(id) => navigate(`/admin/messages/${id}`)}
                    onAction={onAction}
                    onDelete={(m) => setPendingIds([m.id])}
                    isFresh={freshIds.has(g.m.id)}
                    selected={selected.has(g.m.id)}
                    onToggleSelect={(id) =>
                      setSelected((prev) => toggleSelected(prev, id))
                    }
                    canDelete={canDelete}
                  />
                ),
              )}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmDialog
        open={pendingIds !== null}
        title={confirmCopy.title}
        message={confirmCopy.message}
        confirmLabel={confirmCopy.confirmLabel}
        cancelLabel="Keep them"
        danger
        onConfirm={() => runDelete(pendingIds ?? [])}
        onCancel={() => setPendingIds(null)}
      />

      <KeyboardHintFooter visible={kbdHint} />

      {toast && <div className={styles.toast}>{toast}</div>}
    </motion.div>
  );
}
