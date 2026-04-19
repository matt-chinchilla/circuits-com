import { lazy, Suspense } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'

// 2026-04-19 Tier-3 #7 perf: Home stays eager (LCP target; must render
// on first paint). All other routes lazy-loaded — each gets its own
// Vite chunk, shrinking the initial bundle and pushing work off the
// critical path for the home-page visitor.
import HomePage from './pages/HomePage'

const CategoryPage = lazy(() => import('./pages/CategoryPage'))
const SearchPage = lazy(() => import('./pages/SearchPage'))
const JoinPage = lazy(() => import('./pages/JoinPage'))
const ContactPage = lazy(() => import('./pages/ContactPage'))
const AboutPage = lazy(() => import('./pages/AboutPage'))
const KeywordSponsorPage = lazy(() => import('./pages/KeywordSponsorPage'))
const PartPage = lazy(() => import('./pages/PartPage'))

// Admin chunk — all admin routes lazy. Recharts (~400 KB) lives inside
// admin/Reports; with these routes lazy it won't ship to public-page
// visitors. See vite.config.ts manualChunks for extra chunk hints.
const LoginPage = lazy(() => import('./pages/admin/LoginPage'))
const DashboardPage = lazy(() => import('./pages/admin/DashboardPage'))
const SuppliersPage = lazy(() => import('./pages/admin/SuppliersPage'))
const SupplierDetailPage = lazy(() => import('./pages/admin/SupplierDetailPage'))
const SupplierFormPage = lazy(() => import('./pages/admin/SupplierFormPage'))
const PartsPage = lazy(() => import('./pages/admin/PartsPage'))
const PartDetailPage = lazy(() => import('./pages/admin/PartDetailPage'))
const PartFormPage = lazy(() => import('./pages/admin/PartFormPage'))
const ImportPage = lazy(() => import('./pages/admin/ImportPage'))
const ReportsPage = lazy(() => import('./pages/admin/ReportsPage'))
const CategoriesPage = lazy(() => import('./pages/admin/CategoriesPage'))
const SponsorsPage = lazy(() => import('./pages/admin/SponsorsPage'))

import AdminLayout from './components/admin/AdminLayout'
import DemoToggle from './components/admin/DemoToggle'
import ProtectedRoute from './components/admin/ProtectedRoute'
import Navbar from './components/layout/Navbar'
import NavVariantPicker from './components/layout/NavVariantPicker'
import HeroColorTuner from './components/shared/HeroColorTuner'
import ThemeBridge from './components/layout/ThemeBridge'
import { DemoProvider } from './contexts/DemoContext'

// Minimal Suspense fallback while a lazy route chunk fetches. Reserves
// ~420px (hero height) so scroll position is stable during the swap.
const RouteFallback = () => <div style={{ minHeight: 420 }} aria-busy="true" />

function App() {
  const location = useLocation()

  // Admin routes live outside AnimatePresence — admin has its own layout
  if (location.pathname.startsWith('/admin')) {
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
                    <Routes>
                      <Route index element={<DashboardPage />} />
                      <Route path="suppliers" element={<SuppliersPage />} />
                      <Route path="suppliers/new" element={<SupplierFormPage />} />
                      <Route path="suppliers/:id" element={<SupplierDetailPage />} />
                      <Route path="suppliers/:id/edit" element={<SupplierFormPage />} />
                      <Route path="parts" element={<PartsPage />} />
                      <Route path="parts/new" element={<PartFormPage />} />
                      <Route path="parts/:id" element={<PartDetailPage />} />
                      <Route path="parts/:id/edit" element={<PartFormPage />} />
                      <Route path="import" element={<ImportPage />} />
                      <Route path="reports" element={<ReportsPage />} />
                      <Route path="categories" element={<CategoriesPage />} />
                      <Route path="sponsors" element={<SponsorsPage />} />
                    </Routes>
                    <DemoToggle />
                  </AdminLayout>
                </ProtectedRoute>
              }
            />
          </Routes>
        </Suspense>
      </DemoProvider>
    )
  }

  return (
    <>
      <ThemeBridge />
      <Navbar />
      <AnimatePresence mode="popLayout">
        <Suspense fallback={<RouteFallback />}>
          <Routes location={location} key={location.pathname}>
            <Route path="/" element={<HomePage />} />
            <Route path="/category/:slug" element={<CategoryPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/join" element={<JoinPage />} />
            <Route path="/contact" element={<ContactPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/keyword/:keyword" element={<KeywordSponsorPage />} />
            <Route path="/part/:id" element={<PartPage />} />
          </Routes>
        </Suspense>
      </AnimatePresence>
      <NavVariantPicker />
      {import.meta.env.DEV && <HeroColorTuner />}
    </>
  )
}

export default App
