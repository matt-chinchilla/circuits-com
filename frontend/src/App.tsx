import { Routes, Route, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import HomePage from './pages/HomePage'
import CategoryPage from './pages/CategoryPage'
import SearchPage from './pages/SearchPage'
import JoinPage from './pages/JoinPage'
import ContactPage from './pages/ContactPage'
import AboutPage from './pages/AboutPage'
import KeywordSponsorPage from './pages/KeywordSponsorPage'
import LoginPage from './pages/admin/LoginPage'
import DashboardPage from './pages/admin/DashboardPage'
import SuppliersPage from './pages/admin/SuppliersPage'
import SupplierDetailPage from './pages/admin/SupplierDetailPage'
import SupplierFormPage from './pages/admin/SupplierFormPage'
import PartsPage from './pages/admin/PartsPage'
import PartDetailPage from './pages/admin/PartDetailPage'
import PartFormPage from './pages/admin/PartFormPage'
import ImportPage from './pages/admin/ImportPage'
import ReportsPage from './pages/admin/ReportsPage'
import CategoriesPage from './pages/admin/CategoriesPage'
import SponsorsPage from './pages/admin/SponsorsPage'
import AdminLayout from './components/admin/AdminLayout'
import ProtectedRoute from './components/admin/ProtectedRoute'

function App() {
  const location = useLocation()

  // Admin routes live outside AnimatePresence — admin has its own layout
  if (location.pathname.startsWith('/admin')) {
    return (
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
              </AdminLayout>
            </ProtectedRoute>
          }
        />
      </Routes>
    )
  }

  return (
    <AnimatePresence mode="popLayout">
      <Routes location={location} key={location.pathname}>
        <Route path="/" element={<HomePage />} />
        <Route path="/category/:slug" element={<CategoryPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/join" element={<JoinPage />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/keyword/:keyword" element={<KeywordSponsorPage />} />
      </Routes>
    </AnimatePresence>
  )
}

export default App
