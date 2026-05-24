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
import {
  archive as archiveMsg,
  assignTo,
  loadMessages,
  markSpam,
  refreshMessages,
  toggleRead,
} from '@admin/services/messageStore';
import type { Message } from '@admin/types/messages';
import styles from './MessagesListPage.module.scss';

type Filter = 'all' | 'contact' | 'join' | 'keyword' | 'archived';
type Sort = 'unread' | 'newest' | 'oldest';

interface RowProps {
  m: Message;
  onOpen: (id: string) => void;
  onAction: (kind: ActionKind, m: Message) => void;
  isFresh: boolean;
}

type ActionKind =
  | 'toggle_read'
  | 'archive'
  | 'assign_john'
  | 'assign_mike'
  | 'spam';

function MessageRow({ m, onOpen, onAction, isFresh }: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const rowClass = [
    styles.row,
    m.status === 'new' && styles.isNew,
    m.status === 'archived' && styles.isArc,
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
                  onAction('assign_john', m);
                  setMenuOpen(false);
                }}
              >
                Assign to John
              </button>
              <button
                type="button"
                onClick={() => {
                  onAction('assign_mike', m);
                  setMenuOpen(false);
                }}
              >
                Assign to Mike
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
            </div>
          </>
        )}
      </td>
    </tr>
  );
}

export default function MessagesListPage() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>(() => loadMessages());
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('unread');
  const [q, setQ] = useState('');
  const [kbdHint, setKbdHint] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

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
      case 'assign_john':
        assignTo(m.id, 'john');
        setToast('Assigned to John');
        break;
      case 'assign_mike':
        assignTo(m.id, 'mike');
        setToast('Assigned to Mike');
        break;
    }
    refresh();
  }

  const empty = filtered.length === 0;
  const isInboxZero = empty && q === '' && filter === 'all';

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
        <h1 className={styles.title}>Messages</h1>
        <p className={styles.subtitle}>Inbound from the public site</p>
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
              <col style={{ width: 32 }} />
              <col style={{ width: 92 }} />
              <col style={{ width: 96 }} />
              {/* sender + subject auto-size to content; subject grows last */}
              <col />
              <col style={{ width: '100%' }} />
              <col style={{ width: 80 }} />
              <col style={{ width: 36 }} />
            </colgroup>
            <tbody>
              {grouped.map((g, i) =>
                g.kind === 'header' ? (
                  <tr key={`h-${i}`} className={styles.cluster}>
                    <td colSpan={7}>{g.label}</td>
                  </tr>
                ) : (
                  <MessageRow
                    key={g.m.id}
                    m={g.m}
                    onOpen={(id) => navigate(`/admin/messages/${id}`)}
                    onAction={onAction}
                    isFresh={freshIds.has(g.m.id)}
                  />
                ),
              )}
            </tbody>
          </table>
        )}
      </div>

      <KeyboardHintFooter visible={kbdHint} />

      {toast && <div className={styles.toast}>{toast}</div>}
    </motion.div>
  );
}
