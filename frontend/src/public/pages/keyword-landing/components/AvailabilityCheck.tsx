import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import GlowButton from '@public/components/widgets/GlowButton';
import { api } from '@public/services/api';
import type { Sponsor } from '@public/types/sponsor';
import styles from './AvailabilityCheck.module.scss';

// AvailabilityCheck — debounced live check against /api/sponsors/keyword/<kw>/.
// 200 OK → taken, 404 → available, anything else → error. The hosting page
// owns "what happens next" via onRequest (opens RequestModal) and
// onViewSponsor (navigates to /keyword/<kw>) so this widget stays pure UI.

type CheckState = 'idle' | 'loading' | 'available' | 'taken' | 'error';

interface AvailabilityCheckProps {
  initialKeyword?: string;
  /** Open the RequestModal pre-filled with this keyword. */
  onRequest: (keyword: string) => void;
  /** Navigate to /keyword/<slug>. Slug is the normalized keyword. */
  onViewSponsor: (slug: string) => void;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export default function AvailabilityCheck({
  initialKeyword = '',
  onRequest,
  onViewSponsor,
}: AvailabilityCheckProps) {
  const [value, setValue] = useState(initialKeyword);
  const [state, setState] = useState<CheckState>('idle');
  const [sponsor, setSponsor] = useState<Sponsor | null>(null);
  // Bumping retryNonce re-fires the effect for the Retry button.
  const [retryNonce, setRetryNonce] = useState(0);
  // Counter ref so a slow inflight request can't overwrite a newer state.
  const reqIdRef = useRef(0);

  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      setState('idle');
      setSponsor(null);
      return;
    }

    setState('loading');
    const myId = ++reqIdRef.current;

    const t = window.setTimeout(() => {
      api
        .getSponsorByKeyword(norm(trimmed))
        .then((data) => {
          if (myId !== reqIdRef.current) return;
          setSponsor(data);
          setState('taken');
        })
        .catch((err: unknown) => {
          if (myId !== reqIdRef.current) return;
          // 404 from the API = no sponsor owns this keyword = AVAILABLE.
          if (axios.isAxiosError(err) && err.response?.status === 404) {
            setSponsor(null);
            setState('available');
          } else {
            console.error('[AvailabilityCheck] sponsor lookup failed', err);
            setState('error');
          }
        });
    }, 420);

    return () => {
      window.clearTimeout(t);
      // Invalidate any inflight request on unmount/value-change so its
      // response can't setState after we're gone.
      reqIdRef.current++;
    };
  }, [value, retryNonce]);

  const keyDisp = value.trim() || '—';
  const slug = norm(value);

  return (
    <div className={styles.avail}>
      <div className={styles.availWrap}>
        <label className={styles.availLabel} htmlFor="avail-input">
          <span>CHECK KEYWORD AVAILABILITY</span>
          <span className={styles.availLabelRev}>/REV-A</span>
        </label>

        <div className={`${styles.availField} ${styles[`availField_${state}`]}`}>
          <span className={styles.availPre} aria-hidden="true">
            circuitcenter.ai/keyword/
          </span>
          <input
            id="avail-input"
            type="text"
            inputMode="text"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={styles.availInput}
            placeholder="rp2040"
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/^\s+/, ''))}
            aria-describedby="avail-help avail-status"
          />
          <span className={styles.availStatusIco} aria-hidden="true">
            {state === 'loading' && <span className={styles.availSpinner} />}
            {state === 'available' && '✓'}
            {state === 'taken' && '●'}
            {state === 'error' && '!'}
            {state === 'idle' && <span className={styles.availCaret}>{'›'}</span>}
          </span>
        </div>

        <p id="avail-help" className={styles.availHelp}>
          Lowercase, no spaces, hyphens for multi-word. e.g.{' '}
          <code onClick={() => setValue('rp2040')}>rp2040</code>,{' '}
          <code onClick={() => setValue('low-noise op-amps')}>low-noise op-amps</code>,{' '}
          <code onClick={() => setValue('ferrite-bead')}>ferrite-bead</code>.
        </p>
      </div>

      {/* Result card — live region announces state changes. */}
      <div className={styles.availResult} aria-live="polite" id="avail-status">
        {state === 'idle' && (
          <div className={`${styles.availCard} ${styles.availCard_idle}`}>
            <span className={styles.availCardTag}>STATUS · WAITING</span>
            <p>Start typing a keyword above. We'll tell you whether it's claimed in under a second.</p>
          </div>
        )}

        {state === 'loading' && (
          <div className={`${styles.availCard} ${styles.availCard_loading}`}>
            <span className={styles.availCardTag}>STATUS · CHECKING</span>
            <p>
              Looking up <code>{keyDisp}</code> against the active sponsor index…
            </p>
          </div>
        )}

        {state === 'available' && (
          <div className={`${styles.availCard} ${styles.availCard_available}`}>
            <span className={styles.availCardTag}>STATUS · AVAILABLE</span>
            <h3>
              <code>{keyDisp}</code> is open.
            </h3>
            <p>
              No active sponsor owns this keyword. Claim it before someone else does — typical lead
              time is 48 hours from contract to live landing card.
            </p>
            <div className={styles.availActions}>
              <GlowButton variant="primary" onClick={() => onRequest(keyDisp)}>
                Request this keyword &rarr;
              </GlowButton>
              <GlowButton variant="ghost" onClick={() => onViewSponsor(slug)}>
                Preview the landing card
              </GlowButton>
            </div>
          </div>
        )}

        {state === 'taken' && sponsor && (
          <div className={`${styles.availCard} ${styles.availCard_taken}`}>
            <span className={styles.availCardTag}>STATUS · CLAIMED</span>
            <h3>
              <code>{keyDisp}</code> is taken.
            </h3>
            <p>
              Sponsored by <strong>{sponsor.supplier_name}</strong>
              {sponsor.description ? ` · ${sponsor.description.slice(0, 80)}` : ''}
            </p>
            <div className={styles.availActions}>
              <GlowButton variant="ghost" onClick={() => onViewSponsor(slug)}>
                See {sponsor.supplier_name}'s page &rarr;
              </GlowButton>
              <GlowButton variant="primary" onClick={() => onRequest(`${keyDisp}-alt`)}>
                Suggest a related keyword
              </GlowButton>
            </div>
          </div>
        )}

        {state === 'error' && (
          <div className={`${styles.availCard} ${styles.availCard_error}`}>
            <span className={styles.availCardTag}>STATUS · ERROR</span>
            <p>We couldn't reach the sponsor index. Check your connection or try again in a moment.</p>
            <div className={styles.availActions}>
              <GlowButton variant="ghost" onClick={() => setRetryNonce((n) => n + 1)}>
                Retry
              </GlowButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
