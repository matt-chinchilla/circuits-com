import { useEffect, useMemo, useState } from 'react';
import GlowButton from '@public/components/widgets/GlowButton';
import Icon from '@shared/components/Icon';
import { api } from '@public/services/api';
import {
  countsLine,
  groupSlots,
  heldLine,
  slotCounts,
  money,
  normalizeCodeInput,
  type ExclusiveTier,
  type QuoteResult,
  type SlotRow,
  type SlotsResponse,
} from './exclusive';
import ExclusiveCheckoutModal from './ExclusiveCheckoutModal';
import styles from './JoinPage.module.scss';
import x from './ExclusiveCheckout.module.scss';

// Stage 02 for Gold and Platinum (spec 2026-09-23 §11): pick an open slot
// IN PAGE (rows select, they never navigate like the Silver board rows),
// optionally apply a rep's code, read the server's price, then hand off to
// Stripe through ExclusiveCheckoutModal.
//
// Honesty rules carried over from the Silver picker:
//   * a failed or unconfigured slot fetch NEVER reads as sold out;
//   * every figure on the ticket is one the server returned (the slots
//     payload's list/founder prices, or /quote's price once a code is in);
//   * a held slot stays listed as "being purchased", and a taken slot stays
//     listed as taken (owner, 2026-09-23) — neither is ever removed.

export interface IconIndex {
  byParent: Map<string, string>;
  byPath: Map<string, string>;
}

interface Props {
  tier: ExclusiveTier;
  tierName: string;
  perks: string[];
  iconIndex: IconIndex;
  initialCode?: string;
  initialSlot?: string;
  /** Bumped by the page after a Back-from-Stripe release settles. */
  refreshKey?: number;
  onAskDesk: () => void;
}

type LoadState = 'loading' | 'ok' | 'unconfigured' | 'error';

type CodeState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; quote: QuoteResult }
  | { kind: 'bad'; message: string }
  | { kind: 'error'; message: string };

const CODE_DEBOUNCE_MS = 400;

const statusOf = (err: unknown): number | undefined =>
  typeof err === 'object' && err !== null
    ? (err as { response?: { status?: number } }).response?.status
    : undefined;

function slotMatches(row: SlotRow, wanted: string): boolean {
  const w = wanted.toLowerCase();
  return (
    row.category_id.toLowerCase() === w ||
    row.path.toLowerCase() === w ||
    row.path.toLowerCase().endsWith(`/${w}`)
  );
}

