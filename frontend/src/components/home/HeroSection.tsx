import CircuitTraces from '../shared/CircuitTraces';
import SearchBar from '../layout/SearchBar';
import AnimatedLink from '../shared/AnimatedLink';
import styles from './HeroSection.module.scss';

export default function HeroSection() {
  return (
    <section className={styles.hero}>
      <CircuitTraces />
      <div className={styles.content}>
        <h1 className={styles.heading}>
          The Integrated Circuits Directory
        </h1>
        <p className={styles.subtitle}>
          Circuits All The Time
        </p>
        <SearchBar />
        <div className={styles.quickLinks}>
          <AnimatedLink to="/search">Find Parts</AnimatedLink>
          <AnimatedLink to="/join">Top Distributors</AnimatedLink>
        </div>
      </div>
    </section>
  );
}
