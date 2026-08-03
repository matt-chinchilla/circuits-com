import { motion } from "framer-motion";
import HeroSection from "./components/HeroSection";
import CategoryGrid from "./components/CategoryGrid";
import PageHead from "@public/components/PageHead";
import { useCategories } from "@public/hooks/useCategories";
import { homeSeo } from "@public/services/seo";

// Built once: the JSON-LD graphs are stringified inside homeSeo(), and the
// home route re-renders on every category fetch.
const HOME_SEO = homeSeo();

export default function HomePage() {
  const { categories, loading, error } = useCategories();

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: "easeInOut" as const }}
    >
      <PageHead seo={HOME_SEO} />
      <HeroSection />
      <CategoryGrid categories={categories} loading={loading} error={error} />
    </motion.div>
  );
}
