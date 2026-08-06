import LegalDoc, { type LegalSection } from "@public/components/legal/LegalDoc";
import { STATIC_PAGE_SEO } from "@public/services/seoRoutes";
import {
  CONTACT_EMAILS,
  DOC_DATES,
  DOC_VERSIONS,
  LEGAL_ENTITY,
} from "@public/services/businessInfo";

/**
 * Acceptable Use Policy — what may be advertised here.
 *
 * Required for payment-processor underwriting: once we sell placements, our
 * risk includes our advertisers' content, and processors review merchants on
 * what appears downstream of them. A published, enforced policy excluding the
 * restricted verticals is the thing they look for.
 *
 * Section 04 (counterfeit and grey-market parts) is the one that is ours
 * rather than boilerplate. A components directory sells trust in a supply
 * chain; an advertiser moving counterfeit or unauthorized stock through a
 * placement here damages the only asset the directory has.
 */

const E = LEGAL_ENTITY;

const SECTIONS: LegalSection[] = [
  {
    id: "scope",
    num: "01",
    title: "Scope",
    body: [
      `This Acceptable Use Policy governs everything an advertiser displays on ${E.site} — logos, marks, copy, images, links, and the pages those links lead to. It is incorporated into the Terms of Service, and breaching it breaches them.`,
      "It applies to every tier and every placement, including keyword and part-level sponsorships.",
    ],
  },
  {
    id: "who",
    num: "02",
    title: "Who May Advertise",
    body: [
      "Placements are for businesses that manufacture, distribute, or provide services to the electronic components industry, and for related engineering tooling and services.",
      "You must be a legally registered business, able to enter a binding contract, and accurately represented in what you tell us. Placements are not sold to individuals advertising personal sales.",
    ],
  },
  {
    id: "prohibited",
    num: "03",
    title: "Prohibited Content",
    body: [
      "We do not accept placements for, or links to, any of the following. The list is not exhaustive — we may decline anything we judge to fall within its spirit.",
    ],
    bullets: [
      "Anything unlawful in the jurisdictions where it would be displayed, or that facilitates unlawful activity",
      "Counterfeit, cloned, relabelled, or misrepresented goods of any kind",
      "Adult or sexually explicit material",
      "Gambling, betting, lotteries, and games of chance played for money",
      "Cannabis, CBD, tobacco, nicotine, vaping products, and drug paraphernalia",
      "Weapons, ammunition, explosives, and their components",
      "Credit repair, debt settlement, debt collection, and payday or high-cost consumer lending",
      "Cryptocurrency investment schemes, token sales, and any get-rich-quick or guaranteed-return offer",
      "Multi-level marketing, pyramid schemes, and chain referral programmes",
      "Pharmaceuticals, supplements, and medical devices marketed with health claims",
      "Malware, spyware, credential harvesting, DDoS-for-hire, and services marketed for unauthorized access",
      "Devices whose primary purpose is to defeat access controls, telemetry, emissions testing, or copy protection",
      "Content that harasses, defames, or promotes hatred or violence against any person or group",
      "Deliberately deceptive creative — fake system alerts, fake close controls, or anything designed to be mistaken for site navigation",
    ],
  },
  {
    id: "counterfeit",
    num: "04",
    title: "Authentic Parts and Supply-Chain Integrity",
    body: [
      "This directory exists so that engineers can trust what they find in it. Counterfeit and misrepresented components are the industry's most expensive failure mode, and a placement here must not contribute to it.",
      "If you advertise as an authorized distributor or franchised source, you must actually hold that authorization for the lines you promote, and you must be able to evidence it on request.",
      "If you sell independently or from the open market, you must not describe yourself in terms that imply authorization you do not hold. Independent distribution is legitimate; misrepresenting it is not.",
      "You must not advertise parts that are counterfeit, cloned, remarked, salvaged and sold as new, or knowingly out of specification. A credible report that you have done so is grounds for immediate removal without refund.",
    ],
  },
  {
    id: "claims",
    num: "05",
    title: "Claims and Representations",
    body: [
      "Claims about stock, price, lead time, certification, and compliance must be accurate at the time you supply them and must be substantiable.",
      'Comparative claims must be fair and verifiable. Superlatives that cannot be evidenced ("the lowest prices anywhere") do not belong in a placement.',
      "Do not state or imply that Circuit Center endorses, certifies, tests, or recommends you. A paid placement is advertising, and we describe it as such.",
      "Where a claim depends on certification — ISO, AS6081, ITAR registration, RoHS or REACH conformity — name the standard and be prepared to produce the certificate.",
    ],
  },
  {
    id: "creative",
    num: "06",
    title: "Creative Standards",
    body: [
      "Supply a logo you own or are licensed to use. It will be displayed at the size and crop the placement calls for; supply a square image where a square is requested rather than relying on us to crop a wordmark.",
      "No animation, no audio, no auto-playing media, and no scripts. Placements are static images, text, and a link.",
      "Creative must be legible and must not imitate site chrome, error messages, or interface controls.",
    ],
  },
  {
    id: "links",
    num: "07",
    title: "Links and Destinations",
    body: [
      "A placement links to a working page you control, over HTTPS, that is plainly related to what the placement advertises.",
      "The destination is subject to this Policy in the same way the creative is. A compliant advertisement pointing at a non-compliant page is a breach.",
      "No redirect chains through third-party trackers, no cloaking or serving different content to us than to visitors, and no downloads triggered on arrival.",
    ],
  },
  {
    id: "privacy",
    num: "08",
    title: "Data and Privacy",
    body: [
      "Placements carry no third-party advertising trackers, pixels, fingerprinting, or cross-site identifiers. Reporting comes from our own first-party measurement.",
      "Any personal data you collect from visitors who follow your link is collected by you, under your own privacy policy and your own legal basis. We do not transfer visitor identities to advertisers.",
    ],
  },
  {
    id: "enforcement",
    num: "09",
    title: "Reporting and Enforcement",
    body: [
      `Report a placement you believe breaches this Policy to ${CONTACT_EMAILS.abuse}. Include the page, the advertiser, and what you think is wrong. We review every report.`,
      "Where a breach is ambiguous or minor, we will normally ask you to correct it and give a reasonable period to do so. Where content is unlawful, deceptive, or involves misrepresented parts, we remove it immediately and tell you afterwards.",
      "Removal for a breach does not entitle you to a refund, and repeated breaches are grounds for terminating the Sponsorship.",
      "We may also decline a placement before it runs. We are not obliged to explain a declined placement beyond identifying the section it falls under.",
    ],
  },
  {
    id: "changes",
    num: "10",
    title: "Changes to This Policy",
    body: [
      'We may update this Policy as the advertising on the site grows. When we do we revise the "Effective" date above, and we notify active sponsors by email before a change that would require them to alter live creative.',
    ],
  },
];

export default function AcceptableUsePage() {
  return (
    <LegalDoc
      seo={STATIC_PAGE_SEO.acceptableUse}
      page="acceptable-use"
      title="Acceptable Use Policy"
      kicker="What may be advertised here"
      lede="Engineers use this directory because they trust what is in it. This document sets out what we will and will not carry as advertising, and what happens when a placement crosses the line."
      effectiveDate={DOC_DATES.acceptableUse}
      version={DOC_VERSIONS.acceptableUse}
      owner={CONTACT_EMAILS.abuse}
      idPrefix="aup"
      sections={SECTIONS}
      signedBy="M. Chirichella"
    />
  );
}
