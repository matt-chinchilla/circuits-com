// Phosphor Light icon wrapper — single point of truth for the
// `ph-light ph-{name}` class formula. The stylesheet is loaded once
// in frontend/index.html via the unpkg CDN, so this component is a
// pure presentational shell: no font-loading state, no fallback.
//
// Empty / nullish `name` renders nothing (some legacy seed rows may
// still carry old emoji strings during migration — silent no-op is
// safer than rendering "ph-light ph-⚡" which would 404 the glyph).

interface IconProps {
  name: string | null | undefined;
  className?: string;
  size?: string | number;
  ariaLabel?: string;
}

export default function Icon({ name, className, size, ariaLabel }: IconProps) {
  if (!name) return null;
  const isPhosphor = /^[a-z][a-z0-9-]*$/.test(name);
  if (!isPhosphor) return <span aria-hidden="true">{name}</span>;
  return (
    <i
      className={['ph-light', `ph-${name}`, className].filter(Boolean).join(' ')}
      style={size != null ? { fontSize: typeof size === 'number' ? `${size}px` : size } : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : 'true'}
      role={ariaLabel ? 'img' : undefined}
    />
  );
}
