import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import AnimatedLink from "@public/components/widgets/AnimatedLink";
import { api } from "@public/services/api";
import Icon from "@shared/components/Icon";
import { categoryPath } from "@shared/utils/categoryPath";
import type { Category } from "@public/types/category";
import styles from "./CategoryCard.module.scss";

interface CategoryCardProps {
  category: Category;
  index: number;
}

export default function CategoryCard({ category, index }: CategoryCardProps) {
  const navigate = useNavigate();

  // The API's top-level parts_count is own-only (parts attach to
  // subcategories), so the card's number is own + children — the same
  // rollup the category page itself shows.
  const totalParts =
    (category.parts_count ?? 0) +
    category.children.reduce((sum, sub) => sum + (sub.parts_count ?? 0), 0);

  function handleCardClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("a")) return;
    navigate(`/category/${category.slug}`);
  }

  return (
    <motion.div
      className={styles.card}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      // Cap the stagger: with 28 categories a linear delay left the last
      // cards invisible for 1.35s (review-caught).
      transition={{ delay: Math.min(index, 12) * 0.05, duration: 0.4, ease: "easeOut" }}
      whileHover={{ y: -4 }}
      onMouseEnter={() => {
        import("@public/pages/category").catch(() => {});
        api.prefetchCategory(category.slug);
      }}
      onClick={handleCardClick}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") navigate(`/category/${category.slug}`);
      }}
    >
      <div className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          <Icon name={category.icon} />
        </span>
        <h3 className={styles.name}>{category.name}</h3>
        {totalParts > 0 && (
          <span
            className={styles.count}
            aria-label={`${totalParts.toLocaleString()} parts`}
          >
            {totalParts.toLocaleString()}
          </span>
        )}
      </div>
      {category.children.length > 0 && (
        <div className={styles.subcategories}>
          {category.children.map((sub) => (
            <AnimatedLink
              key={sub.id}
              to={categoryPath(sub.slug, category.slug)}
              className={styles.pill}
            >
              {sub.name}
            </AnimatedLink>
          ))}
        </div>
      )}
    </motion.div>
  );
}
