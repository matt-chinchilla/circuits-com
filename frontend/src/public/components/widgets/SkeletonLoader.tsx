import styles from './SkeletonLoader.module.scss';

interface SkeletonLoaderProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
}

export default function SkeletonLoader({
  width = '100%',
  height = '20px',
  borderRadius = '4px',
}: SkeletonLoaderProps) {
  return (
    <div
      className={styles.skeleton}
      style={{ width, height, borderRadius }}
      aria-hidden="true"
    />
  );
}
