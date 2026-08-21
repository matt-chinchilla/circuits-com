import { useState } from 'react';
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
  // While the search dropdown is open, the hero stacks above subsequent page
  // content (.ddOpen = position+z-index ONLY — spec §3: no contain/overflow;
  // the animated backdrop is a sibling, not a descendant). SearchBar reports
  // transitions pre-paint and guarantees a final false on unmount.
  const [ddOpen, setDdOpen] = useState(false);

  return (
    <section className={[styles.hero, ddOpen ? styles.ddOpen : ''].filter(Boolean).join(' ')}>
      <div className={styles.content}>
        <h1 className={styles.heading}>
          The Integrated Circuits Directory
        </h1>
        {/* Stays a <p>: the page's only <h2> is CategoryGrid's "Browse Categories".
            A heading here would sit in the outline labelling no section. */}
        {/* Carries "PCB components" and the compare-price intent, and nothing
            else: the h1 above already owns "integrated circuits", so repeating
            it here would spend the site's most prominent line on a term it is
            not competing for twice. */}
        <p className={styles.subtitle}>
          Compare prices and stock for PCB&nbsp;components
        </p>
        <SearchBar onDropdownOpenChange={setDdOpen} />
        <div className={styles.quickLinks}>
          <AnimatedLink to="/search">Find Parts</AnimatedLink>
          <AnimatedLink to="/join">Top Distributors</AnimatedLink>
          <AnimatedLink to="/bom">BOM Tool</AnimatedLink>
        </div>
      </div>
    </section>
  );
}
