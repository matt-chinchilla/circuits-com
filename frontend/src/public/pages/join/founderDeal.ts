/** The Founder's Deal, as the site displays it. Charged by the server's
 *  sales_pricing.FOUNDER_USD; api/tests/test_sales_pricing.py pins these
 *  three strings to it (test_founder_literals_match_the_join_page). */
export const FOUNDER_DEAL_USD = {
  silver: '$210',
  gold: '$2,100',
  platinum: '$8,500',
} as const;
