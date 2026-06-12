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
import type { ReactElement } from 'react';
import CircuitTraces from '@public/components/widgets/CircuitTraces';
import type { PartnerSupplier } from '@public/types/sponsor';
import { prependScheme } from '@shared/utils/url';
import { CsCopy, csTelHref } from './csFx';
import './categorySponsor.scss';
import './silverPartners.scss';

const SVP_ENERGIZE_MS = 1500;

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
    // RFC-3986-aware: the stored website may be a bare host (digikey.com) OR
    // already-schemed (https://digikey.com); prependScheme normalizes both to a
    // single valid scheme. Empty → '' so the `s.website &&` link guard still
    // hides an absent website (prependScheme('') === '').
    website: s.website ? prependScheme(s.website) : '',
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
          rel="noopener noreferrer"
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
    <div className="svp-col">
      {s.phone && (
        <span className="svp-foot">
          <a className="svp-link mono" href={csTelHref(s.phone)} onClick={(e) => e.stopPropagation()}>
            {s.phone}
          </a>
          <CsCopy text={s.phone} />
        </span>
      )}
    </div>
    <div className="svp-col">
      {s.email && (
        <span className="svp-foot">
          <a className="svp-link mono" href={'mailto:' + s.email} onClick={(e) => e.stopPropagation()}>
            {s.email}
          </a>
          <CsCopy text={s.email} />
        </span>
      )}
    </div>
  </div>
);

export interface SilverPartnersProps {
  suppliers: PartnerSupplier[];
  categoryName: string;
}

export default function SilverPartners({
  suppliers,
  categoryName,
}: SilverPartnersProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
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
  return (
    <div
      className="csb svp"
      data-tier="silver"
      ref={ref}
      role="region"
      aria-label={categoryName ? 'Silver sponsors for ' + categoryName : 'Silver sponsors'}
    >
      {/* variant="static" — the hero-only `full` instance lives in BackdropLayer;
          shipping the 14 SMIL electron loops + 6s draw here would double cost on a
          non-hero route (CLAUDE.md Tier-3 #6 perf invariant). static keeps the
          visible gold-trace lattice (opacity .5 per the CSS). */}
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
          </div>
        </div>
      </div>
    </div>
  );
}
