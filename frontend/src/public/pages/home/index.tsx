import { motion } from "framer-motion";
import { Helmet } from "react-helmet-async";
import HeroSection from "./components/HeroSection";
import CategoryGrid from "./components/CategoryGrid";
import { useCategories } from "@public/hooks/useCategories";

const WEBSITE_JSONLD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Circuits.com",
  url: "https://circuits.com/",
  potentialAction: {
    "@type": "SearchAction",
    target: "https://circuits.com/search?q={search_term_string}",
    "query-input": "required name=search_term_string",
  },
});

export default function HomePage() {
  const { categories, loading, error } = useCategories();

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: "easeInOut" as const }}
    >
      <Helmet>
        <title>The Integrated Circuits Directory — Compare Prices &amp; Distributors | Circuits.com</title>
        <meta name="description" content="Compare prices and stock for 3,600+ electronic components from 57 distributors. ICs, MCUs, sensors, and more." />
        <link rel="canonical" href="https://circuits.com/" />
        <script type="application/ld+json">{WEBSITE_JSONLD}</script>
      </Helmet>
      <HeroSection />
      <CategoryGrid categories={categories} loading={loading} error={error} />
    </motion.div>
  );
}
