import { motion } from 'framer-motion';
import type { Sponsor } from '../../types/sponsor';
import styles from './SponsorBlock.module.scss';

interface SponsorBlockProps {
  sponsor: Sponsor | null;
}

export default function SponsorBlock({ sponsor }: SponsorBlockProps) {
  if (!sponsor) {
    return (
      <motion.div
        className={styles.placeholder}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' as const }}
      >
        <span className={styles.placeholderIcon} aria-hidden="true">&#9733;</span>
        <h3 className={styles.placeholderTitle}>Advertise Here</h3>
        <p className={styles.placeholderText}>
          Reach buyers actively browsing this category. Get featured placement with your brand, logo, and direct contact info.
        </p>
        <a
          href="mailto:john@circuits.com?subject=Category%20Sponsorship%20Inquiry"
          className={styles.placeholderCta}
        >
          Become a Sponsor →
        </a>
      </motion.div>
    );
  }

  return (
    <motion.div
      className={styles.sponsor}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' as const }}
      whileHover={{ scale: 1.02, filter: 'brightness(1.05)' }}
    >
      <span className={styles.badge}>&#9733; CATEGORY SPONSOR</span>

      {sponsor.image_url && (
        <div className={styles.logoWrap}>
          <img
            src={sponsor.image_url}
            alt={`${sponsor.supplier_name} logo`}
            className={styles.logo}
          />
        </div>
      )}

      <h3 className={styles.name}>{sponsor.supplier_name}</h3>

      {sponsor.description && (
        <p className={styles.description}>{sponsor.description}</p>
      )}

      <div className={styles.details}>
        {sponsor.phone && (
          <a href={`tel:${sponsor.phone}`} className={styles.detail}>
            {sponsor.phone}
          </a>
        )}
        {sponsor.website && (
          <a
            href={sponsor.website}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.detail}
          >
            Visit Website
          </a>
        )}
      </div>
    </motion.div>
  );
}
