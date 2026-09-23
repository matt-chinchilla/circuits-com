import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { motion } from "framer-motion";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import PageHead from "@public/components/PageHead";
import { STATIC_PAGE_SEO } from "@public/services/seoRoutes";
import PageHeaderBand from "@public/components/layout/PageHeaderBand";
import GlowButton from "@public/components/widgets/GlowButton";
import Icon from "@shared/components/Icon";
import { formatPhone } from "@shared/utils/phone";
import { useCategories } from "@public/hooks/useCategories";
import { api } from "@public/services/api";
import { chargedMonthly } from "@public/services/checkoutPrice";
import TierBannerRibbon, { type SponsorTierId } from "@public/components/widgets/TierBannerRibbon";
import FounderDiscount, { Fire } from "./FounderDiscount";
import ExclusiveBuy from "./ExclusiveBuy";
import ExclusiveCheckoutModal from "./ExclusiveCheckoutModal";
import {
  isExclusiveTier,
  money,
  readJoinParams,
  takeStash,
  type ExclusiveStash,
} from "./exclusive";
import styles from "./JoinPage.module.scss";
import xstyles from "./ExclusiveCheckout.module.scss";

// Staged Join + Advertise surface (design kit "Join v3", 2026-08-14; Gold and
// Platinum self-serve, spec 2026-09-23). One decision per stage:
//
//   01 pick a tier   → honest fact banners, no fabricated popularity
//   02 place it      → Silver: the board picker, which ROUTES to the board's
//                      own page (`?sponsor=1`) so that sale happens standing on
//                      the slot. Gold/Platinum: ExclusiveBuy, an in-page slot
//                      picker + rep-code field + price ticket that hands off to
//                      Stripe's hosted checkout (the slot is held while the
//                      buyer pays, so nobody buys a slot that is already taken).
//   03 apply         → the desk: the existing POST /api/join application
//
// This page absorbed the standalone /pricing route (Advertise), which now
// redirects here, carrying its query. Read once at mount and then stripped:
// ?code= ?tier= ?slot= (a rep's link), ?welcome= (Stripe success → receipt),
// ?released=1 (Stripe cancel → free the buyer's own hold), ?card=updated.
//
// It is NOT allowed to become a price oracle. Every number a buyer is charged
// comes from the server (sales_pricing is the single home): the Silver probe's
// `price_usd`, the exclusive slots payload, and /api/checkout/quote. The card
// literals below are display copy, pinned to the server by a test.

interface JoinTier {
  id: SponsorTierId;
  name: string;
  /** List price for the card. Silver is null — its number comes from the API. */
  price: string | null;
  /** The Founder's Deal price, struck in beside the list price once the
   *  Founder band is open. Silver is null — the probe's charged `price_usd`.
   *  Gold/Platinum are card DISPLAY literals; what is charged comes from the
   *  server's sales_pricing.FOUNDER_USD, and api/tests/test_sales_pricing.py
   *  (test_founder_literals_match_the_join_page) pins these two to it. */
  fd: string | null;
  ribbon: string;
  el: string;
  lead: string;
  perks: string[];
}

const JOIN_TIERS: JoinTier[] = [
  {
    id: "silver",
    name: "Silver",
    price: null,
    fd: null,
    ribbon: "Basic",
    el: "Ag",
    lead: "What's included",
    perks: [
      "Your logo + buy-link on your board",
      "Publish up to 5,000 part listings per subcategory",
      "Base reporting",
      "Access to admin console",
      "Direct line-of-contact with a sales rep",
    ],
  },
  {
    id: "gold",
    name: "Gold",
    price: "$2,500",
    fd: "$2,100",
    ribbon: "Pro",
    el: "Au",
    lead: "Everything in Silver, plus…",
    perks: [
      "Sole slot reserved of your choice of subcategory",
      "Pinned above the directory",
      "Preferred placement in BOM Tool results",
      "Audience insights",
      "API access for live stock + price sync",
    ],
  },
  {
    id: "platinum",
    name: "Platinum",
    price: "$10,000",
    fd: "$8,500",
    ribbon: "Enterprise",
    el: "Pt",
    lead: "Everything in Gold, plus…",
    perks: [
      "Top-of-page block in your brand colors, on every subpage",
      "Early access to beta features",
      "Priority line of contact",
      "Access to proprietary AI",
    ],
  },
];

const DESK_EMAIL = "partners@circuitcenter.ai";

// Tokens already posted to /checkout/exclusive/release this document — the
// mount effect runs twice under StrictMode, and once is the whole job.
const RELEASED_TOKENS = new Set<string>();
const FORM_STEPS = ["Company", "Categories", "Confirm"];
const TERMS_NOTE = "12-month minimum · billed monthly · tax included";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/.+\..+/;

interface Board {
  category_id: string;
  name: string;
  parent_name: string;
  path: string;
  open_slots: number;
  total_slots: number;
}

interface BoardRow extends Board {
  icon: string | undefined;
  sponsors: number;
}

interface BoardGroup {
  key: string;
  name: string;
  icon: string | undefined;
  /** Rows a buyer can actually act on (open slots > 0). */
  rows: BoardRow[];
  /** Boards in this group with no Silver sponsor at all. */
  empty: number;
}

// Reveal hook: content is visible by default; only elements still below the
// fold at mount get the pre-state, so a missed IntersectionObserver callback
// can't strand anything invisible (repo gotcha — see CLAUDE.md "Don't gate
// visible content on JS-added classes"). Reduced motion gets no motion.
// `enabled` mirrors the consumer section's mount condition: stages 02/03 only
// exist in the tree after a user action, so an [] effect would run before
// their ref is populated and the reveal would be silently dead for both.
function useRevealJoin(enabled = true) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return undefined;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !("IntersectionObserver" in window)) return undefined;
    if (el.getBoundingClientRect().top <= window.innerHeight * 0.94)
      return undefined;
    el.classList.add(styles.pre);
    const io = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            el.classList.remove(styles.pre);
            io.disconnect();
          }
        });
      },
      { rootMargin: "0px 0px -6% 0px" },
    );
    io.observe(el);
    const bail = window.setTimeout(() => el.classList.remove(styles.pre), 4000);
    return () => {
      io.disconnect();
      window.clearTimeout(bail);
    };
  }, [enabled]);
  return ref;
}

