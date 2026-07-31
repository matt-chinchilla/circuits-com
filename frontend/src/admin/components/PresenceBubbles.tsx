import { useEffect, useState } from 'react';
import { adminApi } from '@admin/services/adminApi';
import type { PresenceUser } from '@admin/services/adminApi';
import styles from './PresenceBubbles.module.scss';

/**
 * "Who's on the site with me" — Google-Drive-style stacked avatar bubbles for
 * every OTHER admin currently in the console. Lives inside the topbar control
 * pill, left of the theme toggle.
 *
 * Best-effort by design: the roster is an in-memory server-side dict, so a
 * failed (or empty) ping renders NOTHING — never an error state. Presence is
 * ambient information; it must not be able to shout.
 */

// Heartbeat cadence. The backend TTL is 75s, so one dropped ping is survivable.
const PING_MS = 30_000;
const MAX_VISIBLE = 4;

// Stable per-user accent, hashed from the username so a given person keeps the
// same colour across sessions, browsers, and roster order.
const ACCENTS = [
  'var(--a-primary)',
  'var(--a-blue)',
  'var(--a-purple)',
  'var(--a-grad-gold)',
] as const;

function accentFor(username: string): string {
  // djb2-ish; `>>> 0` keeps it an unsigned 32-bit int so the modulo can't go
  // negative on long names.
  let hash = 0;
  for (let i = 0; i < username.length; i += 1) {
    hash = (hash * 33 + username.charCodeAt(i)) >>> 0;
  }
  return ACCENTS[hash % ACCENTS.length];
}

function labelOf(person: PresenceUser): string {
  return person.name?.trim() || person.username;
}

function initialsOf(person: PresenceUser): string {
  const label = labelOf(person);
  const words = label.trim().split(/\s+/);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return label.slice(0, 2).toUpperCase();
}

interface PresenceBubblesProps {
  /** Username of the signed-in admin — excluded from the stack, since their own
   *  avatar chip already anchors the right end of the pill. */
  selfUsername?: string;
}

export default function PresenceBubbles({ selfUsername }: PresenceBubblesProps) {
  const [others, setOthers] = useState<PresenceUser[]>([]);

  // Heartbeat: ping on mount, then every 30s. Cancel-flag law — the cleanup
  // both clears the interval and blocks a late .then from setting state on an
  // unmounted component (a ping in flight when the admin signs out).
  useEffect(() => {
    let cancelled = false;
    const self = (selfUsername ?? '').toLowerCase();

    const ping = () => {
      adminApi
        .pingPresence()
        .then((roster) => {
          if (cancelled) return;
          setOthers(roster.filter((p) => p.username.toLowerCase() !== self));
        })
        .catch(() => {
          if (cancelled) return;
          setOthers([]); // best-effort: no bubbles, no error UI
        });
    };

    ping();
    const timer = setInterval(ping, PING_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selfUsername]);

  if (others.length === 0) return null;

  const shown = others.slice(0, MAX_VISIBLE);
  const overflow = others.length - shown.length;

  return (
    <div
      className={styles.stack}
      role="group"
      aria-label={`${others.length} other admin${others.length === 1 ? '' : 's'} online`}
    >
      {shown.map((person) => (
        <span
          key={person.user_id}
          className={styles.bubble}
          style={{ borderColor: accentFor(person.username) }}
          title={`${labelOf(person)} — online`}
        >
          {initialsOf(person)}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className={`${styles.bubble} ${styles.overflow}`}
          title={others
            .slice(MAX_VISIBLE)
            .map(labelOf)
            .join(', ')}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
