import { lazy, Suspense, useEffect, useRef } from "react";
import { Routes, Route, useLocation, useNavigate } from "react-router-dom";

// 2026-04-19 Tier-3 #7 perf: Home stays eager (LCP target; must render
// on first paint). All other routes lazy-loaded — each gets its own
// Vite chunk, shrinking the initial bundle and pushing work off the
// critical path for the home-page visitor.
import HomePage from "@public/pages/home";

const CategoryPage = lazy(() => import("@public/pages/category"));
const SearchPage = lazy(() => import("@public/pages/search"));
const JoinPage = lazy(() => import("@public/pages/join"));
const BomPage = lazy(() => import("@public/pages/bom"));
const ContactPage = lazy(() => import("@public/pages/contact"));
const AboutPage = lazy(() => import("@public/pages/about"));
const KeywordSponsorPage = lazy(() => import("@public/pages/keyword"));
const KeywordLandingPage = lazy(() => import("@public/pages/keyword-landing"));
const PartPage = lazy(() => import("@public/pages/part"));
const PrivacyPage = lazy(() => import("@public/pages/privacy"));
const TermsPage = lazy(() => import("@public/pages/terms"));
const AcceptableUsePage = lazy(() => import("@public/pages/acceptable-use"));
const NotFoundPage = lazy(() => import("@public/pages/not-found"));

// Admin chunk — all admin routes lazy. Recharts (~400 KB) lives inside
// admin/Reports; with these routes lazy it won't ship to public-page
// visitors. See vite.config.ts manualChunks for extra chunk hints.
const LoginPage = lazy(() => import("@admin/pages/login"));
const ResetPasswordPage = lazy(() => import("@admin/pages/reset-password"));
const ChangePasswordPage = lazy(
  () => import("@admin/pages/change-password"),
);
const VerifyPage = lazy(() => import("@admin/pages/verify"));
// The console's own route table, extracted so /admin and /account can mount the
// SAME pages behind different guards. Its per-page lazy() imports moved with it.
const ConsoleRoutes = lazy(() => import("@admin/routes/ConsoleRoutes"));

// AdminLayout is LAZY on purpose (perf review 2026-07-31, measured): statically
// imported it dragged the whole admin chrome — adminApi/axios, presence, bell,
// wizard, and ~36KB of admin SCSS — into the PUBLIC entry chunk. Splitting it
// cut the entry 382→298KB raw (−20% gzip) and HALVED the render-blocking CSS
// on every public first paint. It renders inside the existing <Suspense>.
// ProtectedRoute stays static (tiny; needed to gate before the chunk loads).
const AdminLayout = lazy(() => import("@admin/components/AdminLayout"));
import ProtectedRoute from "@admin/components/ProtectedRoute";
import Navbar from "@public/components/layout/Navbar";
import NavVariantPicker from "@public/components/layout/NavVariantPicker";
import HeroColorTuner from "@public/components/widgets/HeroColorTuner";
import ThemeBridge from "@public/components/layout/ThemeBridge";
import PublicLayout from "@public/components/layout/PublicLayout";
import BackdropLayer from "@public/components/layout/BackdropLayer";
import ErrorBoundary from "@shared/components/ErrorBoundary";
import { DemoProvider } from "@admin/contexts/DemoContext";
import { AdminThemeProvider } from "@admin/contexts/AdminThemeContext";

// Admin fallback (PublicLayout provides the equivalent on public routes).
const RouteFallback = () => <div style={{ minHeight: 420 }} aria-busy="true" />;

// /pricing → /join. The redirect is an EFFECT, not a rendered <Navigate>:
// ErrorBoundary is keyed on pathname, so a remount drops a rendered child's
// navigation and the visitor is left on an empty page with a frozen URL (the
// same trap as the category canonical redirect — see CLAUDE.md).
function PricingRedirect() {
  const navigate = useNavigate();
  const { search, hash } = useLocation();
  useEffect(() => {
    // Carry the query and fragment: reps' outstanding /pricing?utm_* links are
    // the reason this route still exists, and stripping the params here would
    // silently zero their campaign attribution in the PageView analytics.
    navigate({ pathname: "/join", search, hash }, { replace: true });
  }, [navigate, search, hash]);
  return null;
}

