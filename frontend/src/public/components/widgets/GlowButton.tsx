import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './GlowButton.module.scss';

interface GlowButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'gold';
  children: ReactNode;
}

export default function GlowButton({
  variant = 'primary',
  children,
  className,
  ...rest
}: GlowButtonProps) {
  const classes = [styles.glowButton, styles[variant], className]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  );
}
