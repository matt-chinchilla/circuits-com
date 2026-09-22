/**
 * True only for a DEFINITIVE "this does not exist" from the API — an HTTP 404.
 *
 * It decides whether a page renders the not-found head (`noindex`). A network
 * failure has no response, and a 5xx is the server's problem rather than the
 * URL's (a deploy recreates the api container for ~1-2 minutes): marking either
 * noindex would drop a real page from the index because a crawler visited at
 * the wrong moment. Structural rather than `axios.isAxiosError`, so a test can
 * hand it a plain object and a non-axios rejection simply reads as false.
 */
export function isNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const response = (err as { response?: { status?: unknown } }).response;
  return typeof response === 'object' && response !== null && response.status === 404;
}
