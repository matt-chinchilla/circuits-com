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
import { BrandColorPicker } from '@shared/components/BrandColorPicker';
import { BrandColorSelectModal } from '@shared/components/BrandColorSelectModal';
import { LogoCropperModal } from '@shared/components/LogoCropperModal';
import { DEFAULT_PALETTE, extractBrandPalette } from '@shared/utils/brandPalette';
import { safeHexColor } from '@shared/utils/color';
import { canvasToDataUrl } from '@shared/utils/image';
import { formatPhone } from '@shared/utils/phone';
import { isDataImage, safeHttpUrl, safeImageUrl } from '@shared/utils/url';
import { brandVars, CsCopy, csTelHref, mountTileField } from './csFx';
import type { TileField } from './csFx';
import uploadIcon from './upload-icon.png';
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
  websiteHref?: string | null;
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
// Sponsor identities whose entrance has already played this session. The banner
// remounts on every subcategory nav (CategoryPage is pathname-keyed), so without
// this the fade+slide re-runs each time and reads as the board "re-loading".
const csEntranceSeen = new Set<string>();

// Platinum value props shown on the UNSOLD (open-placement) banner so a prospect
// sees the same pitch the /join pricing page makes. Mirrors JOIN_TIERS →
// platinum.perks in join/index.tsx (the canonical wording), trimmed to fit the
// banner's width — keep the two in loose sync.
const PLATINUM_BENEFITS = [
  'Top-of-page sponsor block in your brand colors',
  'Placement across every subcategory',
  'Unlimited report generation',
  'Live stock + price API sync',
] as const;