// FIG. 1 — small isometric board in the login IsoBoard's language: dark PCB,
// gold traces/fingers, green electrons. One consistent 2:1 projection.
function JoinIso() {
  return (
    <svg className={styles.iso} viewBox="0 0 220 150" aria-hidden="true">
      <polygon points="110,14 206,62 110,110 14,62" fill="#0d3b26" />
      <polygon points="14,62 110,110 110,126 14,78" fill="#082818" />
      <polygon points="206,62 110,110 110,126 206,78" fill="#0a2f1d" />
      <polygon points="26,70 38,76 38,88 26,82" fill="#a88d2e" opacity="0.9" />
      <polygon points="44,79 56,85 56,97 44,91" fill="#a88d2e" opacity="0.9" />
      <polyline
        points="134,62 168,79"
        fill="none"
        stroke="#a88d2e"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <polyline
        points="86,62 52,79"
        fill="none"
        stroke="#a88d2e"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <polyline
        points="110,76 110,94 130,104"
        fill="none"
        stroke="#a88d2e"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="168" cy="79" r="3.2" fill="#a88d2e" />
      <circle cx="52" cy="79" r="3.2" fill="#a88d2e" />
      <circle cx="130" cy="104" r="3.2" fill="#a88d2e" />
      <polygon points="110,26 154,48 110,70 66,48" fill="#11512f" />
      <polygon points="66,48 110,70 110,79 66,57" fill="#0a3a22" />
      <polygon points="154,48 110,70 110,79 154,57" fill="#0c4227" />
      <text
        x="110"
        y="50"
        textAnchor="middle"
        fontSize="8"
        fill="#d9c98a"
        fontFamily="ui-monospace, monospace"
        letterSpacing="1.5"
      >
        CC-01
      </text>
      <circle className={styles.electron} cx="151" cy="70" r="2.6" fill="#44bd13" />
      <circle
        className={`${styles.electron} ${styles.electron2}`}
        cx="69"
        cy="70"
        r="2.6"
        fill="#44bd13"
      />
    </svg>
  );
}

