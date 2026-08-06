// Tier list prices, set 2026-08-05: Silver 200, Gold 600, Platinum 2400 per
// month. These supersede the design-brief placeholders (99/299/899) and stand
// until deal data says otherwise.
//
// They are LIST prices, and the distinction matters operationally: negotiated
// deals are closed by applying a discount to these, never by minting a bespoke
// price per customer. That keeps reporting able to show list-versus-realized
// across deals — which is how the real clearing price gets discovered — and it
// means raising list later doesn't touch anyone already subscribed.
//
// PRICING_NOTE below is not marketing copy. New York applies a primary-purpose
// test to mixed transactions, and a single undifferentiated monthly charge
// covering advertising plus reporting tools can be assessed in full as
// prewritten software. Published website language is substantial evidence in
// that analysis, so the two components have to be visibly separate here, not
// only on the invoice. Don't collapse it back into one number.
//
// FAQ Q&A is still pending product/sales sign-off.
// Update via this file only; pages/components consume from here.

export interface SponsorTier {
  id: 'silver' | 'gold' | 'platinum';
  name: string;
  price: string;
  tag: string;
  featured?: boolean;
  perks: string[];
}

export interface SponsorFAQItem {
  q: string;
  a: string;
}

export interface HowStep {
  num: string;
  title: string;
  desc: string;
}

export const SPONSOR_TIERS: readonly SponsorTier[] = [
  {
    id: 'silver',
    name: 'Silver',
    price: '$200/mo',
    tag: 'Solo keyword',
    perks: [
      '1 keyword exclusive',
      'Full landing card',
      'Email lead forwarding',
      'Quarterly traffic report',
    ],
  },
  {
    id: 'gold',
    name: 'Gold',
    price: '$600/mo',
    tag: 'Most chosen',
    featured: true,
    perks: [
      '3 keywords exclusive',
      'Featured on /search empty-state',
      'Monthly traffic + lead report',
      'Co-branded landing card',
      'Inbound lead form',
    ],
  },
  {
    id: 'platinum',
    name: 'Platinum',
    price: '$2,400/mo',
    tag: 'Category cap',
    perks: [
      '10 keywords + category lock',
      'Top-of-page sponsor block site-wide',
      'Dedicated account manager',
      'Weekly analytics + Slack channel',
      'API webhook for new leads',
    ],
  },
] as const;

/**
 * Shown beneath the tier grid. Says three true things the prices alone don't:
 * that the figure is a starting point rather than a rate card, that it splits
 * into two separately taxed charges, and that tax is added rather than
 * included. See the tax note at the top of this file.
 */
export const PRICING_NOTE =
  'Prices are per month, exclusive of tax. Each sponsorship is billed as two separately stated charges — advertising placement and platform access — itemized on every invoice. Annual terms and multi-placement packages are quoted individually.';

export const SPONSOR_FAQS: readonly SponsorFAQItem[] = [
  {
    q: 'How exclusive is a sponsored keyword?',
    a: 'One sponsor per keyword. While your contract is active, no one else can claim the same term. Close variants (plurals, hyphens, spacing) bundle into the primary contract at no extra cost.',
  },
  {
    q: 'What if my keyword has multiple variants?',
    a: 'Tell us the canonical form. We map plurals, hyphens, common abbreviations, and the bare-acronym version automatically (e.g. claiming "mlcc" covers "MLCCs" and "multilayer ceramic capacitor").',
  },
  {
    q: 'How long is the commitment?',
    a: "Month-to-month. Cancel any time before the next billing cycle and your card stays live through the period you've paid for.",
  },
  {
    q: 'Can I see traffic stats for a keyword before I buy?',
    a: "Yes. Drop us a line at sales@circuitcenter.ai with the keyword and we'll send last-90-days impressions and click-through. No login required to inspect the existing public landing page if one is already live.",
  },
  {
    q: "What's the difference between keyword and category sponsorship?",
    a: 'Category sponsorship pins your block at the top of an entire taxonomy page ("Power Management ICs"). Keyword sponsorship owns a specific search term. Most distributors run both — broad reach plus targeted intent.',
  },
] as const;

export const HOW_STEPS: readonly HowStep[] = [
  {
    num: '01',
    title: 'Pick a keyword',
    desc: "Type the term your buyers actually search. We'll tell you on the spot if it's available.",
  },
  {
    num: '02',
    title: 'Choose a tier',
    desc: 'Silver, Gold, or Platinum — month-to-month, cancel any time before the next cycle.',
  },
  {
    num: '03',
    title: 'Go live in 48h',
    desc: 'Send us your logo, one paragraph, and a buy-link. We publish your sponsor card within two business days.',
  },
] as const;
