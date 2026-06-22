// SilverPartners.tsx — Silver-tier multi-sponsor directory.
//
// Verbatim port of the design prototype's SilverPartners.jsx: a silver-PCB board
// whose right rail is a stacking directory of supplier chip-rows — COMPANY ·
// SALES CONTACT · PHONE · EMAIL with click-to-copy — riding a copper bus,
// scrollable past the visible rows. Animated CircuitTraces PCB background,
// silver-tier accent tokens. Sits in the tier row beside the Gold-tier
// SponsorBlock at matched height.
//
// The copy widget (CsCopy) + tel normalizer (csTelHref) are the SHARED board
// helpers from ./csFx (the prototype's window.CsCopy / window.csTelHref). Styling
// is GLOBAL: the `.csb*` board base + `.csb-copy` come from categorySponsor.scss
// (also imported here as a side-effect — Vite dedupes), the `.svp*` directory
// rules from ./silverPartners.scss. The staggered entrance stays WAAPI (NOT
// Framer Motion), visible-by-default (fill:none + positive delays).

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ReactElement } from 'react';
import CircuitTraces from '@public/components/widgets/CircuitTraces';
import type { PartnerSupplier } from '@public/types/sponsor';
import { safeHttpUrl } from '@shared/utils/url';
import { formatPhone } from '@shared/utils/phone';
import { CsCopy, csTelHref } from './csFx';
import './categorySponsor.scss';
import './silverPartners.scss';

const SVP_ENERGIZE_MS = 1500;
// Every subcategory shows at least this many Silver slots: real sponsors fill the
// first rows (U1…Un), the remainder render as "Advertise here" placeholders so an
// open directory reads as available inventory rather than an empty board.
const SVP_SLOTS = 5;

const svHost = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

// Initials letter-mark from a company name (the design's stored `lettermark`,
// derived here rather than carried on the wire).
const svLettermark = (name: string): string =>
  (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '—';

// The chip's view-model — the prototype's `s` shape, mapped from the API
// PartnerSupplier. Per the project null gotcha (`?:` catches undefined but not
// null), every field is coalesced to a plain string / undefined below.
interface SvChipData {
  name: string;
  lettermark: string;
  website: string;
  contact: string;
  role: string;
  phone: string;
  email: string;
}

function toChipData(s: PartnerSupplier): SvChipData {
  return {
    name: s.name,
    lettermark: svLettermark(s.name),
    // The stored website may be a bare host (digikey.com) OR already-schemed.
    // safeHttpUrl prepends a scheme AND validates it's http(s) (rejecting
    // javascript:/data: — stored-XSS guard); null → '' so the `s.website &&`
    // link guard still hides an absent/invalid website.
    website: safeHttpUrl(s.website) ?? '',
    contact: s.contact_name || '',
    role: s.contact_role || '',
    phone: s.phone || '',
    email: s.email || '',
  };
}

const SvChip = ({
  s,
  i,
  live,
  onEnergize,
}: {
  s: SvChipData;
  i: number;
  live: boolean;
  onEnergize: (i: number) => void;
}): ReactElement => (
  <div
    data-enter
    className={'svp-chip' + (live ? ' svp-chip-live' : '')}
    role="button"
    tabIndex={0}
    onClick={(e) => {
      if ((e.target as Element).closest('a, button')) return;
      onEnergize(i);
    }}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onEnergize(i);
      }
    }}
    aria-label={'Energize ' + s.name}
  >
    <span className="svp-via" aria-hidden="true"></span>
    <div className="svp-idcol">
      <span className="svp-refdes">U{i + 1}</span>
      <span className="svp-pad">
        <span className="svp-mark">{s.lettermark}</span>
      </span>
    </div>
    <div className="svp-col">
      <span className="svp-coname">
        <span className="svp-conametxt">{s.name}</span>
      </span>
      {s.website && (
        <a
          className="svp-site"
          href={s.website}
          target="_blank"
          rel="sponsored noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          <span aria-hidden="true">⊕</span> {svHost(s.website)}
        </a>
      )}
    </div>
    <div className="svp-col">
      <span className="svp-rep">{s.contact || 'Sales team'}</span>
      {s.role && <span className="svp-sub">{s.role}</span>}
    </div>
    {/* Ternary → null (not `&&`): an absent value via `&&` yields '' which React
        can render as an empty text node, defeating the `.svp-col:empty` mobile
        collapse (silverPartners.scss). `null` renders nothing, so the column is
        reliably childless and the blank stacked row collapses on a phone. */}
    <div className="svp-col">
      {s.phone ? (
        <span className="svp-foot">
          <a className="svp-link mono" href={csTelHref(s.phone)} onClick={(e) => e.stopPropagation()}>
            {formatPhone(s.phone)}
          </a>
          <CsCopy text={formatPhone(s.phone)} />
        </span>
      ) : null}
    </div>
    <div className="svp-col">
      {s.email ? (
        <span className="svp-foot">
          <a className="svp-link mono" href={'mailto:' + s.email} onClick={(e) => e.stopPropagation()}>
            {s.email}
          </a>
          <CsCopy text={s.email} />
        </span>
      ) : null}
    </div>
  </div>
);

