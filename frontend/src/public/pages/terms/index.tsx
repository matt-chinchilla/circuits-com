import LegalDoc, { type LegalSection } from "@public/components/legal/LegalDoc";
import { STATIC_PAGE_SEO } from "@public/services/seoRoutes";
import {
  CONTACT_EMAILS,
  DOC_DATES,
  DOC_VERSIONS,
  LEGAL_ENTITY,
  noticeClause,
} from "@public/services/businessInfo";

/**
 * Terms of Service.
 *
 * Until 2026-08-05 the /terms route rendered the privacy policy, so the site
 * had no terms at all while the footer advertised them. This is the real
 * document.
 *
 * Two clauses here are load-bearing beyond the usual boilerplate:
 *
 *   Section 05 states that a Sponsorship is billed as TWO separately stated
 *   charges — advertising placement and platform access. That is not a
 *   formatting preference. New York applies a primary-purpose test to mixed
 *   transactions, and a single undifferentiated charge covering taxable
 *   software plus non-taxable advertising can be taxed in full as prewritten
 *   software. Contract language is substantial evidence in that analysis, so
 *   the split has to be stated in the agreement, not only on the invoice.
 *
 *   Section 04 states that Platinum and Gold placements are exclusive. That is
 *   the contractual half of a constraint the database already enforces
 *   (uq_active_platinum_per_category, uq_active_gold_per_category). If the two
 *   ever disagree, one of them is a promise the system cannot keep.
 *
 * Not legal advice, and not a substitute for review by counsel — these are
 * drafted to be reviewed, not to be filed.
 */

const E = LEGAL_ENTITY;