// Rounded circle-check — inherits the tier color.
function TierCheck() {
  return (
    <svg className={styles.ck} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5 8.2 7.2 10.4 11 5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Stage number tile (01 / 02 / 03 / FAQ) — the same spinning-corner treatment
// the Ag/Au/Pt element tile uses, sized to the header's cap height.
function StageNum({ children }: { children: string }) {
  return (
    <span className={styles.stgNum}>
      <span className={styles.numWheels} aria-hidden="true">
        <i />
        <i />
      </span>
      <b>{children}</b>
    </span>
  );
}

export default function JoinPage() {
  const navigate = useNavigate();
  const { categories } = useCategories();
  const [, setSearchParams] = useSearchParams();

  // ── URL params — read ONCE, then stripped (never setSearchParams in deps) ──
  const [params] = useState(() => readJoinParams(window.location.search));
  // Back from Stripe (?released=1): this tab's stash names the hold to free.
  // Read-once, so a shared link can never release someone else's hold.
  const [released] = useState<{ stash: ExclusiveStash | null } | null>(() =>
    params.released ? { stash: takeStash() } : null,
  );
  const [welcome, setWelcome] = useState(params.welcome ?? null);
  const [cardUpdated, setCardUpdated] = useState(params.card === "updated");
  const [slotsVersion, setSlotsVersion] = useState(0);

  // ── Stage 01 ────────────────────────────────────────────────────────────
  const [tier, setTier] = useState<SponsorTierId | null>(
    () => params.tier ?? released?.stash?.tier ?? null,
  );
  const [hovered, setHovered] = useState<SponsorTierId | null>(null);
  // Founder's Discount band. `fdLive` trails `fdOpen` by one frame — the price
  // burns start only once the band has actually opened, so the two fires run
  // in step.
  const [fdOpen, setFdOpen] = useState(false);
  const [fdLive, setFdLive] = useState(false);
  // The SAME gate <fire-edge> reads at ignition (reduced motion): where the
  // canvas will not start, the static slash stands in — decided once, at the
  // moment of ignition, never by a CSS media query, so the two can never
  // both show (a viewport resize after the burn used to double them).
  const fireOff = useMemo(
    () => fdLive && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [fdLive],
  );
  const closeFounder = () => {
    setFdLive(false);
    setFdOpen(false);
  };

  // ── Stage 02 (Silver board picker) ──────────────────────────────────────
  const [boards, setBoards] = useState<Board[] | null>(null);
  // Null until the server says otherwise — the page must never print a price
  // it did not receive. `monthly` is Silver's LIST (the card's struck price);
  // `silverPrice` is what Stripe charges (the probe's price_usd).
  const [monthly, setMonthly] = useState<number | null>(null);
  const [silverPrice, setSilverPrice] = useState<number | null>(null);
  // 'unconfigured' = the documented 404 (no billing on this deployment) →
  // hide the picker silently and route to the desk. 'error' = anything else
  // (a 502 during the deploy window, a timeout, an ad-blocker eating
  // /checkout/*) → say the list is unavailable. Collapsing both into an empty
  // array told every prospect the entire inventory was sold out, which is a
  // false factual claim on the one page whose job is converting a buyer.
  const [loadState, setLoadState] = useState<
    "loading" | "ok" | "unconfigured" | "error"
  >("loading");
  const [query, setQuery] = useState("");
  const [openCat, setOpenCat] = useState<string | null>(null);

  // ── Stage 03 (the application) ──────────────────────────────────────────
  const [applyOpen, setApplyOpen] = useState(false);
  const [formStep, setFormStep] = useState(0);
  const [companyName, setCompanyName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const carRef = useRef<HTMLDivElement | null>(null);
  const applyRef = useRef<HTMLElement | null>(null);
  const stgRowRef = useRef<HTMLDivElement | null>(null);
  const stage2Ref = useRevealJoin(tier !== null);
  const stage3Ref = useRevealJoin(applyOpen);
  const faqRef = useRevealJoin();

  useEffect(() => {
    let cancelled = false;
    api
      .getSilverBoards()
      .then(data => {
        if (cancelled) return;
        setBoards(data.boards);
        setMonthly(data.monthly_total);
        setSilverPrice(chargedMonthly(data));
        setLoadState("ok");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status =
          typeof err === "object" && err !== null
            ? (err as { response?: { status?: number } }).response?.status
            : undefined;
        setLoadState(status === 404 ? "unconfigured" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Strip the read-once params so a refresh or a forwarded link cannot replay
  // a receipt, a release or a rep's code. (The page-view tracker records the
  // pathname only, so ?code= never reaches analytics either way.)
  useEffect(() => {
    if (Object.keys(params).length === 0) return;
    setSearchParams(
      prev => {
        for (const k of ["code", "tier", "slot", "welcome", "released", "card"]) prev.delete(k);
        return prev;
      },
      { replace: true },
    );
  }, []);

  // Free the buyer's own hold on the way back from Stripe, THEN re-read the
  // slot list so the slot shows as open again.
  useEffect(() => {
    const token = released?.stash?.release_token;
    if (!token || RELEASED_TOKENS.has(token)) return;
    RELEASED_TOKENS.add(token);
    api
      .releaseExclusiveHold(token)
      .catch(() => undefined)
      .finally(() => setSlotsVersion(v => v + 1));
  }, []);

  // A rep's link (or a return trip) lands with a tier chosen: bring stage 02
  // into view once it has mounted.
  useEffect(() => {
    if (!params.tier && !released?.stash) return undefined;
    const id = window.setTimeout(() => {
      const el = stage2Ref.current;
      if (el)
        window.scrollTo({
          top: el.getBoundingClientRect().top + window.scrollY - 76,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
    }, 120);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!applyOpen) return undefined;
    const id = window.setTimeout(() => {
      const el = applyRef.current;
      if (el)
        window.scrollTo({
          top: el.getBoundingClientRect().top + window.scrollY - 76,
          behavior: "smooth",
        });
    }, 80);
    return () => window.clearTimeout(id);
  }, [applyOpen]);

  // Category icons for the picker. The boards endpoint is the inventory
  // authority (it is what the 409 capacity check reads); categories only
  // decorate it, so a missing icon degrades a row, never hides a board.
  const iconIndex = useMemo(() => {
    const byParent = new Map<string, string>();
    const byPath = new Map<string, string>();
    const order = new Map<string, number>();
    categories.forEach((c, i) => {
      byParent.set(c.name, c.icon);
      order.set(c.name, i);
      (c.children ?? []).forEach(s => {
        byPath.set(`/category/${c.slug}/${s.slug}`, s.icon);
      });
    });
    return { byParent, byPath, order };
  }, [categories]);

  const groups = useMemo<BoardGroup[]>(() => {
    const byParent = new Map<string, BoardGroup>();
    (boards ?? []).forEach(b => {
      let g = byParent.get(b.parent_name);
      if (!g) {
        g = {
          key: b.parent_name,
          name: b.parent_name,
          icon: iconIndex.byParent.get(b.parent_name),
          rows: [],
          empty: 0,
        };
        byParent.set(b.parent_name, g);
      }
      const sponsors = Math.max(0, b.total_slots - b.open_slots);
      if (sponsors === 0) g.empty += 1;
      // Full boards are dropped: the picker routes to a purchase panel, and
      // POST /api/checkout/silver 409s a board with no open slot.
      if (b.open_slots > 0) {
        g.rows.push({ ...b, sponsors, icon: iconIndex.byPath.get(b.path) });
      }
    });
    return [...byParent.values()]
      .filter(g => g.rows.length > 0)
      .sort(
        (a, b) =>
          (iconIndex.order.get(a.name) ?? Number.MAX_SAFE_INTEGER) -
            (iconIndex.order.get(b.name) ?? Number.MAX_SAFE_INTEGER) ||
          a.name.localeCompare(b.name),
      );
  }, [boards, iconIndex]);

  const boardTotal = boards?.length ?? 0;
  const emptyCount = (boards ?? []).filter(
    b => b.total_slots - b.open_slots === 0,
  ).length;
  // 'full' is a REAL sold-out answer (the server returned rows and none has an
  // open slot). It is deliberately distinct from 'error' — a failed fetch must
  // never render as sold out, which is the one false claim this page cannot
  // afford to make.
  const silverState: "ok" | "loading" | "error" | "unconfigured" | "full" =
    loadState === "ok" ? (groups.length > 0 ? "ok" : "full") : loadState;
  const haveBoards = silverState === "ok";

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
  const openGroup = needle ? null : groups.find(g => g.key === openCat) ?? null;

  const activeTier = JOIN_TIERS.find(t => t.id === tier) ?? null;
  const emailOk = useMemo(() => EMAIL_RE.test(email.trim()), [email]);
  const websiteOk = useMemo(() => !website || URL_RE.test(website.trim()), [website]);
  // Client-side reference id — the API returns no receipt number, so this is
  // a courtesy label the applicant can quote back, not a server record.
  const appId = useMemo(
    () => `JC-${Date.now().toString(36).toUpperCase().slice(-6)}`,
    [],
  );

  function toggleCategory(slug: string) {
    setSelectedCategories(prev =>
      prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug],
    );
  }

  function spinCar(dir: number) {
    const el = carRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  }

  function nextStep() {
    setError(null);
    if (formStep === 0) {
      if (!companyName.trim()) {
        setError("Company name is required.");
        return;
      }
      if (!email.trim() || !emailOk) {
        setError("Please enter a valid email.");
        return;
      }
      if (website && !websiteOk) {
        setError("Website must start with http:// or https://");
        return;
      }
    }
    setFormStep(s => Math.min(s + 1, 2));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!tier) {
      setError("Pick a tier in step 01 first.");
      return;
    }
    if (!companyName.trim() || !email.trim()) {
      setError("Company name and email are required.");
      return;
    }
    if (!emailOk) {
      setError("Please enter a valid email.");
      return;
    }
    if (website && !websiteOk) {
      setError("Website must start with http:// or https://");
      return;
    }
    if (!agreedTerms) {
      setError("Please accept the listing terms.");
      return;
    }

    setSubmitting(true);
    try {
      await api.submitJoin({
        company_name: companyName.trim(),
        contact_person: contactPerson.trim(),
        email: email.trim(),
        phone: phone.trim(),
        website: website.trim(),
        categories_of_interest: selectedCategories,
        tier,
        message: message.trim(),
      });
      setSubmitted(true);
    } catch (err) {
      // Log the upstream failure so production debugging has a trail; the
      // user-facing message stays generic to avoid leaking API internals.
      console.error("[JoinPage] api.submitJoin failed", err);
      setError("Something went wrong. Please try again later.");
    } finally {
      setSubmitting(false);
    }
  }

  const deskLink = (label: string) => (
    <a className={styles.link} href={`mailto:${DESK_EMAIL}`}>
      {label}
    </a>
  );

  const boardRow = (r: BoardRow) => (
    <li key={r.category_id}>
      <button
        type="button"
        className={styles.board}
        onClick={() => navigate(`${r.path}?sponsor=1`)}
      >
        {r.icon && (
          <span className={styles.boardIcon} aria-hidden="true">
            <Icon name={r.icon} />
          </span>
        )}
        <span className={styles.boardName}>{r.name}</span>
        <span className={styles.boardSlots}>
          {r.sponsors === 0 ? (
            <em className={styles.boardFirst}>Be the first</em>
          ) : (
            `${r.open_slots} of ${r.total_slots} slots open`
          )}
        </span>
        <span className={styles.boardGo} aria-hidden="true">
          {'›'}
        </span>
      </button>
    </li>
  );

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: "easeInOut" as const }}
    >
      <PageHead seo={STATIC_PAGE_SEO.join} />
      <PageHeaderBand
        page="join"
        title="Join Circuit Center"
        subtitle={
          silverPrice != null
            ? `Get listed and advertised in the components directory — sponsorship tiers from ${money(silverPrice)}/mo.`
            : "Get listed and advertised in the components directory."
        }
      />

      <div className={styles.page}>
        {submitted ? (
          <div className={styles.success}>
            <div className={styles.successCard}>
              <span className={styles.successMark} aria-hidden="true">
                &#10003;
              </span>
              <h2 className={styles.successTitle}>
                Welcome aboard, {companyName || "partner"}.
              </h2>
              <p className={styles.successText}>
                We&rsquo;ve received your application for the{" "}
                <strong>{activeTier ? activeTier.name : "—"}</strong> tier across{" "}
                <strong>{selectedCategories.length}</strong>{" "}
                {selectedCategories.length === 1 ? "category" : "categories"}. A
                founder will reach out at <code>{email}</code> within one business
                day.
              </p>
              <div className={styles.successReceipt}>
                <div>
                  <span>APP-ID</span>
                  <span>{appId}</span>
                </div>
                <div>
                  <span>TIER</span>
                  <span>{tier ? tier.toUpperCase() : "—"}</span>
                </div>
                <div>
                  <span>TERM</span>
                  <span>12-MO MIN · MONTHLY</span>
                </div>
                <div>
                  <span>CATS</span>
                  <span>{selectedCategories.length || "—"}</span>
                </div>
                <div>
                  <span>STATUS</span>
                  <span className={styles.successOk}>RECEIVED</span>
                </div>
              </div>
              <div className={styles.successActions}>
                <Link to="/">
                  <GlowButton variant="primary">Back to Home</GlowButton>
                </Link>
                <Link to="/contact">
                  <GlowButton variant="gold">Reach a founder</GlowButton>
                </Link>
              </div>
            </div>
          </div>
        ) : (
          <div
            className={styles.stack}
            data-tier-active={tier ?? undefined}
            data-fd={fdLive ? "on" : undefined}
            data-fire={fireOff ? "off" : undefined}
          >
            {cardUpdated && (
              <div className={xstyles.notice} role="status">
                <p>
                  Card updated. Your next monthly charge uses it, and any payment
                  that was waiting has been retried.
                </p>
                <button
                  type="button"
                  className={xstyles.noticeClose}
                  onClick={() => setCardUpdated(false)}
                >
                  Dismiss
                </button>
              </div>
            )}
            {released && (
              <div className={xstyles.notice} role="status">
                <p>
                  {released.stash?.release_token
                    ? `Checkout cancelled — nothing was charged, and ${
                        released.stash.slot_name ?? "your slot"
                      } is open again.`
                    : "Checkout cancelled — nothing was charged. Any slot you were holding frees itself within the hour."}
                </p>
              </div>
            )}
            <div className={styles.proof}>
              <div>
                <strong>Buyer-intent traffic.</strong> Visitors arrive with a part
                number already in hand.
              </div>
              <div>
                <strong>Direct buy-links.</strong> Your store, your checkout — we
                never reroute the order.
              </div>
              <div>
                <strong>Reporting that scales.</strong> Base reports on Silver;
                audience insights and API sync up top.
              </div>
            </div>

            {/* ── 01 · pick a tier ─────────────────────────────────────── */}
            <section className={styles.stage} aria-label="Step 1: pick a tier">
              <div className={styles.stgRow} ref={stgRowRef}>
                <div className={styles.stgHead}>
                  <StageNum>01</StageNum>
                  <h2 className={styles.stgTitle}>Pick your tier</h2>
                </div>
                <FounderDiscount
                  anchorRef={stgRowRef}
                  open={fdOpen}
                  onToggle={() => (fdOpen ? closeFounder() : setFdOpen(true))}
                  onArrive={() => setFdLive(true)}
                />
              </div>
              <p className={styles.stgLine}>
                {tier
                  ? "Tier locked in below — change it any time."
                  : "One decision to start: how visible do you want to be?"}
              </p>
              {/* NOT a radiogroup: ARIA radios treat children as presentational,
                  which would strip the price, perks and the nested Select button
                  from the accessibility tree. Each card's real control is its
                  Select button (aria-pressed); the card div is a pointer
                  convenience only. */}
              <div
                className={styles.tierRow}
                role="group"
                aria-label="Sponsorship tier"
              >
                {JOIN_TIERS.map(t => {
                  const price =
                    t.id === "silver" ? (monthly != null ? money(monthly) : null) : t.price;
                  const fdPrice =
                    t.id === "silver"
                      ? silverPrice != null
                        ? money(silverPrice)
                        : null
                      : t.fd;
                  return (
                    <div
                      key={t.id}
                      className={styles.tier}
                      data-tier={t.id}
                      data-selected={tier === t.id || undefined}
                      onClick={() => setTier(t.id)}
                      onMouseEnter={() => setHovered(t.id)}
                      onMouseLeave={() => setHovered(h => (h === t.id ? null : h))}
                    >
                      <span className={styles.tierHead}>
                        <span className={styles.tierName}>{t.name}</span>
                        <TierBannerRibbon
                          tier={t.id}
                          el={t.el}
                          label={t.ribbon}
                          active={hovered === t.id}
                          checked={tier === t.id}
                        />
                      </span>
                      {price ? (
                        <span className={styles.price}>
                          <span className={styles.priceVal}>
                            <span className={styles.priceTxt}>{price}</span>
                            {/* Static strike on EXACTLY the fire line's endpoints
                                (1.6,102.6 → 98.4,-2.6 in % of the box) — the
                                old fixed -38° bar diverged from the coal bed at
                                every aspect but one. */}
                            <svg
                              className={styles.slash}
                              viewBox="0 0 100 100"
                              preserveAspectRatio="none"
                              aria-hidden="true"
                            >
                              <line
                                x1="1.6"
                                y1="102.6"
                                x2="98.4"
                                y2="-2.6"
                                vectorEffect="non-scaling-stroke"
                              />
                            </svg>
                            <Fire
                              on={fdLive}
                              mode="line"
                              delay="0.1"
                              dur="1"
                              linear
                              scale="11"
                              blend="over"
                              coals
                              hold="1"
                              linger="4"
                              x1="1.6"
                              y1="102.6"
                              x2="98.4"
                              y2="-2.6"
                            />
                            <span className={styles.fdTag} aria-hidden={!fdLive}>
                              <span className={styles.fdIgn}>15% off</span>
                              <Fire
                                on={fdLive}
                                mode="sweep"
                                delay="0.9"
                                dur="0.45"
                                scale="7"
                                blend="over"
                                intensity="0.7"
                              />
                            </span>
                          </span>
                          <small>/mo</small>
                          <span className={styles.fdNew} aria-hidden={!fdLive}>
                            <span className={styles.fdIgn}>
                              {fdPrice}
                              <small>/mo</small>
                            </span>
                            <Fire
                              on={fdLive}
                              mode="sweep"
                              delay="1.05"
                              dur="0.45"
                              scale="14"
                              blend="over"
                              intensity="0.8"
                            />
                          </span>
                        </span>
                      ) : (
                        <span className={styles.priceAsk}>
                          Ask the desk for this month&rsquo;s rate
                        </span>
                      )}
                      <button
                        type="button"
                        className={styles.tierCta}
                        aria-pressed={tier === t.id}
                        onClick={e => {
                          e.stopPropagation();
                          setTier(t.id);
                        }}
                      >
                        {tier === t.id ? (
                          <>&#10003; Selected</>
                        ) : t.id === "silver" ? (
                          `Select ${t.name}`
                        ) : (
                          `Buy ${t.name}`
                        )}
                      </button>
                      <span className={styles.featLabel}>FEATURES</span>
                      <p className={styles.featLead}>{t.lead}</p>
                      <ul className={styles.perks}>
                        {t.perks.map(p => (
                          <li key={p}>
                            <TierCheck />
                            {p}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
              <p className={styles.deskLine}>
                Prefer to talk it through? {deskLink("Email the partners desk")} —
                same-day answers Mon–Fri, and the desk never marks up.
              </p>
            </section>

            {/* ── 02 · place it ────────────────────────────────────────── */}
            {tier && activeTier && (
              <section
                className={`${styles.stage} ${styles.reveal}`}
                ref={stage2Ref}
                aria-label="Step 2: place it"
              >
                <div className={styles.stgHead}>
                  <StageNum>02</StageNum>
                  <h2 className={styles.stgTitle}>
                    {tier === "silver"
                      ? "Choose your board"
                      : tier === "gold"
                        ? "Choose your Gold subcategory"
                        : "Choose your Platinum category"}
                  </h2>
                </div>
                <p className={styles.stgLine}>
                  {tier !== "silver"
                    ? `${activeTier.name} is one sponsor per ${
                        tier === "gold" ? "subcategory" : "top-level category"
                      } — pick an open one and it's held for you while you pay, so nobody buys a slot that's already taken.`
                    : haveBoards
                      ? `${emptyCount} of ${boardTotal} boards have no Silver sponsor yet — tap a category to see its boards.`
                      : silverState === "loading"
                        ? "Loading the boards with open slots…"
                        : silverState === "full"
                          ? "Every board is carrying its five sponsors right now — the desk keeps the list of what opens next."
                          : "The partners desk can place you while the live board list is unavailable."}
                </p>
                <div
                  className={styles.place}
                  data-wide={tier !== "silver" || undefined}
                >
                  <div className={styles.placeMain}>
                    {tier === "silver" ? (
                      haveBoards ? (
                        <div className={styles.picker}>
                          <input
                            id="board-search"
                            type="text"
                            className={styles.search}
                            placeholder="Search subcategories — amplifiers, sensors, connectors…"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            aria-label="Search boards"
                          />
                          {needle ? (
                            matchGroups.length === 0 ? (
                              <p className={styles.pickerNote}>
                                No board matches &ldquo;{query}&rdquo;.{" "}
                                {deskLink("Email the partners desk")}.
                              </p>
                            ) : (
                              matchGroups.map(g => (
                                <div key={g.key} className={styles.group}>
                                  <h4 className={styles.groupHead}>
                                    <Icon name={g.icon} />
                                    {g.name}
                                  </h4>
                                  <ul className={styles.boardList}>
                                    {g.rows.map(boardRow)}
                                  </ul>
                                </div>
                              ))
                            )
                          ) : (
                            <>
                              <div className={styles.boardCatGrid}>
                                {groups.map(g => {
                                  const on = openCat === g.key;
                                  return (
                                    <button
                                      type="button"
                                      key={g.key}
                                      className={styles.boardCat}
                                      aria-expanded={on}
                                      aria-controls="join-board-panel"
                                      onClick={() => setOpenCat(on ? null : g.key)}
                                    >
                                      <span
                                        className={styles.boardCatIcon}
                                        aria-hidden="true"
                                      >
                                        <Icon name={g.icon} />
                                      </span>
                                      <span className={styles.boardCatBody}>
                                        <span className={styles.boardCatName}>
                                          {g.name}
                                        </span>
                                        <span className={styles.boardCatSub}>
                                          {g.rows.length}{" "}
                                          {g.rows.length === 1 ? "board" : "boards"}{" "}
                                          open
                                          {g.empty > 0 && (
                                            <em> · {g.empty} unsponsored</em>
                                          )}
                                        </span>
                                      </span>
                                      <span
                                        className={styles.boardCatMark}
                                        aria-hidden="true"
                                      >
                                        {on ? "−" : "+"}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                              {openGroup && (
                                <div
                                  className={styles.catPanel}
                                  key={openGroup.key}
                                  id="join-board-panel"
                                >
                                  <div className={styles.catPanelHead}>
                                    <Icon name={openGroup.icon} />
                                    <strong>{openGroup.name}</strong>
                                    <span className={styles.catPanelNum}>
                                      {openGroup.empty} UNSPONSORED ·{" "}
                                      {openGroup.rows.length} OPEN
                                    </span>
                                    <button
                                      type="button"
                                      className={styles.catPanelClose}
                                      onClick={() => setOpenCat(null)}
                                      aria-label="Collapse category"
                                    >
                                      &#215;
                                    </button>
                                  </div>
                                  <ul className={styles.boardList}>
                                    {openGroup.rows.map(boardRow)}
                                  </ul>
                                </div>
                              )}
                            </>
                          )}
                          <p className={styles.pickerFoot}>
                            Prefer we set it up for you?{" "}
                            <button
                              type="button"
                              className={styles.linkBtn}
                              onClick={() => setApplyOpen(true)}
                            >
                              Apply through the desk {'→'}
                            </button>{" "}
                            Same price either way — the desk never marks up.
                          </p>
                        </div>
                      ) : (
                        <div className={styles.arrange}>
                          <p className={styles.arrangeLine}>
                            {silverState === "loading"
                              ? "Fetching the boards with open Silver slots…"
                              : silverState === "error"
                                ? "The live board list isn't loading right now — that's a display problem, not a sold-out one. The desk has the current openings and can place you directly."
                                : silverState === "full"
                                  ? "Every Silver board is carrying its five sponsors right now. The desk keeps the list of what opens next and can hold you a slot."
                                  : "Self-serve checkout is switched off on this deployment. The partners desk places Silver directly, at the same price."}
                          </p>
                          {silverState !== "loading" && (
                            <div className={styles.arrangeCta}>
                              <GlowButton
                                type="button"
                                variant="primary"
                                onClick={() => setApplyOpen(true)}
                              >
                                Ask about Silver {'→'}
                              </GlowButton>
                              <span className={styles.same}>
                                Same price either way — the desk never marks up.
                              </span>
                            </div>
                          )}
                        </div>
                      )
                    ) : isExclusiveTier(tier) ? (
                      <ExclusiveBuy
                        key={tier}
                        tier={tier}
                        tierName={activeTier.name}
                        perks={activeTier.perks}
                        iconIndex={iconIndex}
                        initialCode={params.code}
                        initialSlot={params.slot ?? released?.stash?.slot_id}
                        refreshKey={slotsVersion}
                        onAskDesk={() => setApplyOpen(true)}
                      />
                    ) : null}
                  </div>
                  {tier === "silver" && (
                    <aside className={styles.figAside} aria-hidden="true">
                      <JoinIso />
                      <span className={styles.figLabel}>FIG. 1 — BOARD PLACEMENT</span>
                      <p className={styles.figLine}>
                        Your logo and buy-link render on the board engineers actually
                        browse.
                      </p>
                    </aside>
                  )}
                </div>
              </section>
            )}

            {/* ── 03 · apply ───────────────────────────────────────────── */}
            {applyOpen && (
              <section
                className={`${styles.stage} ${styles.reveal}`}
                ref={el => {
                  stage3Ref.current = el;
                  applyRef.current = el;
                }}
                aria-label="Step 3: apply"
              >
                <div className={styles.stgHead}>
                  <StageNum>03</StageNum>
                  <h2 className={styles.stgTitle}>Apply to get listed</h2>
                </div>
                <p className={styles.stgLine}>
                  A founder confirms your placement within one business day.
                </p>
                <form className={styles.form} onSubmit={handleSubmit} noValidate>
                  <div className={styles.formHead}>
                    <div
                      className={styles.steps}
                      aria-label={`Form progress: step ${formStep + 1} of 3`}
                    >
                      {FORM_STEPS.map((s, i) => (
                        <span key={s} className={styles.stepWrap}>
                          {i > 0 && <span className={styles.stepBar} aria-hidden="true" />}
                          <button
                            type="button"
                            className={styles.step}
                            data-state={
                              i === formStep ? "current" : i < formStep ? "done" : "todo"
                            }
                            onClick={() => {
                              if (i < formStep) {
                                setFormStep(i);
                                setError(null);
                              }
                            }}
                          >
                            <i>{i < formStep ? <>&#10003;</> : i + 1}</i>
                            {s}
                          </button>
                        </span>
                      ))}
                    </div>
                    {activeTier && (
                      <span className={styles.applying}>
                        APPLYING FOR: {activeTier.name.toUpperCase()}
                        {activeTier.id === "silver"
                          ? silverPrice != null
                            ? ` · FOUNDER'S DEAL ${money(silverPrice)}/MO`
                            : ""
                          : ` · FOUNDER'S DEAL ${activeTier.fd}/MO`}
                      </span>
                    )}
                  </div>

                  {error && (
                    <div className={styles.error} role="alert">
                      {error}
                    </div>
                  )}

                  {formStep === 0 && (
                    <fieldset className={styles.fset}>
                      <div className={styles.row}>
                        <div className={styles.field}>
                          <label className={styles.label} htmlFor="join-company">
                            Company name<span className={styles.required}>*</span>
                          </label>
                          <input
                            id="join-company"
                            className={styles.input}
                            type="text"
                            value={companyName}
                            onChange={e => setCompanyName(e.target.value)}
                            placeholder="Acme Electronics, Inc."
                          />
                        </div>
                        <div className={styles.field}>
                          <label className={styles.label} htmlFor="join-contact">
                            Contact person
                          </label>
                          <input
                            id="join-contact"
                            className={styles.input}
                            type="text"
                            value={contactPerson}
                            onChange={e => setContactPerson(e.target.value)}
                            placeholder="Jane Doe, VP Sales"
                          />
                        </div>
                      </div>
                      <div className={styles.row}>
                        <div className={styles.field}>
                          <label className={styles.label} htmlFor="join-email">
                            Email<span className={styles.required}>*</span>
                          </label>
                          {/* type="text" (NOT the HTML5 email input) — the JS
                              `emailOk` regex + `noValidate` own validation.
                              HTML5 type validation silently kills submit with
                              no :invalid styling and no console error. */}
                          <input
                            id="join-email"
                            className={[
                              styles.input,
                              email && !emailOk ? styles.inputInvalid : "",
                              email && emailOk ? styles.inputValid : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            type="text"
                            inputMode="email"
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                            value={email}
                            onChange={e => setEmail(e.target.value)}
                            placeholder="sales@company.com"
                          />
                          {email && (
                            <span
                              className={[
                                styles.fhint,
                                emailOk ? styles.fhintOk : styles.fhintBad,
                              ].join(" ")}
                            >
                              {emailOk
                                ? "✓ valid email"
                                : "must look like name@domain.tld"}
                            </span>
                          )}
                        </div>
                        <div className={styles.field}>
                          <label className={styles.label} htmlFor="join-phone">
                            Phone
                          </label>
                          <input
                            id="join-phone"
                            className={styles.input}
                            type="text"
                            inputMode="tel"
                            value={phone}
                            onChange={e => setPhone(e.target.value)}
                            // Format on blur, never per keystroke: reshaping
                            // mid-typing fights the caret. formatPhone strips a
                            // leading country-code 1 from an 11-digit paste.
                            onBlur={() => setPhone(p => formatPhone(p))}
                            placeholder="(555) 123-4567"
                          />
                        </div>
                      </div>
                      <div className={styles.field}>
                        <label className={styles.label} htmlFor="join-website">
                          Website
                        </label>
                        {/* type="text" (NOT the HTML5 URL input) — see the guard
                            at api/tests/test_no_type_url_form_input.py. */}
                        <input
                          id="join-website"
                          className={[
                            styles.input,
                            website && !websiteOk ? styles.inputInvalid : "",
                            website && websiteOk ? styles.inputValid : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          type="text"
                          inputMode="url"
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          value={website}
                          onChange={e => setWebsite(e.target.value)}
                          placeholder="https://www.company.com"
                        />
                        {website && !websiteOk && (
                          <span className={`${styles.fhint} ${styles.fhintBad}`}>
                            must start with http:// or https://
                          </span>
                        )}
                      </div>
                    </fieldset>
                  )}

                  {formStep === 1 && (
                    <fieldset className={styles.fset}>
                      <div className={styles.carHead}>
                        <p className={styles.fhelp}>
                          Pick every category you supply — we&rsquo;ll list you in
                          each.
                        </p>
                        <div className={styles.carCtl}>
                          <span className={`${styles.fhint} ${styles.fhintMono}`}>
                            {selectedCategories.length} / {categories.length} selected
                          </span>
                          <button
                            type="button"
                            className={styles.carBtn}
                            onClick={() => spinCar(-1)}
                            aria-label="Previous categories"
                          >
                            {'‹'}
                          </button>
                          <button
                            type="button"
                            className={styles.carBtn}
                            onClick={() => spinCar(1)}
                            aria-label="Next categories"
                          >
                            {'›'}
                          </button>
                        </div>
                      </div>
                      <div className={styles.car} ref={carRef}>
                        {categories.map(c => {
                          const on = selectedCategories.includes(c.slug);
                          return (
                            <button
                              type="button"
                              key={c.id}
                              className={[styles.catChip, on ? styles.catChipOn : ""]
                                .filter(Boolean)
                                .join(" ")}
                              onClick={() => toggleCategory(c.slug)}
                              aria-pressed={on}
                            >
                              <span className={styles.catIcon} aria-hidden="true">
                                <Icon name={c.icon} />
                              </span>
                              <span className={styles.catName}>{c.name}</span>
                              <span className={styles.catMark} aria-hidden="true">
                                {on ? <>&#10003;</> : "+"}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </fieldset>
                  )}

                  {formStep === 2 && (
                    <fieldset className={styles.fset}>
                      <div className={styles.field}>
                        <label className={styles.label} htmlFor="join-message">
                          Message (optional)
                        </label>
                        <textarea
                          id="join-message"
                          className={styles.textarea}
                          rows={4}
                          value={message}
                          onChange={e => setMessage(e.target.value)}
                          maxLength={600}
                          placeholder="Tell us about your stock depth, lead times, or any specific categories you'd like to feature."
                        />
                        <span className={styles.fhint} aria-live="polite">
                          {message.length} / 600
                        </span>
                      </div>
                      <label className={styles.terms}>
                        <input
                          type="checkbox"
                          checked={agreedTerms}
                          onChange={e => setAgreedTerms(e.target.checked)}
                        />
                        <span>
                          I have authority to list this company and accept the{" "}
                          <Link className={styles.link} to="/terms">
                            Listing Terms
                          </Link>{" "}
                          and{" "}
                          <Link className={styles.link} to="/acceptable-use">
                            Acceptable Use Policy
                          </Link>
                          .
                        </span>
                      </label>
                    </fieldset>
                  )}

                  <div className={styles.actionsRow}>
                    {formStep > 0 ? (
                      <GlowButton
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setFormStep(s => s - 1);
                          setError(null);
                        }}
                      >
                        {'←'} Back
                      </GlowButton>
                    ) : (
                      <span className={styles.termsNote}>{TERMS_NOTE}</span>
                    )}
                    {formStep < 2 ? (
                      <GlowButton type="button" variant="primary" onClick={nextStep}>
                        Continue {'→'} {FORM_STEPS[formStep + 1]}
                      </GlowButton>
                    ) : (
                      <span className={styles.submitRow}>
                        <span className={styles.termsNote}>{TERMS_NOTE}</span>
                        <GlowButton type="submit" variant="primary" disabled={submitting}>
                          {submitting ? "Submitting…" : <>Submit Application {'→'}</>}
                        </GlowButton>
                      </span>
                    )}
                  </div>
                </form>
              </section>
            )}

            {/* ── FAQ ──────────────────────────────────────────────────── */}
            <section className={styles.reveal} ref={faqRef} aria-label="Common questions">
              <div className={styles.stgHead}>
                <StageNum>FAQ</StageNum>
                <h2 className={styles.stgTitle}>Common questions</h2>
              </div>
              <div className={styles.faq}>
                <details>
                  <summary>What does the 12-month minimum mean?</summary>
                  <p>
                    Every tier runs a 12-month minimum term, billed monthly with tax
                    included — no annual lump sum.
                  </p>
                </details>
                <details>
                  <summary>How many sponsors fit on a board?</summary>
                  <p>
                    Silver boards hold five sponsors — the interesting number is the{" "}
                    {haveBoards ? `${emptyCount} ` : ""}boards with none yet, where
                    you&rsquo;d be first. Gold is one sponsor per subcategory;
                    Platinum is one per top-level category.
                  </p>
                </details>
                <details>
                  <summary>Is buying through the desk more expensive?</summary>
                  <p>
                    No. The desk prices every tier by the same rule this page does —
                    the Founder&rsquo;s Deal, less any code your rep gives you. Use it
                    if you&rsquo;d rather talk it through or pay by invoice.
                  </p>
                </details>
                <details>
                  <summary>How fast am I live?</summary>
                  <p>
                    Buy on this page and your placement appears within a minute of
                    payment. Apply through the desk and a founder confirms it within
                    one business day.
                  </p>
                </details>
                <details>
                  <summary>Do you take a cut of my sales?</summary>
                  <p>
                    No. Buy-links go straight to your store and your checkout — we
                    never reroute the order.
                  </p>
                </details>
              </div>
            </section>

            <p className={styles.kw}>
              Sponsoring a search term instead?{" "}
              <Link className={styles.link} to="/keyword">
                Keyword sponsorships
              </Link>{" "}
              are priced and arranged separately from board placements.
            </p>
          </div>
        )}
      </div>
      {welcome && (
        <ExclusiveCheckoutModal
          variant="receipt"
          tier={welcome}
          tierName={welcome === "gold" ? "Gold" : "Platinum"}
          onClose={() => setWelcome(null)}
        />
      )}
    </motion.div>
  );
}
