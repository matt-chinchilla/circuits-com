import SearchBar from '@public/components/layout/SearchBar';
import AnimatedLink from '@public/components/widgets/AnimatedLink';
import styles from './HeroSection.module.scss';

// Home hero LAYOUT only. The dark substrate + animated <CircuitTraces /> SVG
// live in <BackdropLayer /> mounted at App.tsx level — persistent across all
// public routes, NEVER remounts. .hero is transparent so the backdrop shows
// through; .content sits above via z-index: 1. min-height: 420px reserves
// space matching the backdrop's height so the page wrapper's bottom doesn't
// pull above the backdrop on short content.
export default function HeroSection() {
  return (
    <section className={styles.hero}>
      <div className={styles.content}>
        <h1 className={styles.heading}>
          Electronic Components Directory
        </h1>
        <p className={styles.subtitle}>
          Compare prices from 57 distributors — ICs, MCUs, sensors &amp; more
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
