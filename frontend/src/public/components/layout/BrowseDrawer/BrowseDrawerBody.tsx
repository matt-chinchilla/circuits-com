import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@public/services/api";
import type { Category } from "@public/types/category";
import type { Supplier } from "@public/types/supplier";
import type { PublicManufacturers } from "@public/types/search";
import { categoryPath } from "@shared/utils/categoryPath";
import { lettermark } from "@shared/utils/lettermark";
import { safeImageUrl } from "@shared/utils/url";
import Icon from "@shared/components/Icon";
import { catalogPartsRollup, partsPillLabel } from "./drawerCounts";
import styles from "./BrowseDrawer.module.scss";

// The public suppliers listing gains a server-normalized `tier` with the
// search-v2 backend (spec §1.4a). Optional here so the drawer renders
// (badge-less) against a server that predates the field; fold into
// @public/types/supplier once the backend lands and delete this alias.

type Pane = "cats" | "mfrs" | "dists";

const EM_DASH = "—";

// Session caches as memoized promises: dedupes in-flight fetches, caches
// success for the session, and RESETS on failure so a pane's retry button
// re-fires just that source.
function once<T>(fetcher: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    if (!promise) {
      promise = fetcher().catch((err: unknown) => {
        promise = null;
        throw err;
      });
    }
    return promise;
  };
}

const fetchCats = once<Category[]>(() => api.getCategories());
const fetchMfrs = once<PublicManufacturers>(() => api.getManufacturers(60));
const fetchSups = once<Supplier[]>(() => api.getSuppliers());

// Rail — the pinned five (spec §4): two pane-less links (/search, /bom)
// between three pane switchers, then the Site group mirroring the navbar.
const SITE_LINKS: { to: string; label: string; icon: string }[] = [
  { to: "/", label: "Home", icon: "house" },
  { to: "/about", label: "About", icon: "info" },
  { to: "/join", label: "Join", icon: "handshake" },
  { to: "/contact", label: "Contact", icon: "envelope-simple" },
  { to: "/admin/login", label: "Login", icon: "sign-in" },
];

function RetryRow({ onRetry }: { onRetry: () => void }) {
  return (
    <button type="button" className={styles.retry} onClick={onRetry}>
      Couldn&apos;t load &mdash; retry
    </button>
  );
}

// Kit swatches were mock brand colors; production shows the supplier's real
// logo when it passes safeImageUrl, falling back to a lettermark pad
// (the SbLogo onError pattern).
function DistSwatch({ name, logo }: { name: string; logo: string | null }) {
  const [broken, setBroken] = useState(false);
  if (!logo || broken) {
    return (
      <span className={styles.sw} aria-hidden="true">
        {lettermark(name)}
      </span>
    );
  }
  return (
    <span className={styles.sw} aria-hidden="true">
      <img src={logo} alt="" onError={() => setBroken(true)} />
    </span>
  );
}

interface BrowseDrawerBodyProps {
  open: boolean;
  onClose: () => void;
}

