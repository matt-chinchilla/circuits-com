// sessionToken — the admin JWT as the client sees it.
//
// The ONE reader of the token storage key (`authHeaders` in adminApi builds
// the Bearer header from `readToken()`; the query cache namespaces its
// persisted entries by the token's subject). Claims are read, never trusted:
// the server verifies the signature on every request; here `sub` is only a
// label that keeps one person's cached payloads apart from another's on a
// shared browser.

export const TOKEN_KEY = 'admin_token';

export interface TokenClaims {
  sub?: string;
  role?: string;
  exp?: number;
}

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let lastToken: string | null = null;
let lastClaims: TokenClaims | null = null;

/** The token's payload, or null when there is no token or it does not parse.
 *  Memoised on the token string: the cache asks on every lookup. */
export function tokenClaims(token: string | null = readToken()): TokenClaims | null {
  if (token === lastToken) return lastClaims;
  lastToken = token;
  lastClaims = decode(token);
  return lastClaims;
}

function decode(token: string | null): TokenClaims | null {
  if (!token) return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const { sub, role, exp } = parsed as Record<string, unknown>;
    return {
      sub: typeof sub === 'string' ? sub : undefined,
      role: typeof role === 'string' ? role : undefined,
      exp: typeof exp === 'number' ? exp : undefined,
    };
  } catch {
    return null;
  }
}
