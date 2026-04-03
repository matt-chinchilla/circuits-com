import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import Navbar from '../components/layout/Navbar';
import Footer from '../components/layout/Footer';
import GlowButton from '../components/shared/GlowButton';
import CircuitTraces from '../components/shared/CircuitTraces';
import styles from './AboutPage.module.scss';

const STEPS = [
  {
    icon: '🔍',
    title: 'Search',
    description:
      'Browse our comprehensive directory of electronic component categories or search by keyword to find exactly what you need.',
  },
  {
    icon: '📊',
    title: 'Compare',
    description:
      'Review supplier listings, check featured partners, and compare options across every component category.',
  },
  {
    icon: '🤝',
    title: 'Connect',
    description:
      'Reach out directly to suppliers via phone, email, or website. Build relationships with the industry\'s best.',
  },
];

const stepCardVariants = {
  hidden: { opacity: 0, y: 24 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.15, duration: 0.45, ease: 'easeOut' as const },
  }),
};

export default function AboutPage() {
  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
    >
      <Navbar />

      {/* Hero */}
      <section className={styles.hero}>
        <CircuitTraces />
        <div className={styles.heroInner}>
          <motion.h1
            className={styles.heroTitle}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          >
            The Trusted Directory for Integrated Circuits
          </motion.h1>
          <motion.p
            className={styles.heroSubtitle}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.12, ease: 'easeOut' }}
          >
            Circuits.com connects buyers with the best suppliers across every category of
            integrated circuits and electronic components. Fast, reliable, and built for the
            industry.
          </motion.p>
        </div>
      </section>

      {/* How it works */}
      <section className={styles.howSection}>
        <h2 className={styles.sectionTitle}>How It Works</h2>
        <div className={styles.stepsGrid}>
          {STEPS.map((step, i) => (
            <motion.div
              key={step.title}
              className={styles.stepCard}
              custom={i}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, amount: 0.3 }}
              variants={stepCardVariants}
            >
              <span className={styles.stepIcon} aria-hidden="true">
                {step.icon}
              </span>
              <span className={styles.stepNumber} aria-hidden="true">
                {i + 1}
              </span>
              <h3 className={styles.stepTitle}>{step.title}</h3>
              <p className={styles.stepDescription}>{step.description}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Value proposition */}
      <section className={styles.valueSection}>
        <div className={styles.valueInner}>
          <motion.h2
            className={styles.valueTitle}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4 }}
          >
            Why Circuits.com?
          </motion.h2>
          <motion.p
            className={styles.valueText}
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: 0.1 }}
          >
            For over two decades, Circuits.com has been the go-to resource for professionals
            sourcing integrated circuits, semiconductors, passive components, and more. Our
            curated directory saves you time by putting verified suppliers at your fingertips.
          </motion.p>
          <motion.p
            className={styles.valueText}
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: 0.2 }}
          >
            Whether you&rsquo;re an engineer looking for a specific part or a purchasing manager
            comparing suppliers, Circuits.com gives you the information you need to make confident
            decisions.
          </motion.p>
        </div>
      </section>

      {/* CTA */}
      <section className={styles.ctaSection}>
        <motion.h2
          className={styles.ctaTitle}
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4 }}
        >
          Ready to Get Listed?
        </motion.h2>
        <motion.p
          className={styles.ctaSubtitle}
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, delay: 0.08 }}
        >
          Join our directory and put your company in front of buyers who are actively searching
          for electronic components.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, delay: 0.16 }}
        >
          <Link to="/join">
            <GlowButton variant="gold">Join Circuits.com</GlowButton>
          </Link>
        </motion.div>
      </section>

      <Footer />
    </motion.div>
  );
}
