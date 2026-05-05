import { motion } from "framer-motion";
import HeroSection from "./components/HeroSection";
import CategoryGrid from "./components/CategoryGrid";
import Footer from "@public/components/layout/Footer";
import { useCategories } from "@public/hooks/useCategories";

export default function HomePage() {
  const { categories, loading, error } = useCategories();

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: "easeInOut" as const }}
    >
      <HeroSection />
      <CategoryGrid categories={categories} loading={loading} error={error} />
      <Footer />
    </motion.div>
  );
}
