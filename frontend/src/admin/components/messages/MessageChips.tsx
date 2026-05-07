import { AlertCircle, Archive, Briefcase, CheckCircle2, Eye, Hash, Inbox, Mail, Reply } from 'lucide-react';
import type { ComponentType } from 'react';
import type { Message, MessageStatus, MessageType } from '@admin/types/messages';
import { TYPE_META } from './messageHelpers';
import styles from './MessageChips.module.scss';

const TYPE_ICON: Record<MessageType, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  contact: Mail,
  join: Briefcase,
  keyword: Hash,
  reply: Reply,
};

// MSG-0042 designator — JetBrains Mono, mirrors the U1/U2 pattern from the
// public Contact page (datasheet motif).
export function Designator({ seq }: { seq: number }) {
  return (
    <span className={styles.des}>MSG-{String(seq).padStart(4, '0')}</span>
  );
}

export function MessageTypeChip({ type }: { type: MessageType }) {
  const meta = TYPE_META[type];
  return (
    <span
      className={styles.typeChip}
      style={{ color: meta.color, background: meta.tint }}
    >
      {`[${meta.label}]`}
    </span>
  );
}

const SIZE_REM = 32;

export function TypeIcon({ type, size = SIZE_REM }: { type: MessageType; size?: number }) {
  const meta = TYPE_META[type];
  const Icon = TYPE_ICON[type];
  return (
    <span
      className={styles.typeIcon}
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb, ${meta.color} 8%, white)`,
        color: meta.color,
      }}
    >
      <Icon size={Math.round(size * 0.5)} strokeWidth={2} />
    </span>
  );
}

const STATUS_META: Record<
  MessageStatus,
  { label: string; cls: string; Icon: ComponentType<{ size?: number; strokeWidth?: number }> }
> = {
  new: { label: 'New', cls: 'new', Icon: Inbox },
  read: { label: 'Read', cls: 'read', Icon: Eye },
  archived: { label: 'Archived', cls: 'archived', Icon: Archive },
  responded: { label: 'Responded', cls: 'responded', Icon: CheckCircle2 },
};

export function MessageStatusBadge({ status }: { status: MessageStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.Icon;
  return (
    <span className={`${styles.status} ${styles[meta.cls]}`}>
      <Icon size={11} strokeWidth={2.4} />
      {meta.label}
    </span>
  );
}

export function SpamScoreWarning({ score }: { score: number | undefined }) {
  if (!score || score <= 0.6) return null;
  return (
    <span
      className={styles.spam}
      title={`Low confidence sender — score ${score.toFixed(2)}`}
    >
      <AlertCircle size={10} strokeWidth={2.4} />
      spam {score.toFixed(2)}
    </span>
  );
}

interface StatusDotProps {
  status: Message['status'];
  isFresh?: boolean;
}

export function StatusDot({ status, isFresh }: StatusDotProps) {
  if (status === 'new') {
    return <span className={`${styles.dot} ${isFresh ? styles.fresh : ''}`} />;
  }
  if (status === 'read' || status === 'responded') {
    return <span className={`${styles.dot} ${styles.ring}`} />;
  }
  return <span className={`${styles.dot} ${styles.none}`} />;
}
