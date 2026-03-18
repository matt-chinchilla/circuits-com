import CircuitTraces from './CircuitTraces';
import SearchBar from '../layout/SearchBar';
import AnimatedLink from '../shared/AnimatedLink';
import { useCategories } from '../../hooks/useCategories';
import styles from './HeroSection.module.scss';

export default function HeroSection() {
  const { categories } = useCategories();

  return (
    <section className={styles.hero}>
      <CircuitTraces />
      <div className={styles.content}>
        <h1 className={styles.heading}>
          The Integrated Circuits &amp; Electronic Components Directory
        </h1>
        <p className={styles.subtitle}>
          Find the Best Supplier in every category
        </p>
        <SearchBar />
        {categories.length > 0 && (
          <div className={styles.quickLinks}>
            {categories.slice(0, 3).map((cat) => (
              <AnimatedLink key={cat.id} to={`/category/${cat.slug}`}>
                {cat.name}
              </AnimatedLink>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
