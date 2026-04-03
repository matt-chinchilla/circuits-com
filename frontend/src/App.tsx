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
import PlaceholderPage from './pages/admin/PlaceholderPage'
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
                  <Route index element={<PlaceholderPage title="Dashboard" />} />
                  <Route path="suppliers" element={<PlaceholderPage title="Suppliers" />} />
                  <Route path="parts" element={<PlaceholderPage title="Parts" />} />
                  <Route path="import" element={<PlaceholderPage title="Import" />} />
                  <Route path="reports" element={<PlaceholderPage title="Reports" />} />
                  <Route path="categories" element={<PlaceholderPage title="Categories" />} />
                  <Route path="sponsors" element={<PlaceholderPage title="Sponsors" />} />
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
