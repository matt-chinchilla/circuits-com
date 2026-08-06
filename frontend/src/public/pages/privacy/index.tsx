import LegalDoc, {
  type LegalAppendix,
  type LegalSection,
} from "@public/components/legal/LegalDoc";
import { STATIC_PAGE_SEO } from "@public/services/seoRoutes";
import {
  CONTACT_EMAILS,
  DOC_DATES,
  DOC_VERSIONS,
  noticeClause,
} from "@public/services/businessInfo";

// Privacy Policy — content ported from the 2026-05-12 Claude Design bundle.
//
// The page chrome (contents rail, scroll-spy, sign-off) moved to
// @public/components/legal/LegalDoc when Terms and Acceptable Use arrived;
// this file is now the policy text and nothing else. Rendering is unchanged.
//
// Two corrections landed with that move, both in section 12:
//
//   The postal address was "1 Industry Park Way, Brookhaven, NY 11719" — a
//   placeholder from the design mockup, published in the notice clause of a
//   live policy. It now comes from businessInfo, which returns null until a
//   real address exists, and noticeClause() omits the postal route entirely
//   rather than printing somewhere nobody can be reached.
//
//   The effective date was formatted from `new Date()`, so the policy claimed
//   to take effect on whatever day you loaded it, and the prerendered copy
//   froze the last build date. It is now pinned in DOC_DATES.

const SECTIONS: LegalSection[] = [
  {
    id: "scope",
    num: "01",
    title: "Scope",
    body: [
      'This Privacy Policy describes how Circuit Center ("we", "us", "our") collects, uses, and shares information when you visit circuitcenter.ai or use any service we operate (collectively, the "Service").',
      "By using the Service you agree to the practices described here. If you do not agree, please do not use the Service.",
    ],
  },
  {
    id: "collect",
    num: "02",
    title: "Information We Collect",
    body: [
      "Information you provide directly. When you contact us, request a listing, or sign in as a distributor, we collect the name, email address, phone number, company name, and any other content you submit.",
      "Information collected automatically. Like most websites, our servers automatically log your IP address, browser type, referring page, pages viewed, and timestamps. We use first-party cookies and similar technologies to remember preferences (such as your theme selection) and to measure aggregate site usage.",
      "Information from third parties. Distributor stock and pricing data displayed in our directory is provided by manufacturers and authorized distributors. We do not collect personal information about you from those parties.",
    ],
  },
  {
    id: "use",
    num: "03",
    title: "How We Use Information",
    body: [
      "We use the information we collect to operate, maintain, and improve the Service; to respond to your inquiries; to verify distributor listings; to detect, prevent, and address abuse, fraud, or technical problems; and to comply with applicable laws.",
      "We do not sell personal information. We do not use buyer or visitor data to build advertising profiles.",
    ],
  },
  {
    id: "share",
    num: "04",
    title: "How We Share Information",
    body: [
      "Service providers. We share information with vendors who help us operate the Service (e.g. hosting, analytics, email delivery, payment processing). These providers are contractually limited to processing data on our behalf.",
      "Distributors. When you click a buy-link, you leave Circuit Center and enter the distributor's own website under their terms and privacy policy. We do not transmit your identity to the distributor unless you tell them yourself by signing in there.",
      "Advertisers. Sponsors receive aggregate performance reporting about their own placements. They do not receive the identity of any visitor.",
      "Legal. We may disclose information when we believe in good faith that disclosure is required by law, court order, or to protect the rights, property, or safety of any person.",
      "Business transfers. If Circuit Center is involved in a merger, acquisition, or sale of assets, information may be transferred as part of that transaction.",
    ],
  },
  {
    id: "cookies",
    num: "05",
    title: "Cookies & Tracking",
    body: [
      "We use a small number of first-party cookies and localStorage entries to keep the Service usable — for example, remembering which theme you selected or which page you last viewed.",
      "We do not use third-party advertising trackers. You can disable cookies in your browser; some features (such as remembering preferences across sessions) will not work without them.",
    ],
  },
  {
    id: "retention",
    num: "06",
    title: "Data Retention",
    body: [
      "We retain personal information only for as long as needed to fulfill the purposes described in this Policy, to comply with our legal obligations, to resolve disputes, and to enforce our agreements. When information is no longer needed, we delete or anonymize it.",
    ],
  },
  {
    id: "rights",
    num: "07",
    title: "Your Rights",
    body: [
      "Depending on where you live (including residents of the EEA, the United Kingdom, and California), you may have the right to access, correct, delete, or port your personal information; to object to or restrict certain processing; and to withdraw consent where we rely on it.",
      `To exercise any of these rights, email ${CONTACT_EMAILS.privacy} from the address associated with your information. We will respond within the timeframe required by applicable law.`,
    ],
  },
  {
    id: "security",
    num: "08",
    title: "Security",
    body: [
      "We use commercially reasonable administrative, technical, and physical safeguards designed to protect the information we hold. No method of transmission or storage is 100% secure, however, and we cannot guarantee absolute security.",
    ],
  },
  {
    id: "children",
    num: "09",
    title: "Children's Privacy",
    body: [
      `The Service is intended for engineering and purchasing professionals and is not directed to children under 13. We do not knowingly collect personal information from children under 13. If you believe a child has provided us with personal information, please contact ${CONTACT_EMAILS.privacy} and we will delete it.`,
    ],
  },
  {
    id: "intl",
    num: "10",
    title: "International Transfers",
    body: [
      "Circuit Center is operated from the United States. If you access the Service from outside the United States, your information may be transferred to, stored in, and processed in the United States or other countries with different data protection laws than your jurisdiction.",
    ],
  },
  {
    id: "changes",
    num: "11",
    title: "Changes to This Policy",
    body: [
      'We may update this Policy from time to time. When we do, we will revise the "Effective" date at the top of the page and, for material changes, provide a more prominent notice. Your continued use of the Service after a change takes effect constitutes acceptance of the updated Policy.',
    ],
  },
  {
    id: "contact",
    num: "12",
    title: "Contact Us",
    body: [
      `Questions, requests, or complaints regarding this Policy may be sent to ${CONTACT_EMAILS.privacy}. ${noticeClause(CONTACT_EMAILS.privacy)}`,
    ],
  },
];

