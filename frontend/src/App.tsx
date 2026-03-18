import { Routes, Route } from 'react-router-dom'
import HomePage from './pages/HomePage'
import CategoryPage from './pages/CategoryPage'

function Placeholder({ name }: { name: string }) {
  return <div style={{ padding: '2rem', textAlign: 'center' }}><h1>{name}</h1><p>Coming soon...</p></div>
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/category/:slug" element={<CategoryPage />} />
      <Route path="/search" element={<Placeholder name="Search" />} />
      <Route path="/join" element={<Placeholder name="Join" />} />
      <Route path="/contact" element={<Placeholder name="Contact" />} />
      <Route path="/about" element={<Placeholder name="About" />} />
    </Routes>
  )
}

export default App