function App() {
  const location = useLocation();

  // SPA scroll-restoration — reset to top on every route change so each
  // page begins at its hero/band. React Router v6 doesn't do this by
  // default (only browser-level loads reset scroll); without this, users
  // landed mid-page when navigating from a scrolled position elsewhere.
  // The hash exception preserves /privacy#section-X anchor navigation
  // (the privacy page uses scrollIntoView({ block: "start" }) on its
  // anchor targets — see CLAUDE.md "Adding a new public page" gotcha).
  // Fires for public AND admin paths because the effect sits above the
  // admin early-return below.
  useEffect(() => {
    if (location.hash) return;
    window.scrollTo({ top: 0, left: 0 });
  }, [location.pathname]);

  // Route prefetch — defer until well after the current page's LCP so we
  // don't compete with the active page's chunk + API loads for HTTP
  // connections (2026-05-30 fix: at idle <500 ms these prefetches were
  // queuing behind the category-page critical path on HTTP/1.1, pushing
  // the API fetch out to ~419 ms). Two-stage delay: idle + 2.5 s timeout
  // means we wait for both the browser-idle signal AND a hard 2.5 s
  // floor, comfortably past LCP-good target (2.5 s) on slow devices.
  const prefetched = useRef(false);
  useEffect(() => {
    if (prefetched.current) return;
    prefetched.current = true;
    const start = () => {
      const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 200));
      idle(() => {
        const p = (m: Promise<unknown>) => m.catch(() => {});
        p(import("@public/pages/category"));
        p(import("@public/pages/search"));
        p(import("@public/pages/part"));
        p(import("@public/pages/about"));
        p(import("@public/pages/join"));
      });
    };
    const id = window.setTimeout(start, 2500);
    return () => window.clearTimeout(id);
  }, []);

  // Admin routes live outside AnimatePresence — admin has its own layout.
  // ErrorBoundary keyed on pathname so render crashes inside any admin page
  // (e.g. the 2026-05-16 null spam_score → .toFixed() bug) surface a
  // recoverable fallback instead of a blank screen; key change on nav auto-
  // clears the error state when the user routes away.
  // /account is the SAME console behind a customer-shaped guard (D16), so it
  // takes the admin branch: public chrome (Navbar, BackdropLayer) must not
  // render over it.
  if (
    location.pathname.startsWith("/admin") ||
    location.pathname.startsWith("/account")
  ) {
    return (
      <DemoProvider>
        <AdminThemeProvider>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/admin/login" element={<LoginPage />} />
            <Route path="/admin/reset-password" element={<ResetPasswordPage />} />
            {/* Forced password reset — outside ProtectedRoute, which redirects
                HERE while the gate is up (the page does its own auth check). */}
            <Route
              path="/admin/change-password"
              element={<ChangePasswordPage />}
            />
            {/* Sign-up and verification are UNAUTHENTICATED — siblings of
                /admin/login, never behind ProtectedRoute. /admin/signup is the
                login shell opened on its sign-up screen; /admin/verify is where
                the emailed link lands and spends its token with a POST. */}
            <Route path="/admin/signup" element={<LoginPage />} />
            <Route path="/admin/verify" element={<VerifyPage />} />
            <Route
              path="/admin/*"
              element={
                <ProtectedRoute>
                  <AdminLayout>
                    <ErrorBoundary key={location.pathname} scope="admin page">
                      <ConsoleRoutes />
                    </ErrorBoundary>
                  </AdminLayout>
                </ProtectedRoute>
              }
            />
            {/* The customer mount. Same chrome, same route table, different
                guard — ProtectedRoute sends a customer who reaches /admin here
                and a staff account who reaches here back to /admin. */}
            <Route
              path="/account/*"
              element={
                <ProtectedRoute area="account">
                  <AdminLayout>
                    <ErrorBoundary key={location.pathname} scope="admin page">
                      <ConsoleRoutes />
                    </ErrorBoundary>
                  </AdminLayout>
                </ProtectedRoute>
              }
            />
          </Routes>
        </Suspense>
        </AdminThemeProvider>
      </DemoProvider>
    );
  }

  // Public routes. <BackdropLayer /> mounts ONCE here — above <Routes> — so
  // the persistent <CircuitTraces variant="full" /> SVG inside it never
  // remounts on navigation. Same DOM node, same animation state, same colors
  // visible behind home's hero AND every band-using inner page (about, join,
  // contact). Pages render at z-index 1 (PublicLayout's outletWrap) above the
  // backdrop's z-index 0; their hero/band areas are transparent so the
  // backdrop shows through, and their light --theme-surface-bg sits on a body
  // wrapper that starts below the band area.
  return (
    <>
      <ThemeBridge />
      <Navbar />
      <BackdropLayer />
      <Routes>
        <Route element={<PublicLayout />}>
          <Route path="/" element={<HomePage />} />
          {/* Flat = top-level category. Nested = subcategory under its parent
              (the canonical sub URL). CategoryPage reads whichever param shape
              matched and redirects flat child slugs → their nested canonical. */}
          <Route path="/category/:slug" element={<CategoryPage />} />
          <Route path="/category/:parentSlug/:childSlug" element={<CategoryPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/join" element={<JoinPage />} />
          {/* One page, two doors: /bom is the tool, /bom/s/:slug is a
              read-only share of somebody's priced table. */}
          <Route path="/bom" element={<BomPage />} />
          <Route path="/bom/s/:slug" element={<BomPage />} />
          <Route path="/contact" element={<ContactPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/keyword" element={<KeywordLandingPage />} />
          {/* /pricing (nav "Advertise") merged INTO /join on 2026-08-14 — the
              tiers, the board picker and the partners desk all live on the
              staged Join page now. The old URL is in reps' emails and in the
              index, so it keeps resolving. */}
          <Route path="/pricing" element={<PricingRedirect />} />
          <Route path="/keyword/:keyword" element={<KeywordSponsorPage />} />
          <Route path="/part/:id" element={<PartPage />} />
          {/* Three separate legal documents sharing one chrome component.
              /terms rendered the PRIVACY policy until 2026-08-05 — the footer
              advertised terms the site did not have. Don't re-merge them. */}
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/acceptable-use" element={<AcceptableUsePage />} />
          {/* Catch-all 404. MUST stay last in the public Routes block.
              Lives inside <Route element={<PublicLayout />}> so the persistent
              BackdropLayer + Footer chrome render on the fallback too. */}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
      {import.meta.env.DEV && <NavVariantPicker />}
      {import.meta.env.DEV && <HeroColorTuner />}
    </>
  );
}

export default App;