export default function BrowseDrawerBody({ open, onClose }: BrowseDrawerBodyProps) {
  const navigate = useNavigate();
  const closeRef = useRef<HTMLButtonElement>(null);

  const [pane, setPane] = useState<Pane>("cats");
  const [cats, setCats] = useState<Category[] | null>(null);
  const [mfrs, setMfrs] = useState<PublicManufacturers | null>(null);
  const [sups, setSups] = useState<Supplier[] | null>(null);
  const [catsErr, setCatsErr] = useState(false);
  const [mfrsErr, setMfrsErr] = useState(false);
  const [supsErr, setSupsErr] = useState(false);

  // Unmount guard only — a close mid-flight should still fill the session
  // cache, so fetches are never cancelled on close.
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );

  const loadCats = useCallback(() => {
    setCatsErr(false);
    fetchCats().then(
      (d) => {
        if (aliveRef.current) setCats(d);
      },
      () => {
        if (aliveRef.current) setCatsErr(true);
      },
    );
  }, []);

  const loadMfrs = useCallback(() => {
    setMfrsErr(false);
    fetchMfrs().then(
      (d) => {
        if (aliveRef.current) setMfrs(d);
      },
      () => {
        if (aliveRef.current) setMfrsErr(true);
      },
    );
  }, []);

  const loadSups = useCallback(() => {
    setSupsErr(false);
    fetchSups().then(
      (d) => {
        if (aliveRef.current) setSups(d);
      },
      () => {
        if (aliveRef.current) setSupsErr(true);
      },
    );
  }, []);

  // Every open: pane resets to the category grid.
  useEffect(() => {
    if (open) setPane("cats");
  }, [open]);

  // Every open: all three sources fetch eagerly in parallel (not per-pane) so
  // the rail pills are truthful at open. Cached calls resolve instantly.
  useEffect(() => {
    if (!open) return;
    loadCats();
    loadMfrs();
    loadSups();
  }, [open, loadCats, loadMfrs, loadSups]);

  // Initial focus lands on the collapse X (dialog pattern; the shell's trap
  // keeps Tab inside, Navbar returns focus to the burger on close).
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  const rollup = cats ? catalogPartsRollup(cats) : null;
  const partsPill = rollup != null ? partsPillLabel(rollup) : EM_DASH;
  const catsPill = cats ? String(cats.length) : EM_DASH;
  const mfrsPill = mfrs ? mfrs.total.toLocaleString("en-US") : EM_DASH;
  const supsPill = sups ? String(sups.length) : EM_DASH;

  const switcherClass = (k: Pane) =>
    pane === k ? `${styles.item} ${styles.itemActive}` : styles.item;

  return (
    <>
      <button
        type="button"
        ref={closeRef}
        className={styles.close}
        onClick={onClose}
        aria-label="Collapse browse menu"
      >
        <span />
        <span />
        <span />
      </button>

      <div className={styles.rail}>
        <div className={styles.railTop}>
          <div className={styles.head}>Browse</div>
          <button
            type="button"
            className={switcherClass("cats")}
            onClick={() => setPane("cats")}
            aria-current={pane === "cats" ? "true" : undefined}
            aria-label={cats ? `All Categories (${cats.length})` : "All Categories"}
          >
            <Icon name="squares-four" className={styles.itemIcon} />
            All Categories
            <span className={styles.meta} aria-hidden="true">
              {catsPill}
            </span>
          </button>
          <button
            type="button"
            className={styles.item}
            onClick={() => go("/search")}
            aria-label={rollup != null ? `Parts (${partsPill})` : "Parts"}
          >
            <Icon name="circuitry" className={styles.itemIcon} />
            Parts
            <span className={styles.meta} aria-hidden="true">
              {partsPill}
            </span>
          </button>
          <button type="button" className={styles.item} onClick={() => go("/bom")}>
            <Icon name="list-checks" className={styles.itemIcon} />
            BOM Tool
            <span className={styles.meta} aria-hidden="true">
              CSV&middot;XLSX
            </span>
          </button>
          <button
            type="button"
            className={switcherClass("mfrs")}
            onClick={() => setPane("mfrs")}
            aria-current={pane === "mfrs" ? "true" : undefined}
            aria-label={mfrs ? `Manufacturers (${mfrs.total})` : "Manufacturers"}
          >
            <Icon name="factory" className={styles.itemIcon} />
            Manufacturers
            <span className={styles.meta} aria-hidden="true">
              {mfrsPill}
            </span>
          </button>
          <button
            type="button"
            className={switcherClass("dists")}
            onClick={() => setPane("dists")}
            aria-current={pane === "dists" ? "true" : undefined}
            aria-label={sups ? `Distributors (${sups.length})` : "Distributors"}
          >
            <Icon name="truck" className={styles.itemIcon} />
            Distributors
            <span className={styles.meta} aria-hidden="true">
              {supsPill}
            </span>
          </button>
        </div>

        <div className={styles.sep} />

        <div className={styles.railBottom}>
          <div className={styles.head}>Site</div>
          {SITE_LINKS.map(({ to, label, icon }) => (
            <button
              key={to}
              type="button"
              className={`${styles.item} ${styles.itemLite}`}
              onClick={() => go(to)}
            >
              <Icon name={icon} className={`${styles.itemIcon} ${styles.itemIconLite}`} />
              {label}
            </button>
          ))}
          <div className={styles.foot} aria-hidden="true">
            <span>
              {catsPill} CATEGORIES &middot; {partsPill} PARTS
            </span>
            <span>
              CIRCUITCENTER.AI &middot; <kbd className={styles.kbd}>ESC</kbd> CLOSES
            </span>
          </div>
        </div>
      </div>

      <div className={styles.pane}>
        {pane === "cats" && (
          <>
            <div className={styles.paneHead}>
              All Categories
              {cats ? <span className={styles.paneSub}>{cats.length}</span> : null}
            </div>
            {catsErr && <RetryRow onRetry={loadCats} />}
            <div className={styles.grid}>
              {(cats ?? []).map((c) => (
                <button
                  key={c.slug}
                  type="button"
                  className={styles.tile}
                  onClick={() => go(categoryPath(c.slug))}
                  aria-label={`${c.name} (${c.children.length} subcategories)`}
                >
                  <Icon name={c.icon} className={styles.tileIcon} />
                  <span className={styles.tileName}>{c.name}</span>
                  <span className={styles.tileCount} aria-hidden="true">
                    {c.children.length}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {pane === "mfrs" && (
          <>
            <div className={styles.paneHead}>
              Manufacturers
              {mfrs ? (
                <span className={styles.paneSub}>{mfrs.total.toLocaleString("en-US")}</span>
              ) : null}
            </div>
            {mfrsErr && <RetryRow onRetry={loadMfrs} />}
            <div className={styles.grid}>
              {(mfrs?.manufacturers ?? []).map((m) => (
                <button
                  key={m.name}
                  type="button"
                  className={styles.tile}
                  onClick={() => go(`/search?q=${encodeURIComponent(m.name)}`)}
                  aria-label={`${m.name} (${m.parts_count} parts)`}
                >
                  <span className={styles.tileLogo} aria-hidden="true">
                    {lettermark(m.name)}
                  </span>
                  <span className={styles.tileName}>{m.name}</span>
                  <span className={styles.tileCount} aria-hidden="true">
                    {m.parts_count.toLocaleString("en-US")}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {pane === "dists" && (
          <>
            <div className={styles.paneHead}>
              Distributors
              {sups ? <span className={styles.paneSub}>{sups.length}</span> : null}
            </div>
            {supsErr && <RetryRow onRetry={loadSups} />}
            {(sups ?? []).map((s) => {
              const tier = s.tier?.toLowerCase();
              return (
                <button
                  key={s.id}
                  type="button"
                  className={styles.row}
                  onClick={() => go("/join")}
                >
                  <DistSwatch name={s.name} logo={safeImageUrl(s.logo_url)} />
                  <span className={styles.rowName}>{s.name}</span>
                  {(tier === "gold" || tier === "platinum") && (
                    <span className={styles.star}>FEATURED</span>
                  )}
                </button>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}
