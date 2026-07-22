// PLACEHOLDER COPY — tier prices and FAQ Q&A are pending product/sales sign-off.
// Per the keyword-sponsorship design brief (docs/design-briefs/keyword-sponsorship-landing.md).
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
    price: '$99/mo',
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
    price: '$299/mo',
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
    price: '$899/mo',
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
