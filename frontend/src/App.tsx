import { Routes, Route, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import HomePage from './pages/HomePage'
import CategoryPage from './pages/CategoryPage'
import SearchPage from './pages/SearchPage'
import JoinPage from './pages/JoinPage'
import ContactPage from './pages/ContactPage'
import AboutPage from './pages/AboutPage'
import KeywordSponsorPage from './pages/KeywordSponsorPage'

function App() {
  const location = useLocation()

  return (
    <AnimatePresence mode="wait">
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