// An OPEN Silver slot — a simple "Advertise here" placeholder filling an unsold
// row so every subcategory shows a full U1–U5 directory. Mirrors the real chip's
// grid (refdes + open land pad in the id column) with a body spanning the rest;
// the whole row is a button routing to the Contact page.
const SvSlotEmpty = ({
  i,
  categoryName,
  onAdvertise,
}: {
  i: number;
  categoryName: string;
  onAdvertise: () => void;
}): ReactElement => {
  const where = categoryName || 'this subcategory';
  return (
    <div
      data-enter
      className="svp-chip svp-slot"
      role="button"
      tabIndex={0}
      onClick={onAdvertise}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onAdvertise();
        }
      }}
      aria-label={'Advertise in ' + where + ' — open Silver slot U' + (i + 1)}
    >
      <span className="svp-via" aria-hidden="true"></span>
      <div className="svp-idcol">
        <span className="svp-refdes">U{i + 1}</span>
        <span className="svp-pad svp-pad-open" aria-hidden="true">
          <i>+</i>
        </span>
      </div>
      <div className="svp-slot-body">
        <span className="svp-slot-text">
          <span className="svp-slot-title">Advertise here</span>
          <span className="svp-slot-sub">Feature your company in {where}</span>
        </span>
        <span className="svp-slot-cta" aria-hidden="true">
          Get listed{' →'}
        </span>
      </div>
    </div>
  );
};

export interface SilverPartnersProps {
  suppliers: PartnerSupplier[];
  categoryName: string;
}

export default function SilverPartners({
  suppliers,
  categoryName,
}: SilverPartnersProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [live, setLive] = useState<Set<number>>(() => new Set());
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    },
    [],
  );

  // Staggered entrance (visible-by-default; fill:none).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = requestAnimationFrame(() => {
      el.querySelectorAll('[data-enter]').forEach((node, i) => {
        (node as HTMLElement).animate(
          [
            { opacity: 0, transform: 'translateY(8px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          { duration: 420, delay: 60 + i * 70, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'none' },
        );
      });
    });
    return () => cancelAnimationFrame(r);
  }, []);

  const energize = (i: number) => {
    setLive((prev) => {
      const n = new Set(prev);
      n.add(i);
      return n;
    });
    const old = timers.current.get(i);
    if (old != null) clearTimeout(old);
    timers.current.set(
      i,
      setTimeout(() => {
        setLive((prev) => {
          const n = new Set(prev);
          n.delete(i);
          return n;
        });
        timers.current.delete(i);
      }, SVP_ENERGIZE_MS),
    );
  };

  const list = (suppliers || []).map(toChipData);
  const emptyCount = Math.max(0, SVP_SLOTS - list.length);
  // "Advertise here" placeholders route to the Contact page, prefilled with the
  // subcategory context (lands as a Message), mirroring the Platinum open-slot CTA.
  const advertise = () =>
    navigate('/contact', {
      state: {
        prefillMessage: `I'd like to advertise in the ${categoryName} Silver partner directory.`,
      },
    });
  return (
    <div
      className="csb svp"
      data-tier="silver"
      ref={ref}
      role="region"
      aria-label={categoryName ? 'Silver sponsors for ' + categoryName : 'Silver sponsors'}
    >
      {/* variant="static" — a still PCB background (no SMIL). `full`'s
          IntersectionObserver only pauses the 14 electron loops when the board is
          OFF-screen, but the user hovers this board while it's ON-screen, so the
          loops ran during interaction and starved the raster budget — the hover
          effect visibly trailed the cursor. `static` restores the "full is
          hero-only" invariant (CLAUDE.md) and frees the compositor for hover. */}
      <div className="csb-circuit" aria-hidden="true">
        <CircuitTraces variant="static" />
      </div>
      <span className="csb-rim" aria-hidden="true"></span>
      <span className="csb-fid tl" aria-hidden="true"></span>
      <span className="csb-fid tr" aria-hidden="true"></span>
      <span className="csb-fid bl" aria-hidden="true"></span>
      <span className="csb-fid br" aria-hidden="true"></span>
      <span className="csb-des">CS2 · SILVER-TIER</span>

      <div className="svp-rail">
        <div className="svp-scroll">
          <div className="svp-headrow" aria-hidden="true">
            <span className="svp-headcell"></span>
            <span className="svp-headcell">
              <span className="dot"></span>Company
            </span>
            <span className="svp-headcell">
              <span className="dot"></span>Sales Contact
            </span>
            <span className="svp-headcell">
              <span className="dot"></span>Phone
            </span>
            <span className="svp-headcell">
              <span className="dot"></span>Email
            </span>
          </div>
          <div className="svp-stack">
            <span className="svp-bus" aria-hidden="true"></span>
            {list.map((s, i) => (
              <SvChip key={s.name + i} s={s} i={i} live={live.has(i)} onEnergize={energize} />
            ))}
            {Array.from({ length: emptyCount }).map((_, k) => {
              const slot = list.length + k;
              return (
                <SvSlotEmpty
                  key={`slot${slot}`}
                  i={slot}
                  categoryName={categoryName}
                  onAdvertise={advertise}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