const APPENDIX: LegalAppendix = {
  title: "Appendix · Licenses",
  intro:
    "The following generic licenses govern the content displayed on circuitcenter.ai. They are provided for reference and do not modify any agreement you have entered into separately with us.",
  cards: [
    {
      tag: "MIT-style",
      name: "Site Content License",
      body: 'Copyright (c) 2003–2026 Circuit Center. Permission is hereby granted, free of charge, to any person obtaining a copy of the publicly displayed directory pages of circuitcenter.ai ("the Content"), to use, copy, reference, and link to the Content for personal, educational, or internal engineering use, subject to the following conditions: the above copyright notice and this permission notice shall be included in all substantial reproductions; bulk scraping, automated re-distribution, or resale of the Content is prohibited without written consent. THE CONTENT IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.',
    },
    {
      tag: "Trademarks",
      name: "Third-Party Marks",
      body: "All manufacturer names, part numbers, logos, and trademarks displayed on circuitcenter.ai are the property of their respective owners and are used here solely for identification and reference purposes. Their appearance on this site does not imply endorsement, sponsorship, or affiliation.",
    },
    {
      tag: "Datasheets",
      name: "Distributor Data",
      body: "Stock levels, pricing, and lead-time information are aggregated under license from participating authorized distributors and are subject to their own terms of use. Circuit Center makes no warranty as to the accuracy or timeliness of any third-party data displayed.",
    },
  ],
};

export default function PrivacyPage() {
  return (
    <LegalDoc
      seo={STATIC_PAGE_SEO.privacy}
      page="privacy"
      title="Privacy Policy"
      kicker="The plain-English version"
      lede="We run a parts directory, not a profiling business. This document explains, in plain English, what we collect, why, and how to reach us about it."
      effectiveDate={DOC_DATES.privacy}
      version={DOC_VERSIONS.privacy}
      owner={CONTACT_EMAILS.privacy}
      idPrefix="privacy"
      sections={SECTIONS}
      appendix={APPENDIX}
      signedBy="M. Chirichella"
    />
  );
}
