// CategorySponsor.tsx — Category Sponsor banner ("Breakout Board", rev C).
//
// A dark ENIG solder-mask board (the Platinum tier) shown at the top of a
// category page and every subpage, with:
//   • a snapshot-only CircuitTraces PCB background (gold/brand-tinted),
//     rasterized onto the canvas tile field (hidden via .csbA .csb-circuit),
//   • a solid 4-dot TILE FIELD (canvas) where the hovered tile elevates in 3D,
//     a sparse subset "breathes", and a click flips the tiles over in a wave,
//   • four even divisions: COMPANY (logo + name) · CONTACT · PHONE · EMAIL,
//   • a CATEGORY SPONSOR badge straddling the top-center edge,
//   • click the company logo → tiles FLIP OVER in a ripple wave and the board
//     adopts the company's brand colors (click again to revert),
//   • Open-slot pitch mode: drag a company logo onto the empty banner (or click
//     the footprint) — colors are extracted from the image, the wave plays, and
//     the takeover persists for the browser session.
//
// Verbatim port of the design prototype's CategorySponsor.jsx. Effects engine +
// copy widget live in ./csFx. Styling is the GLOBAL ./categorySponsor.scss
// (hard-coded class strings + data-attr selectors the engine reads — no module
// hashing). The WAAPI entrance stays WAAPI (NOT Framer Motion).

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import CircuitTraces from '@public/components/widgets/CircuitTraces';
import type { PlatinumSponsor } from '@public/types/sponsor';
import { brandVars, CsCopy, csTelHref, extractBrandColors, mountTileField } from './csFx';
import type { TileField } from './csFx';
import './categorySponsor.scss';

interface BoardData {
  company: string;
  lettermark: string;
  division: string;
  logo: string | null;
  contact: string;
  role: string;
  phone: string;
  hours: string;
  email: string;
  designator?: string;
  brandPrimary?: string;
  brandSecondary?: string;
}

interface PitchState {
  logo: string;
  name: string;
  primary: string;
  secondary: string;
}

export interface CategorySponsorProps {
  sponsor: PlatinumSponsor | null;
  categoryName: string;
  slug: string;
  onNavigate?: (target: 'sponsor') => void;
}

/* Staggered entrance via the Web Animations API. Content is visible by default
   (fill:none + positive delays), so it can never be stranded invisible. */
function useCsEntrance(ref: React.RefObject<HTMLElement | null>, dep: unknown) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let r1 = 0,
      r2 = 0;
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        const ease = 'cubic-bezier(.2,.8,.3,1)';
        el.querySelectorAll('[data-enter]').forEach((node, i) => {
          (node as HTMLElement).animate(
            [
              { opacity: 0, transform: 'translateY(10px)' },
              { opacity: 1, transform: 'translateY(0)' },
            ],
            { duration: 460, delay: 50 + i * 80, easing: ease, fill: 'none' },
          );
        });
      });
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
    // Entrance re-runs whenever the identity `dep` flips (sponsor/pitch swap) —
    // verbatim with the prototype; the project lints boundaries only, not deps.
  }, [dep]);
}

/* Mount the canvas tile field and feed the cursor to it SYNCHRONOUSLY on every
   pointermove (no rAF hop — that was the "lag-behind"). The words layer is flat
   (no parallax tilt). */
function useCsBoardFx(
  boardRef: React.RefObject<HTMLElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
) {
  const apiRef = useRef<{ field: TileField | null } | null>(null);
  useEffect(() => {
    const board = boardRef.current,
      canvas = canvasRef.current;
    if (!board) return;

    // 1) Canvas tile field (the "alive" PCB base).
    const field = canvas ? mountTileField(canvas, board) : null;
    apiRef.current = { field };

    // 2) Feed the cursor to the field SYNCHRONOUSLY on every move (no rAF hop)
    //    so the dome tracks the pointer live, with no lag-behind.
    let rect: DOMRect | null = null;
    const onEnter = () => {
      rect = board.getBoundingClientRect();
    };
    const onMove = (e: PointerEvent) => {
      const r = rect || (rect = board.getBoundingClientRect());
      field && field.setCursor(e.clientX - r.left, e.clientY - r.top);
    };
    const onLeave = () => {
      field && field.clearCursor();
      rect = null;
    };
    const invalidate = () => {
      rect = null;
    };
    board.addEventListener('pointerenter', onEnter);
    board.addEventListener('pointermove', onMove);
    board.addEventListener('pointerleave', onLeave);
    window.addEventListener('scroll', invalidate, true);
    window.addEventListener('resize', invalidate);

    return () => {
      board.removeEventListener('pointerenter', onEnter);
      board.removeEventListener('pointermove', onMove);
      board.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('scroll', invalidate, true);
      window.removeEventListener('resize', invalidate);
      field && field.destroy();
      apiRef.current = null;
    };
    // Refs have stable identity — mount the field once / tear down on unmount,
    // matching the prototype's [] (listing the refs risks a re-mount that would
    // start a second canvas loop before the first is destroyed).
  }, []);
  return apiRef;
}

