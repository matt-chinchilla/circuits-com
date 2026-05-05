import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import styles from './AnimatedLink.module.scss';

interface AnimatedLinkProps {
  to: string;
  children: ReactNode;
  className?: string;
}

export default function AnimatedLink({ to, children, className }: AnimatedLinkProps) {
  return (
    <Link
      to={to}
      className={[styles.animatedLink, className].filter(Boolean).join(' ')}
    >
      {children}
    </Link>
  );
}
