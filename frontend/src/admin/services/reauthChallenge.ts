/**
 * The ONE 401 in the console that does not mean "your session is over".
 *
 * `DELETE /api/account/me` re-authenticates with the current password before
 * it destroys an account, and answers a wrong one with the SAME generic 401
 * `/auth/login` sends (routes/account.py — a distinguishable body would turn
 * the endpoint into a password oracle for a stolen session).
 *
 * The shared response interceptor reads every 401 as a retired token and drops
 * it. Applied to this route that would mean: mistype your password in the
 * Danger Zone and the token is gone while AuthContext still holds a `user` —
 * the documented stale-session dead-end, reachable by typo, on the one screen
 * where the next thing you do is irreversible. So the interceptor asks this
 * first, and leaves the (still valid) session alone.
 *
 * A pure predicate rather than a config flag on the request: it unit-tests with
 * no axios and no browser, and the exception stays ONE named route instead of a
 * boolean any future call site could set on itself.
 */

/** Method + relative url of the account self-delete, exactly as adminApi sends it. */
export const REAUTH_CHALLENGE = { method: 'delete', url: '/account/me' } as const;

/**
 * True for the account self-delete's re-auth challenge, false for every other
 * request. Both arguments come straight off the axios request config, which is
 * why they are permissively typed — a 401 with no config at all must not be
 * spared.
 */
export function isReauthChallenge(
  method: string | undefined | null,
  url: string | undefined | null,
): boolean {
  return (
    (method ?? '').toLowerCase() === REAUTH_CHALLENGE.method && (url ?? '') === REAUTH_CHALLENGE.url
  );
}