function useCsEntrance(ref: React.RefObject<HTMLElement | null>, dep: unknown) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Play the entrance ONCE per sponsor identity per session. Resting state is
    // visible (the animation is fill:none), so a skipped warm nav just shows the
    // board instantly instead of re-animating it.
    const key = String(dep);
    if (csEntranceSeen.has(key)) return;
    csEntranceSeen.add(key);
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
    // Touch/pen: capture the pointer on down so a finger dragging the "ball" keeps
    // driving the dome even past the board edge, and (with touch-action:none on the
    // board) the page doesn't scroll under the drag. Skip capture on interactive
    // descendants so taps on the logo/links/copy buttons still fire.
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      const t = e.target as Element | null;
      if (t?.closest('a, button, [role="button"], input, textarea, select, label')) return;
      try {
        board.setPointerCapture(e.pointerId);
      } catch {
        /* unsupported */
      }
      const r = rect || (rect = board.getBoundingClientRect());
      field && field.setCursor(e.clientX - r.left, e.clientY - r.top);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      try {
        board.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      field && field.clearCursor();
    };
    const invalidate = () => {
      rect = null;
    };
    board.addEventListener('pointerenter', onEnter);
    board.addEventListener('pointermove', onMove);
    board.addEventListener('pointerleave', onLeave);
    board.addEventListener('pointerdown', onDown);
    board.addEventListener('pointerup', onUp);
    board.addEventListener('pointercancel', onUp);
    window.addEventListener('scroll', invalidate, true);
    window.addEventListener('resize', invalidate);

    return () => {
      board.removeEventListener('pointerenter', onEnter);
      board.removeEventListener('pointermove', onMove);
      board.removeEventListener('pointerleave', onLeave);
      board.removeEventListener('pointerdown', onDown);
      board.removeEventListener('pointerup', onUp);
      board.removeEventListener('pointercancel', onUp);
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

/* Sponsor logo with graceful fallback: a broken/missing image URL falls back to
   the company lettermark (e.g. "KE") instead of the browser's broken-image
   glyph. Keyed by `src` at the call site so the broken state resets when the
   logo changes (sponsor swap / brand takeover). A null/falsy `src` initialises
   `broken=true` so the lettermark renders immediately (mirrors SbLogo). */
const CsLogo = ({ src, alt, mark }: { src: string | null; alt: string; mark: string }): ReactElement => {
  const [broken, setBroken] = useState(!src);
  // Square crop-pipeline data-URLs fill the pad flush; legacy/letterboxed logos
  // keep the contained `.csbA-logoimg` fit. Keyed by src at the call site, so
  // this resets on sponsor swap / brand takeover.
  const [cropped, setCropped] = useState(false);
  if (broken || !src) return <span className="csbA-mark">{mark}</span>;
  return (
    <img
      className={cropped ? 'csbA-logoimg csbA-logoimg-flush' : 'csbA-logoimg'}
      src={src}
      alt={alt}
      onLoad={(e) =>
        setCropped(isDataImage(src) && e.currentTarget.naturalWidth === e.currentTarget.naturalHeight)
      }
      onError={() => setBroken(true)}
    />
  );
};

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
  // A SOLD board with sponsorship-level colors set (brand_takeover) renders
  // branded from FIRST PAINT (no wave on load — boardStyle applies statically,
  // exactly like today's post-click state). The !sponsor branch keeps the
  // pitch-restore behavior verbatim (a saved session pitch → branded).
  const [branded, setBranded] = useState<boolean>(() => {
    if (sponsor) return Boolean(sponsor.brand_takeover);
    try {
      return !!JSON.parse(sessionStorage.getItem(pitchKey) || 'null');
    } catch {
      return false;
    }
  });
  const [dragging, setDragging] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  // Two-step upload: after a crop, hold the canvas + a PROVISIONAL (auto-color)
  // pitch so the color screen can open BEFORE the wave. Non-null = color screen
  // is up; the provisional is already persisted so a mid-screen nav survives.
  const [colorStage, setColorStage] = useState<{
    canvas: HTMLCanvasElement;
    provisional: PitchState;
  } | null>(null);
  // Demo-host encode failure (e.g. Safari: a photographic crop exceeding the
  // 64,000-char cap) — surfaced instead of silently doing nothing on Apply.
  const [cropError, setCropError] = useState<string | null>(null);

  // Sync `branded` to the sponsor's takeover flag on identity/flag change ONLY
  // (primitive deps) — a same-values refetch never stomps a visitor's manual
  // toggle. The react-hooks plugin isn't installed here, so no disable comment.
  useEffect(() => {
    if (sponsor) setBranded(Boolean(sponsor.brand_takeover));
  }, [sponsor?.id, sponsor?.brand_takeover]);

  // Map the API sponsor (snake_case) → the board's field vocabulary so the rail
  // + brand logic stay verbatim with the prototype. Per the project null gotcha
  // (`?:` catches undefined but not null), coalesce with `?? null`/`|| ''`.
  const mapped: BoardData | null = sponsor
    ? {
        company: sponsor.supplier_name,
        lettermark: csLettermark(sponsor.supplier_name),
        division: 'Category Sponsor · ' + (categoryName || ''),
        logo: safeImageUrl(sponsor.image_url ?? sponsor.logo_url),
        contact: sponsor.contact_name || '',
        role: sponsor.contact_role || '',
        phone: sponsor.phone || '',
        hours: sponsor.coverage_hours || '',
        email: sponsor.email || '',
        websiteHref: safeHttpUrl(sponsor.website),
        designator: 'CS1 · CATEGORY-SPONSOR',
        // Brand takeover of a REAL sponsor uses the STORED hex (never pixel-
        // extracted from a remote logo — canvas taint). safeHexColor gates the
        // #RRGGBB shape; a null/invalid value → undefined → platinum default.
        brandPrimary: safeHexColor(sponsor.brand_primary) ?? undefined,
        brandSecondary: safeHexColor(sponsor.brand_secondary) ?? undefined,
      }
    : null;

  useCsEntrance(ref, (pitch && pitch.name) || (mapped && mapped.company) || 'empty');

  // v12: composite the upload icon INTO the canvas board surface (open slot
  // ONLY) so it fragments into the rising tiles exactly like the PCB — instead
  // of sitting on top as one whole DOM element. The DOM <i> is hidden; this is
  // the visible "drop here" emblem.
  useEffect(() => {
    if (sponsor || pitch) return; // only the empty/open-slot state
    const board = ref.current;
    const pad = padRef.current;
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    const img = new Image();
    const apply = () => {
      const field = fx.current?.field;
      if (!field || !board || !pad || !img.complete || !img.naturalWidth) return;
      const br = board.getBoundingClientRect();
      const pr = pad.getBoundingClientRect();
      field.setEmblem(img, pr.left + pr.width / 2 - br.left, pr.top + pr.height / 2 - br.top, 30);
    };
    img.onload = () => {
      if (!cancelled) apply();
    };
    img.src = uploadIcon;
    // Re-position the emblem when the board's own layout reflows. The field's
    // internal ResizeObserver already redraws on resize but reuses the last
    // coords — this RO recomputes the pad center. (No window-resize listener: a
    // window resize only moves the pad if the board itself resizes, which this
    // board-scoped RO already catches.)
    if (board) {
      ro = new ResizeObserver(() => apply());
      ro.observe(board);
    }
    const t = window.setTimeout(apply, 360); // after layout settles
    return () => {
      cancelled = true;
      clearTimeout(t);
      ro?.disconnect();
      fx.current?.field?.clearEmblem();
    };
  }, [sponsor, pitch]);

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

  // ── Pitch mode (open slot): drop a logo → crop dialog → extract colors →
  //    take over. A dropped/picked file opens the cropper; Apply hands back a
  //    256×256 white-underfilled canvas we colour-sample + store (the bounded
  //    data-URL, not the raw file — no sessionStorage quota risk).
  const adoptLogoFile = (file: File | null | undefined) => {
    setCropError(null);
    if (!file || !/^image\//.test(file.type)) return;
    setCropFile(file);
  };

  const applyCroppedLogo = (canvas: HTMLCanvasElement) => {
    const file = cropFile;
    setCropFile(null);
    if (!file) return;
    const encoded = canvasToDataUrl(canvas);
    if (!encoded.ok) {
      setCropError(encoded.error);
      return;
    }
    const palette = extractBrandPalette(canvas) ?? DEFAULT_PALETTE;
    // Provisional takeover: the auto-extracted palette. Persisted immediately so
    // navigating away while the color screen is open keeps today's crop-durability
    // (the board restores branded with the auto colors). The wave waits for the
    // color screen to commit — no immediate takeover here.
    const provisional: PitchState = {
      logo: encoded.dataUrl,
      name: csPrettyName(file.name),
      primary: palette.primary,
      secondary: palette.secondary,
    };
    try {
      sessionStorage.setItem(pitchKey, JSON.stringify(provisional));
    } catch {
      /* storage unavailable */
    }
    setColorStage({ canvas, provisional });
  };

  // Commit the color screen's choice (or the provisional auto-colors on Skip):
  // persist, then play the tile-flip wave into the branded takeover — exactly
  // the old applyCroppedLogo tail.
  const commitPitch = (
    stage: { canvas: HTMLCanvasElement; provisional: PitchState },
    primary: string,
    secondary: string,
  ) => {
    const next: PitchState = { ...stage.provisional, primary, secondary };
    try {
      sessionStorage.setItem(pitchKey, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
    runWave(ref, fx, padRef.current, () => {
      setPitch(next);
      setBranded(true);
    });
    setColorStage(null);
  };
  const clearPitch = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCropError(null);
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
              <CsLogo key={s.logo ?? s.company} src={s.logo} alt={s.company + ' logo'} mark={s.lettermark} />
            ) : (
              <span className="csbA-mark">{s.lettermark}</span>
            )}
          </button>
          <span className="csbA-co">
            {s.websiteHref ? (
              <a
                className="csbA-coname"
                href={s.websiteHref}
                target="_blank"
                rel="sponsored noopener noreferrer"
                title={'Visit ' + s.company}
              >
                {s.company}
              </a>
            ) : (
              <span className="csbA-coname">{s.company}</span>
            )}
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
          <a href={csTelHref(s.phone)}>{formatPhone(s.phone)}</a>
        </span>
        <span className="csbA-fieldfoot">
          <CsCopy text={formatPhone(s.phone)} />
          <span className="csbA-sub">{s.hours}</span>
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
              <CsBadge>Exclusive Partner</CsBadge>
              {renderRail(ps, true)}
              <div className="csb-swatches" data-enter>
                <BrandColorPicker
                  compact
                  logoSrc={pitch.logo}
                  primary={pitch.primary}
                  secondary={pitch.secondary}
                  onChange={(role, hex) => {
                    const next = { ...pitch, [role]: hex } as PitchState;
                    try {
                      sessionStorage.setItem(pitchKey, JSON.stringify(next));
                    } catch {
                      /* storage unavailable */
                    }
                    runWave(ref, fx, padRef.current, () => setPitch(next));
                  }}
                />
              </div>
            </div>
            <button
              type="button"
              className="csb-pitch-reset"
              onClick={clearPitch}
              title="Remove logo & reset"
            >
              ✕ reset
            </button>
            {cropError && (
              <p className="csb-croperr" aria-live="polite">
                {cropError}
              </p>
            )}
          </div>
        </div>
        {cropFile && (
          <LogoCropperModal
            file={cropFile}
            onApply={applyCroppedLogo}
            onCancel={() => setCropFile(null)}
            title="Position your logo"
          />
        )}
        {colorStage && (
          <BrandColorSelectModal
            source={colorStage.canvas}
            initialPrimary={colorStage.provisional.primary}
            initialSecondary={colorStage.provisional.secondary}
            onApply={(p, s) => commitPitch(colorStage, p, s)}
            onSkip={() => commitPitch(colorStage, colorStage.provisional.primary, colorStage.provisional.secondary)}
          />
        )}
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
                    <i aria-hidden="true"></i>
                  </button>
                  <span className="csbA-co">
                    <span className="csbA-coname">Open placement</span>
                    <span className="csbA-cotag">{categoryName}</span>
                  </span>
                </div>
                <span className="csbA-drophint">Drag a logo here to preview the takeover.</span>
                {cropError && (
                  <p className="csb-croperr" aria-live="polite">
                    {cropError}
                  </p>
                )}
              </div>
              <div className="csbA-rail csbA-rail-empty">
                <div className="csbA-emptymsg" data-enter>
                  <h4>Reach buyers browsing {categoryName}.</h4>
                  <p>The flagship tier — one Platinum sponsor per category.</p>
                </div>
                <ul className="csbA-benefits" data-enter>
                  {PLATINUM_BENEFITS.map((b) => (
                    <li key={b}>
                      <span className="csbA-benefit-tick" aria-hidden="true">
                        &#10003;
                      </span>
                      {b}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="csbA-cta"
                  data-enter
                  onClick={() => onNavigate && onNavigate('sponsor')}
                >
                  Become An Exclusive Partner &rarr;
                </button>
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
        {cropFile && (
          <LogoCropperModal
            file={cropFile}
            onApply={applyCroppedLogo}
            onCancel={() => setCropFile(null)}
            title="Position your logo"
          />
        )}
        {colorStage && (
          <BrandColorSelectModal
            source={colorStage.canvas}
            initialPrimary={colorStage.provisional.primary}
            initialSecondary={colorStage.provisional.secondary}
            onApply={(p, s) => commitPitch(colorStage, p, s)}
            onSkip={() => commitPitch(colorStage, colorStage.provisional.primary, colorStage.provisional.secondary)}
          />
        )}
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
            <CsBadge>Exclusive Partner</CsBadge>
            {renderRail(mapped!, false)}
          </div>
        </div>
      </div>
    </div>
  );
}