const SECTIONS: LegalSection[] = [
  {
    id: "agreement",
    num: "01",
    title: "This Agreement",
    body: [
      `These Terms of Service ("Terms") govern your use of ${E.site} and any service operated by ${E.legalName}, a ${E.entityType} organized under the laws of ${E.jurisdiction} ("we", "us", "our").`,
      'By browsing the site, creating an account, or purchasing a sponsorship, you agree to these Terms. If you are agreeing on behalf of a company, you represent that you have authority to bind it, and "you" means that company.',
      "If you do not agree, do not use the service.",
    ],
  },
  {
    id: "service",
    num: "02",
    title: "What We Provide",
    body: [
      "Circuit Center is a directory of electronic components. We aggregate part information, categorize it, and link out to the distributors who actually sell it. We are not a distributor. We do not hold inventory, take orders, process purchases of components, or ship anything.",
      "When you follow a link to a distributor, you leave our site and transact entirely under that distributor's terms. Any purchase, price, warranty, return, or delivery obligation is between you and them.",
    ],
  },
  {
    id: "data",
    num: "03",
    title: "Directory Data and Accuracy",
    body: [
      "Part specifications, stock levels, pricing, and lead times shown in the directory are compiled from manufacturer and distributor sources and from our own catalog records. They are provided for reference and comparison only.",
      "We do not warrant that any price, stock figure, specification, or lead time displayed here is current, complete, or correct. Values shown may be stale, approximate, or superseded without notice.",
      "Always confirm price and availability with the distributor before you rely on it for a purchase, a quotation, or a design decision. The distributor's own listing governs.",
    ],
  },
  {
    id: "placements",
    num: "04",
    title: "Sponsorship Placements",
    body: [
      'A "Sponsorship" is the right to display your brand in a defined position on the site for a defined term, at the tier set out in your order form or quote.',
      "Platinum and Gold placements are exclusive. While your Sponsorship is active, no other advertiser holds the same placement. Silver placements and keyword placements are shared: more than one advertiser may appear in the same directory or against the same term.",
      "Placement position, layout, and surrounding site design are ours to determine and may change as the site evolves. We will not materially reduce the prominence of a paid placement during its term without offering you a comparable position or a pro-rata credit.",
      "We do not guarantee any level of traffic, impressions, clicks, enquiries, or sales. Advertising performance depends on factors outside our control, and nothing in these Terms is a representation about results.",
      "We may decline or remove any placement that breaches our Acceptable Use Policy. Where we remove a placement for that reason, no refund is due.",
    ],
  },
  {
    id: "fees",
    num: "05",
    title: "Fees, Billing, and Tax",
    body: [
      "Fees are those set out in your order form or quote, billed in advance for each billing period in the currency stated. Published list prices may change; a change does not affect the price of a Sponsorship already in its term.",
      "Fees for a Sponsorship comprise two separately stated components: (a) an Advertising Placement charge, for display of your brand in the position purchased; and (b) a Platform Access charge, for access to the advertiser dashboard, reporting, and analytics tools that accompany your tier. These components are priced, invoiced, and taxed separately, and the allocation between them is stated on your order form and on every invoice.",
      "Fees are exclusive of sales, use, value-added, and similar taxes. Where we are registered to collect tax in your jurisdiction, tax is calculated per line item and added to your invoice. Where you are exempt, you must supply a valid exemption or resale certificate before the invoice is issued; we cannot credit tax already remitted.",
      "You authorize us to charge the payment method on file for each renewal. If you pay by bank debit, you authorize the debit under the mandate you accept at signup and you are responsible for keeping that mandate valid.",
      `Invoices are due on the terms stated. Questions about a charge go to ${CONTACT_EMAILS.billing}; raise them within thirty days of the invoice date.`,
    ],
  },
  {
    id: "term",
    num: "06",
    title: "Term, Renewal, and Cancellation",
    body: [
      "Unless your order form says otherwise, a Sponsorship runs month to month and renews automatically at the end of each billing period.",
      "You may cancel at any time. Cancellation takes effect at the end of the billing period you have already paid for — your placement runs to the end of that period and is then removed, and you are not billed again.",
      "We may cancel a Sponsorship on thirty days' written notice. If we do, we refund the unused portion of any period you have prepaid.",
    ],
  },
  {
    id: "refunds",
    num: "07",
    title: "Refunds",
    body: [
      "Fees are non-refundable. We do not prorate a partial period on cancellation, and we do not refund a period that has begun.",
      "This is deliberate rather than incidental: exclusive placements are inventory, and a slot held for you is a slot nobody else could buy.",
      "The exception is a cancellation by us under section 06, where we refund the unused prepaid portion. Nothing here limits a right you have under applicable law that cannot be waived by agreement.",
    ],
  },
  {
    id: "nonpayment",
    num: "08",
    title: "Failed Payment and Suspension",
    body: [
      "If a payment fails we will retry it and notify you. Your placement remains live during that period.",
      "If the invoice remains unpaid fourteen days after its due date, we may suspend the placement. If it remains unpaid thirty days after its due date, we may terminate the Sponsorship and release the placement — including an exclusive one — for sale to another advertiser.",
      "Releasing an exclusive placement is not reversible by paying afterwards. If the slot has been sold, we cannot take it back from the new advertiser, and the amount you owe for the period already served remains due.",
    ],
  },
  {
    id: "content",
    num: "09",
    title: "Your Content and Conduct",
    body: [
      "You keep ownership of the logos, marks, copy, and links you supply. You grant us a non-exclusive, worldwide, royalty-free licence to host, reproduce, resize, and display them for the purpose of running your placement, for as long as the Sponsorship is active.",
      "You represent that you own or are licensed to use everything you supply, and that displaying it does not infringe anyone's rights or breach any law.",
      "All advertiser content is subject to our Acceptable Use Policy, which is incorporated into these Terms. It governs what may be advertised, what claims may be made, and what we will remove.",
      "You may not scrape, crawl at abusive rates, resell, or bulk-redistribute the directory; interfere with the service or its security; or misrepresent your identity or affiliation.",
    ],
  },
  {
    id: "accounts",
    num: "10",
    title: "Accounts",
    body: [
      "Some features require an account. You are responsible for the accuracy of your account details, for keeping credentials confidential, and for everything done under your account.",
      "Tell us promptly at " + CONTACT_EMAILS.general + " if you believe an account has been compromised.",
    ],
  },
  {
    id: "ip",
    num: "11",
    title: "Intellectual Property",
    body: [
      `The site, its design, its software, and its compiled directory are owned by ${E.legalName} and protected by intellectual property law. These Terms grant you no rights in them beyond use of the service as intended.`,
      "Manufacturer names, part numbers, logos, and trademarks shown in the directory belong to their respective owners and appear solely for identification and reference. Their appearance does not imply endorsement, sponsorship, or affiliation.",
    ],
  },
  {
    id: "warranty",
    num: "12",
    title: "Disclaimers",
    body: [
      'The service is provided "as is" and "as available". To the fullest extent permitted by law we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose, non-infringement, and any warranty arising from course of dealing or usage of trade.',
      "We do not warrant that the service will be uninterrupted, timely, secure, or error-free, or that any defect will be corrected.",
      "We are not responsible for the content, products, prices, or conduct of any distributor, manufacturer, or advertiser whose material appears on or is linked from the site.",
    ],
  },
  {
    id: "liability",
    num: "13",
    title: "Limitation of Liability",
    body: [
      "To the fullest extent permitted by law, neither party is liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost profits, lost revenue, lost data, or business interruption, however caused and on any theory of liability.",
      "Our total aggregate liability arising out of or relating to these Terms or the service is limited to the amounts you paid us in the twelve months immediately before the event giving rise to the claim.",
      "These limits do not apply to liability that cannot be limited by law, including fraud or wilful misconduct.",
    ],
  },
  {
    id: "indemnity",
    num: "14",
    title: "Indemnification",
    body: [
      "You will defend, indemnify, and hold us harmless against any third-party claim arising from the content you supply, your breach of these Terms or the Acceptable Use Policy, or your infringement of any third-party right — including reasonable legal fees. We will notify you promptly of any such claim and give you reasonable control of the defence.",
    ],
  },
  {
    id: "changes",
    num: "15",
    title: "Changes to These Terms",
    body: [
      'We may update these Terms. When we do we revise the "Effective" date above, and for material changes we give at least thirty days\' notice by email to account holders and active sponsors before the change takes effect.',
      "A material change takes effect for an active Sponsorship at its next renewal, not mid-term. Continuing to use the service after a change takes effect constitutes acceptance.",
    ],
  },
  {
    id: "law",
    num: "16",
    title: "Governing Law and Disputes",
    body: [
      `These Terms are governed by the laws of ${E.jurisdiction}, without regard to its conflict-of-laws rules.`,
      `The state and federal courts located in ${E.venue} have exclusive jurisdiction over any dispute arising out of or relating to these Terms, and both parties consent to that venue.`,
      "Before filing, please contact us — most disputes about a placement or an invoice are resolved faster by email than by motion.",
    ],
  },
  {
    id: "misc",
    num: "17",
    title: "General",
    body: [
      "These Terms, together with the Acceptable Use Policy, the Privacy Policy, and your order form, are the entire agreement between us on their subject matter and supersede any prior discussion. Where an order form conflicts with these Terms, the order form governs for that Sponsorship.",
      "If any provision is held unenforceable, the rest remains in force. A failure to enforce a provision is not a waiver of it. You may not assign these Terms without our written consent; we may assign them to a successor in connection with a merger, acquisition, or sale of assets.",
      "Neither party is liable for a delay or failure caused by events beyond its reasonable control.",
      noticeClause(CONTACT_EMAILS.legal),
    ],
  },
];

export default function TermsPage() {
  return (
    <LegalDoc
      seo={STATIC_PAGE_SEO.terms}
      page="terms"
      title="Terms of Service"
      kicker="The agreement, in plain English"
      lede="We run a parts directory and sell advertising placements on it. This document sets out what you get when you buy one, what it costs, how to stop, and what we are and are not responsible for."
      effectiveDate={DOC_DATES.terms}
      version={DOC_VERSIONS.terms}
      owner={CONTACT_EMAILS.legal}
      idPrefix="terms"
      sections={SECTIONS}
      signedBy="M. Chirichella"
    />
  );
}
