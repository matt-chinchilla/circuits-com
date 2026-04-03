import { motion } from 'framer-motion';
import Navbar from '../components/layout/Navbar';
import HeroSection from '../components/home/HeroSection';
import CategoryGrid from '../components/home/CategoryGrid';
import Footer from '../components/layout/Footer';
import { useCategories } from '../hooks/useCategories';

export default function HomePage() {
  const { categories, loading, error } = useCategories();

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: 'easeInOut' as const }}
    >
      <Navbar />
      <HeroSection />
      <CategoryGrid categories={categories} loading={loading} error={error} />
      <Footer />
    </motion.div>
  );
}
