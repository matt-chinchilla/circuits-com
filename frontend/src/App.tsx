import { lazy, Suspense, useEffect, useRef } from "react";
import { Routes, Route, useLocation } from "react-router-dom";

// 2026-04-19 Tier-3 #7 perf: Home stays eager (LCP target; must render
// on first paint). All other routes lazy-loaded — each gets its own
// Vite chunk, shrinking the initial bundle and pushing work off the
// critical path for the home-page visitor.
import HomePage from "@public/pages/home";

const CategoryPage = lazy(() => import("@public/pages/category"));
const SearchPage = lazy(() => import("@public/pages/search"));
const JoinPage = lazy(() => import("@public/pages/join"));
const ContactPage = lazy(() => import("@public/pages/contact"));
const AboutPage = lazy(() => import("@public/pages/about"));
const KeywordSponsorPage = lazy(() => import("@public/pages/keyword"));
const KeywordLandingPage = lazy(() => import("@public/pages/keyword-landing"));
const PartPage = lazy(() => import("@public/pages/part"));
const PrivacyPage = lazy(() => import("@public/pages/privacy"));
const NotFoundPage = lazy(() => import("@public/pages/not-found"));

// Admin chunk — all admin routes lazy. Recharts (~400 KB) lives inside
// admin/Reports; with these routes lazy it won't ship to public-page
// visitors. See vite.config.ts manualChunks for extra chunk hints.
const LoginPage = lazy(() => import("@admin/pages/login"));
const DashboardPage = lazy(() => import("@admin/pages/dashboard"));
const SuppliersPage = lazy(() => import("@admin/pages/suppliers/list"));
const SupplierDetailPage = lazy(
  () => import("@admin/pages/suppliers/detail"),
);
const SupplierFormPage = lazy(() => import("@admin/pages/suppliers/form"));
const PartsPage = lazy(() => import("@admin/pages/parts/list"));
const PartDetailPage = lazy(() => import("@admin/pages/parts/detail"));
const PartFormPage = lazy(() => import("@admin/pages/parts/form"));
const ImportPage = lazy(() => import("@admin/pages/import"));
const ReportsPage = lazy(() => import("@admin/pages/reports"));
const CategoriesPage = lazy(() => import("@admin/pages/categories"));
const SponsorsPage = lazy(() => import("@admin/pages/sponsors/list"));
const SponsorFormPage = lazy(() => import("@admin/pages/sponsors/form"));
const SettingsPage = lazy(() => import("@admin/pages/settings"));
const MessagesListPage = lazy(() => import("@admin/pages/messages/list"));
const MessageDetailPage = lazy(() => import("@admin/pages/messages/detail"));

import AdminLayout from "@admin/components/AdminLayout";
import ProtectedRoute from "@admin/components/ProtectedRoute";
import Navbar from "@public/components/layout/Navbar";
import NavVariantPicker from "@public/components/layout/NavVariantPicker";
import HeroColorTuner from "@public/components/widgets/HeroColorTuner";
import ThemeBridge from "@public/components/layout/ThemeBridge";
import PublicLayout from "@public/components/layout/PublicLayout";
import BackdropLayer from "@public/components/layout/BackdropLayer";
import ErrorBoundary from "@shared/components/ErrorBoundary";
import { DemoProvider } from "@admin/contexts/DemoContext";

// Admin fallback (PublicLayout provides the equivalent on public routes).
const RouteFallback = () => <div style={{ minHeight: 420 }} aria-busy="true" />;

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
  if (location.pathname.startsWith("/admin")) {
    return (
      <DemoProvider>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/admin/login" element={<LoginPage />} />
            <Route
              path="/admin/*"
              element={
                <ProtectedRoute>
                  <AdminLayout>
                    <ErrorBoundary key={location.pathname} scope="admin page">
                    <Routes>
                      <Route index element={<DashboardPage />} />
                      <Route path="suppliers" element={<SuppliersPage />} />
                      <Route
                        path="suppliers/new"
                        element={<SupplierFormPage />}
                      />
                      <Route
                        path="suppliers/:id"
                        element={<SupplierDetailPage />}
                      />
                      <Route
                        path="suppliers/:id/edit"
                        element={<SupplierFormPage />}
                      />
                      <Route path="parts" element={<PartsPage />} />
                      <Route path="parts/new" element={<PartFormPage />} />
                      <Route path="parts/:id" element={<PartDetailPage />} />
                      <Route path="parts/:id/edit" element={<PartFormPage />} />
                      <Route path="import" element={<ImportPage />} />
                      <Route path="reports" element={<ReportsPage />} />
                      <Route path="categories" element={<CategoriesPage />} />
                      <Route path="sponsors" element={<SponsorsPage />} />
                      <Route
                        path="sponsors/new"
                        element={<SponsorFormPage />}
                      />
                      <Route
                        path="sponsors/:id/edit"
                        element={<SponsorFormPage />}
                      />
                      <Route path="messages" element={<MessagesListPage />} />
                      <Route
                        path="messages/:id"
                        element={<MessageDetailPage />}
                      />
                      <Route path="settings" element={<SettingsPage />} />
                    </Routes>
                    </ErrorBoundary>
                  </AdminLayout>
                </ProtectedRoute>
              }
            />
          </Routes>
        </Suspense>
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
          <Route path="/contact" element={<ContactPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/keyword" element={<KeywordLandingPage />} />
          <Route path="/keyword/:keyword" element={<KeywordSponsorPage />} />
          <Route path="/part/:id" element={<PartPage />} />
          {/* /privacy and /terms render the same consolidated legal page
              (Claude Design's intent — see design-import/.../chat1.md). */}
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<PrivacyPage />} />
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