/* Energize: ripple a literal tile-flip wave from originEl across the canvas
   field, leaving the new color behind. The brand vars must already be set on
   the board (so the canvas reads the NEW color); we run the wave after the DOM
   reflects them. `commit` applies the React state change (brand/pitch). */
function runWave(
  boardRef: React.RefObject<HTMLElement | null>,
  apiRef: React.RefObject<{ field: TileField | null } | null>,
  originEl: HTMLElement | null,
  commit?: () => void,
) {
  if (commit) commit();
  const board = boardRef.current;
  const field = apiRef && apiRef.current && apiRef.current.field;
  if (!board || !field) return;
  // two rAFs so the new brand CSS vars are applied before the canvas samples them
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const b = board.getBoundingClientRect();
      let ox = b.width * 0.12,
        oy = b.height * 0.5;
      if (originEl) {
        const o = originEl.getBoundingClientRect();
        ox = o.left + o.width / 2 - b.left;
        oy = o.top + o.height / 2 - b.top;
      }
      field.wave(ox, oy);
    }),
  );
}

/* Un-tilted board frame: the snapshot-source PCB SVG, the canvas tile field,
   rim, drill holes, designator, and the (untriggered) energize light-sweep. */
const CsFrame = ({
  designator,
  canvasRef,
}: {
  designator: string;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}): ReactElement => (
  <>
    <div className="csb-circuit" aria-hidden="true">
      <CircuitTraces variant="static" />
    </div>
    <canvas className="csb-field" ref={canvasRef} aria-hidden="true"></canvas>
    <span className="csb-rim" aria-hidden="true"></span>
    <span className="csb-fid tl" aria-hidden="true"></span>
    <span className="csb-fid tr" aria-hidden="true"></span>
    <span className="csb-fid bl" aria-hidden="true"></span>
    <span className="csb-fid br" aria-hidden="true"></span>
    <span className="csb-des">{designator}</span>
    <span className="csb-pulse" aria-hidden="true"></span>
  </>
);

/* Top-center silkscreen badge — lives INSIDE the board. */
const CsBadge = ({ children }: { children: React.ReactNode }): ReactElement => (
  <div className="csb-badge" aria-hidden="true">
    <span className="dot"></span>
    <span className="csb-badge-txt">{children}</span>
  </div>
);

const csPrettyName = (filename: string): string =>
  (filename || 'Your Company')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Your Company';

/* Initials letter-mark from a company name (the design's `lettermark`, derived
   rather than stored). */
