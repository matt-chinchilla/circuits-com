import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import PageHead from "@public/components/PageHead";
import PageHeaderBand from "@public/components/layout/PageHeaderBand";
import { STATIC_PAGE_SEO } from "@public/services/seoRoutes";
import { api } from "@public/services/api";
import styles from "./PricingPage.module.scss";

// The sendable purchase page. A rep pastes this URL, or a prospect finds it
// from the nav — either way it does three things and no more:
//
//   1. States the real prices (Silver self-serve, Gold and Platinum through
//      the desk, because single-slot tiers cannot be raced through checkout).
//   2. Routes a Silver buyer to a BOARD — the picker deep-links to the
//      category page with the purchase panel open, so the sale still happens
//      standing on the slot the buyer will occupy.
//   3. Names the humans. The Q-series desk (transistors amplify; so do reps)
//      is a peer of the price table, not a footnote under it.

interface Board {
  category_id: string;
  name: string;
  parent_name: string;
  path: string;
  open_slots: number;
  total_slots: number;
}

const REPS = [
  { des: "Q1", name: "Anthony", email: "anthony@circuitcenter.ai" },
  { des: "Q2", name: "Daniel", email: "daniel@circuitcenter.ai" },
  { des: "Q3", name: "Ronald", email: "ronald@circuitcenter.ai" },
];

const EXCLUSIVE_TIERS = [
  {
    id: "gold",
    name: "Gold",
    price: "$600",
    kicker: "◆ PREMIERE PARTNER",
    line: "One sponsor per subcategory — the flashlight board beside the directory.",
    perks: [
      "Sole Gold placement on the subcategory",
      "Full-height board with your brand colors",
      "Logo, contact and coverage hours",
      "Listed above the Silver directory",
    ],
  },
  {
    id: "platinum",
    name: "Platinum",
    price: "$2,400",
    kicker: "EXCLUSIVE PARTNER",
    line: "One sponsor per top-level category — the banner every subpage carries.",
    perks: [
      "Sole Platinum placement across the category",
      "Brand takeover of the live PCB banner",
      "Present on every subcategory page beneath it",
      "Priority placement in category search",
    ],
  },
];