export default function ExclusiveBuy({
  tier,
  tierName,
  perks,
  iconIndex,
  initialCode,
  initialSlot,
  refreshKey = 0,
  onAskDesk,
}: Props) {
  const [data, setData] = useState<SlotsResponse | null>(null);
  const [load, setLoad] = useState<LoadState>('loading');
  const [retry, setRetry] = useState(0);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [code, setCode] = useState(() => (initialCode ? normalizeCodeInput(initialCode) : ''));
  const [codeState, setCodeState] = useState<CodeState>({ kind: 'idle' });
  const [confirming, setConfirming] = useState(false);

  // The slot list. Re-fetched on tier change, a retry, or a released hold.
  useEffect(() => {
    let cancelled = false;
    setLoad('loading');
    api
      .getExclusiveSlots(tier)
      .then(res => {
        if (cancelled) return;
        setData(res);
        setLoad('ok');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad(statusOf(err) === 404 ? 'unconfigured' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [tier, retry, refreshKey]);

  const rows = useMemo(() => data?.slots ?? [], [data]);
  const groups = useMemo(() => groupSlots(rows, tier), [rows, tier]);
  const selected = rows.find(r => r.category_id === slotId) ?? null;

  // A rep's link names its slot (?slot=): select it — and open its group — the
  // first time the list arrives with that slot open.
  const [wantedSlot, setWantedSlot] = useState(initialSlot ?? null);
  useEffect(() => {
    if (!wantedSlot || rows.length === 0) return;
    const hit = rows.find(r => slotMatches(r, wantedSlot));
    // Held — possibly by this buyer's own abandoned checkout, which the page
    // is releasing right now: keep wanting it until the list is re-read.
    if (hit?.state === 'held') return;
    if (hit?.state === 'open') {
      setSlotId(hit.category_id);
      if (hit.parent_name) setOpenCat(hit.parent_name);
    }
    setWantedSlot(null);
  }, [rows, wantedSlot]);

  // A slot that turned held or vanished (taken) since it was picked is dropped.
  useEffect(() => {
    if (slotId && load === 'ok' && !rows.some(r => r.category_id === slotId && r.state === 'open')) {
      setSlotId(null);
    }
  }, [rows, slotId, load]);

  // The code is checked only once it is complete (8 characters): a partial
  // code has nothing to ask the server, and /quote is rate-limited per IP.
  const normalized = normalizeCodeInput(code);
  const complete = normalized.replace('-', '').length === 8;
  useEffect(() => {
    if (!complete) {
      setCodeState({ kind: 'idle' });
      return undefined;
    }
    let cancelled = false;
    setCodeState({ kind: 'checking' });
    const id = window.setTimeout(() => {
      api
        .quoteExclusive({ tier, code: normalized, category_id: slotId ?? undefined })
        .then(q => {
          if (cancelled) return;
          if (q.code?.accepted) setCodeState({ kind: 'ok', quote: q });
          else
            setCodeState({
              kind: 'bad',
              message: q.code?.message || "This code isn't valid for this purchase.",
            });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const status = statusOf(err);
          setCodeState({
            kind: 'error',
            message:
              status === 429
                ? 'Too many code checks from this network — wait a few minutes and try again.'
                : 'We could not check that code just now. You can still buy at the Founder’s Deal, or try again.',
          });
        });
    }, CODE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [complete, normalized, tier, slotId]);

  const accepted = codeState.kind === 'ok' ? codeState.quote : null;
  const listUsd = accepted?.list_usd ?? data?.list_usd ?? null;
  const founderUsd = accepted?.founder_usd ?? data?.founder_usd ?? null;
  const priceUsd = accepted?.price_usd ?? founderUsd;
  const savingsUsd = accepted?.savings_usd ?? null;
  const slotGone = accepted?.slot_state === 'taken' || accepted?.slot_state === 'held';

  const needle = query.trim().toLowerCase();
  const matchGroups = useMemo(() => {
    if (!needle) return groups;
    return groups
      .map(g =>
        g.name.toLowerCase().includes(needle)
          ? g
          : { ...g, rows: g.rows.filter(r => r.name.toLowerCase().includes(needle)) },
      )
      .filter(g => g.rows.length > 0);
  }, [groups, needle]);
  const openGroup = needle ? null : (groups.find(g => g.key === openCat) ?? null);

  const iconFor = (r: SlotRow) =>
    tier === 'platinum' ? iconIndex.byParent.get(r.name) : iconIndex.byPath.get(r.path);

  const slotButton = (r: SlotRow) => {
    const held = r.state === 'held';
    const taken = r.state === 'taken';
    const blocked = held || taken;
    const on = r.category_id === slotId;
    return (
      <li key={r.category_id}>
        <button
          type="button"
          className={[styles.board, x.slotRow, held ? x.slotHeld : '', taken ? x.slotTaken : '']
            .filter(Boolean)
            .join(' ')}
          aria-pressed={on}
          aria-disabled={blocked || undefined}
          aria-label={taken ? `${r.name} — taken` : undefined}
          title={taken ? `${r.name} already has a ${tierName} sponsor` : undefined}
          onClick={() => {
            if (blocked) return;
            setWantedSlot(null);
            setSlotId(on ? null : r.category_id);
          }}
        >
          <span className={x.slotMark} aria-hidden="true">
            {taken ? '' : <>&#10003;</>}
          </span>
          {iconFor(r) && (
            <span className={styles.boardIcon} aria-hidden="true">
              <Icon name={iconFor(r)} />
            </span>
          )}
          <span className={styles.boardName} data-name="">
            {r.name}
          </span>
          {taken ? (
            <span className={x.takenTag}>Taken</span>
          ) : held ? (
            <span className={x.heldNote}>{heldLine(r.held_until)}</span>
          ) : (
            <span className={x.openTag}>Open</span>
          )}
        </button>
      </li>
    );
  };

  // ── degraded states: never "sold out" unless the server said so ──────────
  if (load !== 'ok' || rows.length === 0) {
    const line =
      load === 'loading'
        ? `Loading the open ${tierName} slots…`
        : load === 'error'
          ? `The live ${tierName} list isn’t loading right now — that’s a display problem, not a sold-out one. The partners desk has the current openings and can place you directly.`
          : load === 'unconfigured'
            ? `Self-serve checkout is switched off on this deployment. The partners desk sells ${tierName} directly, at the same Founder’s Deal price.`
            : `Every ${tierName} slot is taken right now. The desk keeps the list of what opens next and can hold you the first one.`;
    return (
      <div className={x.buy}>
        <p className={x.state} role={load === 'error' ? 'alert' : undefined}>
          {line}
        </p>
        {load !== 'loading' && (
          <div className={x.stateCta}>
            <GlowButton type="button" variant="primary" onClick={onAskDesk}>
              Ask about {tierName} {'→'}
            </GlowButton>
            {load === 'error' && (
              <button type="button" className={styles.linkBtn} onClick={() => setRetry(n => n + 1)}>
                Try loading the list again
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const counts = slotCounts(rows);

  return (
    <div className={x.buy}>
      <div className={x.buyGrid}>
        <div>
          <p className={x.pickHead}>
            {countsLine(counts)}
            {tier === 'gold' ? ' — one sponsor per subcategory' : ' — one sponsor per category'}
          </p>
          {counts.open === 0 && (
            <p className={x.allTaken}>
              Every {tierName} slot is taken right now. The partners desk keeps a waitlist and
              can hold you the first one that opens.{' '}
              <button type="button" className={styles.linkBtn} onClick={onAskDesk}>
                Ask the desk
              </button>
            </p>
          )}
          {tier === 'gold' ? (
            <>
              <input
                type="text"
                className={styles.search}
                placeholder="Search subcategories — amplifiers, sensors, connectors…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                aria-label={`Search ${tierName} slots`}
              />
              {needle ? (
                matchGroups.length === 0 ? (
                  <p className={styles.pickerNote}>
                    No subcategory matches &ldquo;{query}&rdquo;.{' '}
                    <button type="button" className={styles.linkBtn} onClick={onAskDesk}>
                      Ask the desk
                    </button>
                  </p>
                ) : (
                  matchGroups.map(g => (
                    <div key={g.key} className={styles.group}>
                      <h4 className={styles.groupHead}>
                        <Icon name={iconIndex.byParent.get(g.name)} />
                        {g.name}
                      </h4>
                      <ul className={styles.boardList}>{g.rows.map(slotButton)}</ul>
                    </div>
                  ))
                )
              ) : (
                <>
                  <div className={styles.boardCatGrid}>
                    {groups.map(g => {
                      const on = openCat === g.key;
                      const groupCounts = slotCounts(g.rows);
                      const hasPick = g.rows.some(r => r.category_id === slotId);
                      return (
                        <button
                          type="button"
                          key={g.key}
                          className={styles.boardCat}
                          aria-expanded={on}
                          aria-controls="join-slot-panel"
                          onClick={() => setOpenCat(on ? null : g.key)}
                        >
                          <span className={styles.boardCatIcon} aria-hidden="true">
                            <Icon name={iconIndex.byParent.get(g.name)} />
                          </span>
                          <span className={styles.boardCatBody}>
                            <span className={styles.boardCatName}>{g.name}</span>
                            <span className={styles.boardCatSub}>
                              {countsLine(groupCounts)}
                              {hasPick && <em> · your pick</em>}
                            </span>
                          </span>
                          <span className={styles.boardCatMark} aria-hidden="true">
                            {on ? '−' : '+'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {openGroup && (
                    <div className={styles.catPanel} key={openGroup.key} id="join-slot-panel">
                      <div className={styles.catPanelHead}>
                        <Icon name={iconIndex.byParent.get(openGroup.name)} />
                        <strong>{openGroup.name}</strong>
                        <button
                          type="button"
                          className={styles.catPanelClose}
                          onClick={() => setOpenCat(null)}
                          aria-label="Collapse category"
                        >
                          &#215;
                        </button>
                      </div>
                      <ul className={styles.boardList}>{openGroup.rows.map(slotButton)}</ul>
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <ul className={x.flatList}>{rows.map(slotButton)}</ul>
          )}
        </div>

        <aside className={x.ticket} aria-label="Price summary">
          <span className={x.stub} aria-hidden="true" />
          <div className={x.ticketBody}>
            {selected ? (
              <p className={x.ticketSlot}>
                {selected.name}
                <small>
                  {tierName}
                  {selected.parent_name ? ` · ${selected.parent_name}` : ' · top-level category'}
                </small>
              </p>
            ) : (
              <p className={x.ticketEmpty}>
                No slot picked yet
                <small>{tier === 'gold' ? 'Choose a subcategory' : 'Choose a category'} to see it here.</small>
              </p>
            )}
            {listUsd != null && founderUsd != null && priceUsd != null && (
              <>
                <dl className={x.lines}>
                  <div className={x.struck}>
                    <dt>List price</dt>
                    <dd>{money(listUsd)}/mo</dd>
                  </div>
                  <div className={accepted ? x.struck : x.deal}>
                    <dt>Founder&rsquo;s Deal</dt>
                    <dd>{money(founderUsd)}/mo</dd>
                  </div>
                  {accepted && (
                    <div className={x.deal}>
                      <dt>With your rep&rsquo;s code</dt>
                      <dd>{money(accepted.price_usd)}/mo</dd>
                    </div>
                  )}
                </dl>
                <div className={x.total}>
                  <span className={x.totalLabel}>You pay</span>
                  <p className={x.totalLine}>
                    <strong key={priceUsd} className={x.tick}>
                      {money(priceUsd)}
                    </strong>
                    <span className={x.totalPer}>/month</span>
                  </p>
                  {savingsUsd != null && savingsUsd > 0 && (
                    <p className={x.save}>{money(savingsUsd)}/month off the list price</p>
                  )}
                  <p className={x.terms}>Tax included · 12-month minimum · billed monthly</p>
                </div>
              </>
            )}
            {slotGone && selected && (
              <p className={x.warn} role="alert">
                {accepted?.slot_state === 'held'
                  ? 'Someone is paying for this slot right now — pick another.'
                  : 'This slot was just taken — pick another.'}
              </p>
            )}
            <div className={x.codeField}>
              <label className={x.codeLabel} htmlFor="join-rep-code">
                Code from your sales rep
              </label>
              <div className={x.codeRow}>
                <input
                  id="join-rep-code"
                  type="text"
                  inputMode="text"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={20}
                  className={x.codeInput}
                  data-state={
                    codeState.kind === 'ok' ? 'ok' : codeState.kind === 'bad' ? 'bad' : undefined
                  }
                  placeholder="XXXX-XXXX"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  onBlur={() => setCode(c => normalizeCodeInput(c))}
                  aria-describedby="join-rep-code-status"
                />
                {code && (
                  <button
                    type="button"
                    className={x.codeClear}
                    onClick={() => setCode('')}
                    aria-label="Remove the code"
                  >
                    &#215;
                  </button>
                )}
              </div>
              <p
                id="join-rep-code-status"
                className={x.codeStatus}
                data-state={
                  codeState.kind === 'ok'
                    ? 'ok'
                    : codeState.kind === 'bad' || codeState.kind === 'error'
                      ? 'bad'
                      : undefined
                }
                aria-live="polite"
              >
                {codeState.kind === 'checking'
                  ? 'Checking the code…'
                  : codeState.kind === 'ok'
                    ? `Code ${normalized} applied.`
                    : codeState.kind === 'bad' || codeState.kind === 'error'
                      ? codeState.message
                      : code && !complete
                        ? 'Codes are 8 characters, like AB12-CD34.'
                        : 'Optional — the Founder’s Deal applies either way.'}
              </p>
            </div>
            <GlowButton
              type="button"
              variant="gold"
              className={x.buyBtn}
              disabled={!selected || slotGone || codeState.kind === 'checking'}
              onClick={() => setConfirming(true)}
            >
              {selected ? <>Buy this slot {'→'}</> : 'Pick a slot first'}
            </GlowButton>
            <p className={x.holdNote}>
              Checkout holds the slot for you while you pay on Stripe&rsquo;s secure page.
            </p>
            <p className={x.desk}>
              Prefer a human?{' '}
              <button type="button" className={styles.linkBtn} onClick={onAskDesk}>
                Ask the desk
              </button>{' '}
              — same price either way.
            </p>
          </div>
        </aside>
      </div>

      {confirming && selected && priceUsd != null && (
        <ExclusiveCheckoutModal
          tier={tier}
          tierName={tierName}
          slot={selected}
          priceUsd={priceUsd}
          listUsd={listUsd}
          code={accepted ? normalized : undefined}
          perks={perks}
          onClose={() => setConfirming(false)}
          onAskDesk={() => {
            setConfirming(false);
            onAskDesk();
          }}
          onSlotLost={() => {
            setConfirming(false);
            setRetry(n => n + 1);
          }}
        />
      )}
    </div>
  );
}
