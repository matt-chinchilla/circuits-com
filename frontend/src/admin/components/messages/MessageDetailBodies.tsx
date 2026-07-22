import { ExternalLink, Hash } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Message } from '@admin/types/messages';
import { findSupplierMatch } from './messageHelpers';
import styles from './MessageDetailBodies.module.scss';

interface SupplierLite {
  id: string;
  name: string;
}

// === CONTACT — letter-style narrative ====================================

export function ContactBody({
  m,
}: {
  m: Extract<Message, { type: 'contact' }>;
}) {
  const initials = m.payload.name
    .split(' ')
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className={styles.contactBody}>
      <aside className={styles.contactSender}>
        <div className={styles.senderAvatar}>{initials}</div>
        <div className={styles.senderName}>{m.payload.name}</div>
        <a className={styles.senderEmail} href={`mailto:${m.payload.email}`}>
          {m.payload.email}
        </a>
        {m.payload.reason && (
          <div className={styles.senderReason}>
            REASON · {m.payload.reason.toUpperCase()}
          </div>
        )}
      </aside>

      <article className={styles.contactLetter}>
        <div className={styles.letterBody}>
          {m.payload.message.split('\n').map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
        <div className={styles.forensicStrip}>
          <span>UA · Mozilla/5.0</span>
          <span className={styles.dotSep}>·</span>
          <span>SRC · /contact</span>
          <span className={styles.dotSep}>·</span>
          <span>via circuitcenter.ai form</span>
        </div>
      </article>
    </div>
  );
}

// === JOIN — application-style summary + tier-foil + categories ===========

export function JoinBody({
  m,
  suppliers,
}: {
  m: Extract<Message, { type: 'join' }>;
  suppliers?: SupplierLite[];
}) {
  const supplierMatch = findSupplierMatch(suppliers, m.payload.company_name);
  const tier = m.payload.tier ?? 'silver';

  return (
    <div className={styles.joinBody}>
      <div className={styles.joinSummary}>
        <div className={styles.jsCell}>
          <div className={styles.jsLbl}>COMPANY</div>
          <div className={styles.jsVal}>{m.payload.company_name}</div>
          {m.payload.website && (
            <a
              className={styles.jsLink}
              href={`https://${m.payload.website}`}
              target="_blank"
              rel="noreferrer"
            >
              {m.payload.website}
              <ExternalLink size={11} strokeWidth={2} />
            </a>
          )}
        </div>

        <div className={styles.jsCell}>
          <div className={styles.jsLbl}>CONTACT</div>
          <div className={styles.jsVal}>{m.payload.contact_person}</div>
          <a className={styles.jsLink} href={`mailto:${m.payload.email}`}>
            {m.payload.email}
          </a>
          {m.payload.phone && (
            <div className={styles.jsSub}>{m.payload.phone}</div>
          )}
        </div>

        <div className={styles.jsCell}>
          <div className={styles.jsLbl}>REQUESTED TIER</div>
          <div className={`${styles.tierFoil} ${styles[`tier-${tier}`]}`}>
            {tier.toUpperCase()}
          </div>
          {supplierMatch && (
            <Link
              className={styles.jsLink}
              to={`/admin/suppliers/${supplierMatch.id}`}
            >
              View company → Suppliers
              <ExternalLink size={11} strokeWidth={2} />
            </Link>
          )}
        </div>
      </div>

      <div className={styles.joinBlock}>
        <div className={styles.jsLbl}>CATEGORIES OF INTEREST</div>
        <div className={styles.catPills}>
          {m.payload.categories_of_interest.map((c) => (
            <span key={c} className={styles.catPill}>
              <Hash size={11} strokeWidth={2} />
              {c}
            </span>
          ))}
        </div>
      </div>

      {m.payload.message && (
        <div className={styles.joinBlock}>
          <div className={styles.jsLbl}>MESSAGE</div>
          <p className={styles.joinMsg}>{m.payload.message}</p>
        </div>
      )}
    </div>
  );
}

// === KEYWORD — keyword as hero =============================================

export function KeywordBody({
  m,
}: {
  m: Extract<Message, { type: 'keyword' }>;
}) {
  return (
    <div className={styles.keywordBody}>
      <div className={styles.kwHero}>
        <div className={styles.kwHeroLbl}>KEYWORD</div>
        <div className={styles.kwHeroTerm}>{m.payload.keyword}</div>
      </div>
      <div className={styles.kwMeta}>
        <dl className={styles.kvList}>
          <div>
            <dt>Company</dt>
            <dd>{m.payload.company_name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd className={styles.mono}>{m.payload.email}</dd>
          </div>
          {m.payload.message && (
            <div>
              <dt>Message</dt>
              <dd>{m.payload.message}</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}