export default function PricingPage() {
  const navigate = useNavigate();
  const [boards, setBoards] = useState<Board[] | null>(null);
  // Null until the server says otherwise — the page must never print a price
  // it did not receive. A hardcoded fallback would silently keep showing the
  // old number after a ladder change.
  const [monthly, setMonthly] = useState<number | null>(null);
  // 'unconfigured' = the documented 404 (no billing on this deployment) →
  // hide the picker silently. 'error' = anything else (a 502 during the
  // deploy window, a timeout, an ad-blocker eating /checkout/*) → say the
  // list is unavailable. Collapsing both into an empty array told every
  // prospect the entire inventory was sold out, which is a false factual
  // claim on the one page whose job is converting a buyer.
  const [loadState, setLoadState] = useState<"loading" | "ok" | "unconfigured" | "error">(
    "loading",
  );
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getSilverBoards()
      .then(data => {
        if (cancelled) return;
        setBoards(data.boards);
        setMonthly(data.monthly_total);
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

  const open = (boards ?? []).filter(b => b.open_slots > 0);
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? open.filter(
        b =>
          b.name.toLowerCase().includes(needle) ||
          b.parent_name.toLowerCase().includes(needle),
      )
    : open;
  const shown = showAll ? matches : matches.slice(0, 12);

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: "easeInOut" as const }}
    >
      <PageHead seo={STATIC_PAGE_SEO.pricing} />
      <PageHeaderBand
        page="pricing"
        title="Sponsorship pricing"
        subtitle="Put your company in front of engineers at the moment they're sourcing parts."
      />

      <div className={styles.page}>
        {/* Silver — the self-serve tier, lead position because it is the one
            a visitor can act on right now. */}
        <section className={styles.silver}>
          <div className={styles.silverHead}>
            <div>
              <span className={styles.kicker}>◆ PREFERRED PARTNER</span>
              <h2 className={styles.tierName}>Silver</h2>
              <p className={styles.tierLine}>
                Your company on a subcategory board — up to five partners per board,
                so you can start today without waiting for an exclusive to open.
              </p>
            </div>
            {monthly != null && (
              <div className={styles.priceBlock}>
                <span className={styles.price}>${monthly}</span>
                <span className={styles.per}>/mo — tax included</span>
              </div>
            )}
          </div>
          <ul className={styles.perks}>
            <li>Logo and link on the subcategory board</li>
            <li>Listed across that subcategory's directory</li>
            <li>Partner platform access to manage your listings</li>
            <li>Month to month — cancel anytime</li>
          </ul>

          {loadState === "loading" ? (
            <p className={styles.pickerNote}>Loading boards…</p>
          ) : loadState === "unconfigured" ? null : loadState === "error" ? (
            <p className={styles.pickerNote}>
              The board list isn&rsquo;t loading right now.{" "}
              <a href={`mailto:${REPS[1].email}`}>Email {REPS[1].name}</a> and he&rsquo;ll
              set your placement up directly.
            </p>
          ) : open.length === 0 ? (
            <p className={styles.pickerNote}>
              Every board is currently full.{" "}
              <a href={`mailto:${REPS[1].email}`}>Email {REPS[1].name}</a> and he&rsquo;ll
              tell you what&rsquo;s opening next.
            </p>
          ) : (
            <div className={styles.picker}>
              <label className={styles.pickerLabel} htmlFor="board-search">
                Choose your board — {open.length} with open slots
              </label>
              <input
                id="board-search"
                type="text"
                className={styles.search}
                placeholder="Search subcategories — amplifiers, sensors, connectors…"
                value={query}
                onChange={e => {
                  setQuery(e.target.value);
                  setShowAll(false);
                }}
              />
              {shown.length === 0 ? (
                <p className={styles.pickerNote}>
                  No open board matches “{query}”.{" "}
                  <a href={`mailto:${REPS[1].email}`}>Ask the desk</a>.
                </p>
              ) : (
                <ul className={styles.boardList}>
                  {shown.map(b => (
                    <li key={b.category_id}>
                      <button
                        type="button"
                        className={styles.board}
                        onClick={() => navigate(`${b.path}?sponsor=1`)}
                      >
                        <span className={styles.boardName}>
                          {b.name}
                          <small>{b.parent_name}</small>
                        </span>
                        <span className={styles.boardSlots}>
                          {b.open_slots} of {b.total_slots} slots open
                        </span>
                        <span className={styles.boardGo} aria-hidden="true">
                          Sponsor →
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {!showAll && matches.length > shown.length && (
                <button
                  type="button"
                  className={styles.moreBtn}
                  onClick={() => setShowAll(true)}
                >
                  Show all {matches.length} boards
                </button>
              )}
            </div>
          )}
        </section>

        {/* Gold and Platinum — exclusives, and exclusives are arranged, not
            self-served: one slot cannot be sold to two people at once. */}
        <section className={styles.exclusives}>
          <h2 className={styles.sectionTitle}>Exclusive placements</h2>
          <p className={styles.sectionLine}>
            One sponsor at a time, so these are arranged with the partners desk —
            they check the slot is open, then send a quote you can pay online.
          </p>
          <div className={styles.tierGrid}>
            {EXCLUSIVE_TIERS.map(t => (
              <div key={t.id} className={styles.tierCard} data-tier={t.id}>
                <span className={styles.kicker}>{t.kicker}</span>
                <h3 className={styles.tierName}>{t.name}</h3>
                <div className={styles.priceBlock}>
                  <span className={styles.price}>{t.price}</span>
                  <span className={styles.per}>/mo — tax included</span>
                </div>
                <p className={styles.tierLine}>{t.line}</p>
                <ul className={styles.perks}>
                  {t.perks.map(p => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <a className={styles.tierCta} href={`mailto:${REPS[1].email}`}>
                  Ask about {t.name} →
                </a>
              </div>
            ))}
          </div>
        </section>

        {/* The desk — a peer section, because a named human is the difference
            between a price list and an offer. */}
        <section className={styles.desk}>
          <div className={styles.deskHead}>
            <span className={styles.deskDes}>Q1–Q3 · PARTNERS DESK</span>
            <h2 className={styles.sectionTitle}>Talk to a person</h2>
            <p className={styles.sectionLine}>
              Same price either way. The desk answers same-day, Mon–Fri 9a–5p ET, and
              handles every Gold and Platinum placement.
            </p>
          </div>
          <ul className={styles.repList}>
            {REPS.map(r => (
              <li key={r.des} className={styles.rep}>
                <span className={styles.repAva} aria-hidden="true">
                  {r.name.charAt(0)}
                </span>
                <span className={styles.repId}>
                  <span className={styles.repDes}>{r.des}</span>
                  <b>{r.name}</b>
                </span>
                <a className={styles.repMail} href={`mailto:${r.email}`}>
                  Email
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.keywordCard}>
          <div>
            <h2 className={styles.sectionTitle}>Sponsoring a search term instead?</h2>
            <p className={styles.sectionLine}>
              Keyword sponsorships own the phrase your buyers type — priced and
              arranged separately from board placements.
            </p>
          </div>
          <Link to="/keyword" className={styles.keywordCta}>
            See keyword sponsorship →
          </Link>
        </section>
      </div>
    </motion.div>
  );
}
