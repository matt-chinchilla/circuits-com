import { motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import PageHeaderBand from "@public/components/layout/PageHeaderBand";
import GlowButton from "@public/components/widgets/GlowButton";
import styles from "./NotFoundPage.module.scss";

// 404 fallback. Mounted at "*" in App.tsx (last route in the public block) so
// any unmatched URL — historically blank-screen against the persistent
// BackdropLayer — lands here instead. Follows the ContactPage pattern:
// PageHeaderBand for header chrome + motion.div page entrance + body wrapper
// carrying var(--theme-surface-bg) so the backdrop shows through the band area
// but the body is opaque.
export default function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.15, ease: "easeInOut" as const }}
    >
      <PageHeaderBand
        page="not-found"
        title="Not Found"
        subtitle="We couldn't find what you were looking for."
      />

      <div className={styles.notFoundBody}>
        <div className={styles.inner}>
          <p className={styles.lede}>
            The page you tried to reach doesn&rsquo;t exist or may have moved.
            Head back home or try searching for what you need.
          </p>

          <div className={styles.actions}>
            <GlowButton variant="primary" onClick={() => navigate("/")}>
              Back to home
            </GlowButton>
            <Link to="/search" className={styles.link}>
              Try a search →
            </Link>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
