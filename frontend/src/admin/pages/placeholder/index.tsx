import styles from './PlaceholderPage.module.scss';

interface PlaceholderPageProps {
  title: string;
}

export default function PlaceholderPage({ title }: PlaceholderPageProps) {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.message}>This page is under construction.</p>
    </div>
  );
}