const csLettermark = (name: string): string =>
  (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '—';

// ─── Main component ──────────────────────────────────────────────────────
export default function CategorySponsor({
  sponsor,
  categoryName,
  slug,
  onNavigate,
}: CategorySponsorProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fx = useCsBoardFx(ref, canvasRef);

  const pitchKey = 'cs-pitch-' + (slug || categoryName || 'x');
  const [pitch, setPitch] = useState<PitchState | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(pitchKey) || 'null');
    } catch {
      return null;
    }
  });
  const [branded, setBranded] = useState<boolean>(
    () =>
      !!(
        !sponsor &&
        (() => {
          try {
            return JSON.parse(sessionStorage.getItem(pitchKey) || 'null');
          } catch {
            return null;
          }
        })()
      ),
  );
  const [dragging, setDragging] = useState(false);

  // Map the API sponsor (snake_case) → the board's field vocabulary so the rail
  // + brand logic stay verbatim with the prototype. Per the project null gotcha
  // (`?:` catches undefined but not null), coalesce with `?? null`/`|| ''`.
  const mapped: BoardData | null = sponsor
    ? {
        company: sponsor.supplier_name,
        lettermark: csLettermark(sponsor.supplier_name),
        division: 'Category Sponsor · ' + (categoryName || ''),
        logo: sponsor.image_url ?? sponsor.logo_url ?? null,
        contact: sponsor.contact_name || '',
        role: sponsor.contact_role || '',
        phone: sponsor.phone || '',
        hours: sponsor.coverage_hours || '',
        email: sponsor.email || '',
        designator: 'CS1 · CATEGORY-SPONSOR',
        // Brand takeover of a REAL sponsor uses the STORED hex (never pixel-
        // extracted from a remote logo — canvas taint). null → platinum default.
        brandPrimary: sponsor.brand_primary ?? undefined,
        brandSecondary: sponsor.brand_secondary ?? undefined,
      }
    : null;

  useCsEntrance(ref, (pitch && pitch.name) || (mapped && mapped.company) || 'empty');

  const brand = branded
    ? mapped
      ? { primary: mapped.brandPrimary || '#1d3a8f', secondary: mapped.brandSecondary || '#9bb8ff' }
      : pitch && { primary: pitch.primary, secondary: pitch.secondary }
    : null;
  const boardStyle = brand ? (brandVars(brand.primary, brand.secondary) as React.CSSProperties) : undefined;

  const toggleBrand = () => {
    const next = !branded;
    runWave(ref, fx, padRef.current, () => setBranded(next));
  };

  // ── Pitch mode (open slot): drop a logo → extract colors → take over ──
  const adoptLogoFile = (file: File | null | undefined) => {
    if (!file || !/^image\//.test(file.type)) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const { primary, secondary } = extractBrandColors(img);
        const next: PitchState = {
          logo: reader.result as string,
          name: csPrettyName(file.name),
          primary,
          secondary,
        };
        try {
          sessionStorage.setItem(pitchKey, JSON.stringify(next));
        } catch {
          /* storage unavailable */
        }
        runWave(ref, fx, padRef.current, () => {
          setPitch(next);
          setBranded(true);
        });
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };
  const clearPitch = (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      sessionStorage.removeItem(pitchKey);
    } catch {
      /* storage unavailable */
    }
    runWave(ref, fx, padRef.current, () => {
      setPitch(null);
      setBranded(false);
    });
  };
  const dropProps = sponsor
    ? {}
    : {
        onDragOver: (e: React.DragEvent) => {
          e.preventDefault();
          setDragging(true);
        },
        onDragLeave: () => setDragging(false),
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          setDragging(false);
          adoptLogoFile(e.dataTransfer.files && e.dataTransfer.files[0]);
        },
      };

  // The four-division rail (shared by sponsor + pitch states).
  const renderRail = (s: BoardData, isPitch: boolean): ReactElement => (
    <div className="csbA-rail">
      <div className="csbA-field csbA-idcell" data-enter>
        <span className="csbA-plabel">
          <span className="dot"></span>Company<span className="csbA-pinno">P1</span>
        </span>
        <div className="csbA-idtop">
          <button
            type="button"
            className="csbA-pad"
            ref={padRef}
            onClick={isPitch ? undefined : toggleBrand}
            title={isPitch ? undefined : branded ? 'Restore board colors' : 'Energize with ' + s.company + ' colors'}
            aria-label={branded ? 'Restore board colors' : 'Adopt ' + s.company + ' brand colors'}
          >
            <span className="csbA-ring" aria-hidden="true"></span>
            {s.logo ? (
              <img className="csbA-logoimg" src={s.logo} alt={s.company + ' logo'} />
            ) : (
              <span className="csbA-mark">{s.lettermark}</span>
            )}
          </button>
          <span className="csbA-co">
            <span className="csbA-coname">{s.company}</span>
          </span>
        </div>
      </div>
      <div className="csbA-field" data-enter>
        <span className="csbA-plabel">
          <span className="dot"></span>Contact<span className="csbA-pinno">P2</span>
        </span>
        <span className="csbA-val">{s.contact}</span>
        <span className="csbA-sub">{s.role}</span>
      </div>
      <div className="csbA-field" data-enter>
        <span className="csbA-plabel">
          <span className="dot"></span>Phone<span className="csbA-pinno">P3</span>
        </span>
        <span className="csbA-val mono">
          <a href={csTelHref(s.phone)}>{s.phone}</a>
        </span>
        <span className="csbA-fieldfoot">
          <span className="csbA-sub">{s.hours}</span>
          <CsCopy text={s.phone} />
        </span>
      </div>
      <div className="csbA-field" data-enter>
        <span className="csbA-plabel">
          <span className="dot"></span>Email<span className="csbA-pinno">P4</span>
        </span>
        <span className="csbA-val mono">
          <a href={'mailto:' + s.email}>{s.email}</a>
        </span>
        <span className="csbA-fieldfoot">
          <span className="csbA-sub">Direct line</span>
          <CsCopy text={s.email} />
        </span>
      </div>
    </div>
  );

  // ── Open slot, with a session pitch saved → render the takeover ──
  if (!sponsor && pitch) {
    const ps: BoardData = {
      company: pitch.name,
      lettermark: csLettermark(pitch.name),
      division: 'Future Category Sponsor · ' + (categoryName || ''),
      logo: pitch.logo,
      contact: 'Your sales rep',
      role: 'Name & title here',
      phone: '1-800-555-0199',
      hours: 'Your coverage hours',
      email: 'sales@' + pitch.name.toLowerCase().replace(/[^a-z0-9]+/g, '') + '.com',
    };
    return (
      <div className="cs-band">
        <div className="csb-pos">
          <div
            className="csb csbA"
            data-tier="featured"
            data-pitch="true"
            ref={ref}
            style={boardStyle}
            {...dropProps}
          >
            <CsFrame designator={'CS1 · PITCH-PREVIEW'} canvasRef={canvasRef} />
            <div className="csb-surface">
              <CsBadge>Category Sponsor</CsBadge>
              {renderRail(ps, true)}
            </div>
            <button
              type="button"
              className="csb-pitch-reset"
              onClick={clearPitch}
              title="Remove logo & reset"
            >
              ✕ reset
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Open slot — invitation + logo drop target ──
  if (!sponsor) {
    return (
      <div className="cs-band">
        <div className="csb-pos">
          <div
            className="csb csbA csbA-empty"
            data-tier="gold"
            data-drag={dragging ? 'true' : 'false'}
            ref={ref}
            {...dropProps}
          >
            <CsFrame designator="CS1 · OPEN SLOT" canvasRef={canvasRef} />
            <div className="csb-surface">
              <CsBadge>Open Placement</CsBadge>
              <div className="csbA-id">
                <span className="csbA-plabel">
                  <span className="dot"></span>Sponsor This Category
                </span>
                <div className="csbA-idtop">
                  <button
                    type="button"
                    className="csbA-footprint"
                    ref={padRef}
                    onClick={() => fileRef.current && fileRef.current.click()}
                    title="Drop a company logo here"
                    aria-label="Upload a company logo to preview sponsorship"
                  >
                    <span></span>
                    <span></span>
                    <span></span>
                    <span></span>
                    <i>+</i>
                  </button>
                  <span className="csbA-co">
                    <span className="csbA-coname">Open placement</span>
                    <span className="csbA-cotag">{categoryName}</span>
                  </span>
                </div>
              </div>
              <div className="csbA-rail csbA-rail-empty">
                <div className="csbA-emptymsg" data-enter>
                  <h4>Reach buyers browsing {categoryName}.</h4>
                  <p>
                    Feature your company at the top of this category with your logo, a sales rep, and a
                    direct line. Drag a logo onto the board to preview the takeover.
                  </p>
                </div>
                <div className="csbA-emptycta" data-enter>
                  <button
                    type="button"
                    className="csbA-cta"
                    onClick={() => onNavigate && onNavigate('sponsor')}
                  >
                    Become a sponsor →
                  </button>
                </div>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                adoptLogoFile(e.target.files && e.target.files[0]);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  // ── Sponsored ──
  const tier = (sponsor.tier || 'featured').toLowerCase();
  return (
    <div className="cs-band">
      <div className="csb-pos">
        <div
          className="csb csbA"
          data-tier={tier}
          data-branded={branded ? 'true' : 'false'}
          ref={ref}
          style={boardStyle}
        >
          <CsFrame designator={mapped!.designator || 'CS1 · CATEGORY-SPONSOR'} canvasRef={canvasRef} />
          <div className="csb-surface">
            <CsBadge>Category Sponsor</CsBadge>
            {renderRail(mapped!, false)}
          </div>
        </div>
      </div>
    </div>
  );
}
