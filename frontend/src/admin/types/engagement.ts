// -----------------------------------------------------------------------------
// Social / ad-platform engagement contract (FRONTEND-ONLY, no backend yet).
// Types are the wire shape the panel will consume verbatim once the endpoint
// lands, so the UI can be built + reviewed against adminApi.getEngagement()
// returning [] today and require ZERO type churn on cutover.
// -----------------------------------------------------------------------------

/**
 * Single source of truth for platform identity + iteration order (legend order,
 * stack order, tab order all read this array). Add a platform HERE and the
 * `Record<SocialPlatform, PlatformMeta>` below fails to compile until its meta
 * row exists -- that compile error is the point.
 */
export const SOCIAL_PLATFORMS = [
  'instagram',
  'tiktok',
  'google_ads',
  'meta_ads',
  'snapchat',
  'linkedin',
  'x',
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/** Narrow an untrusted server-sent string (unknown platform -> drop the series). */
export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === 'string' && (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

export interface PlatformMeta {
  /** Human label for legends, tabs, tooltips. */
  label: string;
  /** Official brand hex. Compile-time constant -- NOT DB-sourced, so it does not
   *  need `safeHexColor` (@shared/utils/color); any color that ever arrives from
   *  the API or admin input still must. */
  color: string;
  /** Phosphor Light glyph, rendered via <Icon name={...} /> (@shared/components/Icon).
   *  All 7 verified present in frontend/public/fonts/phosphor-light/style.css.
   *  Never render the raw string as a text node -- it prints the literal name. */
  icon: string;
}

/**
 * Brand colors, single-color chart-safe pick per platform.
 * Contrast caveats on the admin's un-themed white panels:
 *   - snapchat #FFFC00 is ~1.1:1 on white -- give the mark a darker stroke
 *     (e.g. 1px var(--fg2)) or use it as fill-only under a labelled axis.
 *   - x #000000 and tiktok's black are fine on white; if this panel ever inherits
 *     a dark surface, both need a light-mode-swapped stroke.
 * TikTok resolves to its brand red (#FE2C55) rather than black so the series is
 * distinguishable from `x` in a multi-line chart.
 */
export const PLATFORM_META: Record<SocialPlatform, PlatformMeta> = {
  instagram: { label: 'Instagram', color: '#E1306C', icon: 'instagram-logo' },
  tiktok: { label: 'TikTok', color: '#FE2C55', icon: 'tiktok-logo' },
  google_ads: { label: 'Google Ads', color: '#4285F4', icon: 'google-logo' },
  meta_ads: { label: 'Meta Ads', color: '#0668E1', icon: 'meta-logo' },
  snapchat: { label: 'Snapchat', color: '#FFFC00', icon: 'snapchat-logo' },
  linkedin: { label: 'LinkedIn', color: '#0A66C2', icon: 'linkedin-logo' },
  x: { label: 'X', color: '#000000', icon: 'x-logo' },
};

/** One day-bucket of metrics for one platform. */
export interface PlatformEngagementPoint {
  /** UTC calendar day, `YYYY-MM-DD`. Ascending, gap-filled with zero rows so the
   *  chart never has to interpolate a missing day. */
  day: string;
  impressions: number;
  reach: number;
  clicks: number;
  /** Account currency minor-unit-free decimal (e.g. 1234.56).
   *  TRAP: a Postgres NUMERIC column serializes to a JSON *string* ("1234.56")
   *  despite this `number` type -- coerce with Number() before any sum/compare/
   *  sort, same as AdminSponsor.amount. */
  spend: number;
  /** Follower count AT END OF DAY (a level, not a delta) -- do not sum across days. */
  followers: number;
  /** FRACTION in [0, 1], not a percent. Render as `(v * 100).toFixed(2) + '%'`. */
  engagement_rate: number;
}

/** Per-platform series. `label`/`color` are denormalized from PLATFORM_META so a
 *  chart cell can render from the series alone; PLATFORM_META stays authoritative
 *  when the two disagree. */
export interface PlatformEngagementSeries {
  platform: SocialPlatform;
  label: string;
  color: string;
  points: PlatformEngagementPoint[];
}

/**
 * ===========================================================================
 * FUTURE ENDPOINT:  GET /api/dashboard/engagement?days=30
 * ===========================================================================
 * Auth: admin JWT (Authorization: Bearer <localStorage.admin_token>), same as
 * every other /api/dashboard/* route.
 *
 * Query: `days` integer, clamp 1..365, default 30.
 *
 * Response 200: PlatformEngagementSeries[]
 *   - One entry per connected platform, in SOCIAL_PLATFORMS order.
 *   - A connected-but-empty platform returns an entry with `points: []`.
 *     An UNCONNECTED platform is omitted entirely -- the panel renders a
 *     "Connect <label>" empty slot for anything missing from the response.
 *   - `points` ascending by `day`, exactly `days` gap-filled entries.
 *   - Response should carry `Cache-Control: no-cache` (metrics are near-live)
 *     and skip the SW runtime cache, matching the category-endpoint precedent.
 *
 * Server-side shape:
 *   ingest each provider on a schedule into a `platform_engagement_daily`
 *   table (UNIQUE(platform, day)) and serve THAT -- never fan out to 7 vendor
 *   APIs inside the request. Every provider below is rate-limited and several
 *   backfill/restate a day for 24-72h, so the ingest must upsert, not append.
 *
 * PER-PLATFORM UPSTREAM SOURCE (all OAuth; tokens live server-side only, never
 * in the SPA):
 *   instagram  -> Meta Graph API, GET /{ig-user-id}/insights + /media insights.
 *                 OAuth 2.0 long-lived Page/User token; scopes instagram_basic,
 *                 instagram_manage_insights, pages_read_engagement. ~60d expiry, refreshable.
 *   meta_ads   -> Meta Graph API (Marketing), GET /act_{ad_account_id}/insights
 *                 (impressions, reach, clicks, spend). OAuth 2.0, scope ads_read;
 *                 same token family as instagram, so ONE Meta connection feeds both.
 *   tiktok     -> TikTok Business API: /business/get/ (organic account + video
 *                 metrics) and /report/integrated/get/ (paid). OAuth 2.0
 *                 authorization-code -> access_token + refresh_token.
 *   google_ads -> Google Ads API (GoogleAdsService.SearchStream, GAQL over
 *                 `campaign`/`customer` with segments.date). OAuth 2.0 refresh
 *                 token PLUS a developer token and login-customer-id header.
 *   snapchat   -> Snapchat Marketing API, GET /adaccounts/{id}/stats
 *                 (granularity=DAY). OAuth 2.0 authorization-code w/ refresh token.
 *   linkedin   -> LinkedIn Marketing API: /rest/adAnalytics (paid) and
 *                 organizationalEntityShareStatistics (organic). OAuth 2.0
 *                 3-legged; scopes r_ads_reporting, r_organization_social.
 *   x          -> X API v2, GET /2/users/:id/tweets?tweet.fields=public_metrics
 *                 (+ /2/users/:id for followers); paid via the X Ads API.
 *                 OAuth 2.0 authorization-code + PKCE (X Ads endpoints still OAuth 1.0a).
 *
 * FIELD-COVERAGE CAVEATS to encode at ingest, not in the UI:
 *   - `reach` is unique-user data: Meta and Snapchat report it natively; Google
 *     Ads exposes it only as unique-reach on video/display, LinkedIn and X have
 *     no true daily reach. Emit 0 and let the panel hide a series that is all-zero
 *     rather than inventing a value.
 *   - `followers` is meaningless for a pure ad account -- for google_ads/meta_ads
 *     carry the linked organic account's level, or 0.
 *   - `engagement_rate` is computed BY US (engagements / impressions) so the
 *     definition is identical across all 7; do not pass through each vendor's
 *     own differently-defined rate.
 *   - `spend` is 0 for organic-only platforms; currency must be normalized to a
 *     single account currency at ingest (no per-series currency field here).
 */
