import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import AnimatedLink from '../shared/AnimatedLink';
import type { Category } from '../../types/category';
import styles from './CategoryCard.module.scss';

interface CategoryCardProps {
  category: Category;
  index: number;
}

export default function CategoryCard({ category, index }: CategoryCardProps) {
  const navigate = useNavigate();

  function handleCardClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('a')) return;
    navigate(`/category/${category.slug}`);
  }

  return (
    <motion.div
      className={styles.card}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.4, ease: 'easeOut' }}
      whileHover={{ y: -4 }}
      onClick={handleCardClick}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/category/${category.slug}`); }}
    >
      <div className={styles.header}>
        <span className={styles.icon} aria-hidden="true">{category.icon}</span>
        <h3 className={styles.name}>{category.name}</h3>
      </div>
      {category.children.length > 0 && (
        <div className={styles.subcategories}>
          {category.children.map((sub) => (
            <AnimatedLink
              key={sub.id}
              to={`/category/${category.slug}#${sub.slug}`}
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
