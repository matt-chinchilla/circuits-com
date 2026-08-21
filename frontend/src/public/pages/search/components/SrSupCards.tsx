// Manufacturer/distributor result cards + the empty-state distributor tile —
// ported from the design kit's SrSupCard/SrSupTile (Search.jsx + sponsor.css
// .sr-sup*/.sr-suptile*/.sr-pad/.sr-tier).
//
// Both render as internal <Link>s: distributor surfaces route to /join (spec
// Decisions — never an external site), manufacturer cards re-run the search.
// Logos go through safeImageUrl and fall back to the lettermark pad on null
// OR onError (the CsLogo/SbLogo pattern). The suptile meta line is website
// ONLY — a phone number never renders on a public surface (owner rule
// 2026-08-15), and a missing website is an em dash, not a dangling separator.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { safeImageUrl } from '@shared/utils/url';
import { displayWebsite, srInitials } from '../lib/srFormat';
import styles from './SrSupCards.module.scss';

const TIER_VARIANT: Record<string, string> = {
  featured: styles.tierFeatured,
  gold: styles.tierGold,
  platinum: styles.tierPlatinum,
  silver: styles.tierSilver,
};

function tierClass(tier: string): string {
  const variant = TIER_VARIANT[tier.trim().toLowerCase()];
  return variant ? `${styles.tier} ${variant}` : styles.tier;
}

// 46px logo pad: real logo when one survives safeImageUrl and actually loads,
// lettermark otherwise.
function SrPad({ name, logoUrl }: { name: string; logoUrl?: string | null }) {
  const [failed, setFailed] = useState(false);
  const src = safeImageUrl(logoUrl);
  return (
    <span className={styles.pad} aria-hidden="true">
      {src != null && !failed ? (
        <img src={src} alt="" onError={() => setFailed(true)} />
      ) : (
        srInitials(name)
      )}
    </span>
  );
}

interface SrSupCardProps {
  name: string;
  /** Pre-composed one-line description (may be empty — line then collapses). */
  desc: string;
  /** Lowercase-or-null server tier; null renders no badge. */
  tier?: string | null;
  /** Fixed badge text (e.g. "MFR") — takes precedence over `tier`. */
  badge?: string;
  logoUrl?: string | null;
  to: string;
}

export function SrSupCard({ name, desc, tier, badge, logoUrl, to }: SrSupCardProps) {
  return (
    <Link to={to} className={styles.sup}>
      <SrPad name={name} logoUrl={logoUrl} />
      <span className={styles.supMain}>
        <span className={styles.supName}>{name}</span>
        {desc !== '' && <span className={styles.supDesc}>{desc}</span>}
      </span>
      {badge != null ? (
        <span className={styles.tier}>{badge}</span>
      ) : tier != null && tier !== '' ? (
        <span className={tierClass(tier)}>{tier}</span>
      ) : null}
    </Link>
  );
}

interface SrSupTileProps {
  name: string;
  description: string | null;
  website: string | null;
  tier?: string | null;
  logoUrl?: string | null;
  to: string;
}

export function SrSupTile({ name, description, website, tier, logoUrl, to }: SrSupTileProps) {
  return (
    <Link to={to} className={styles.suptile}>
      <span className={styles.suptileHead}>
        <SrPad name={name} logoUrl={logoUrl} />
        <span className={styles.suptileHb}>
          <span className={styles.supName}>{name}</span>
          {tier != null && tier !== '' && <span className={tierClass(tier)}>{tier}</span>}
        </span>
      </span>
      {description != null && description !== '' && (
        <span className={styles.suptileDesc}>{description}</span>
      )}
      <span className={styles.suptileMeta}>{displayWebsite(website) ?? '\u2014'}</span>
    </Link>
  );
}
