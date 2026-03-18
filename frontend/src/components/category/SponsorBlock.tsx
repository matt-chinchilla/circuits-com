import { motion } from 'framer-motion';
import type { Sponsor } from '../../types/sponsor';
import styles from './SponsorBlock.module.scss';

interface SponsorBlockProps {
  sponsor: Sponsor | null;
}

export default function SponsorBlock({ sponsor }: SponsorBlockProps) {
  if (!sponsor) return null;

  return (
    <motion.div
      className={styles.sponsor}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
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
