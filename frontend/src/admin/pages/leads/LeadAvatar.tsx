// A lead's picture, or their initials when there is none — the call list's
// row avatar and the profile's header. Decorative (aria-hidden): the name is
// always rendered beside it.
//
// No .module.scss, like OutcomeDisc: it renders inside several CSS-Module
// scopes and every colour is an admin token that already follows the
// porcelain / dark theme through the .admin cascade.
//
// The src goes through safeImageUrl ALWAYS — a stored javascript:/svg value
// must never reach an <img src>, whatever the server let in at the time.

import { useState, type CSSProperties } from 'react';
import { safeImageUrl } from '@shared/utils/url';

import { leadInitials } from './photo';

interface LeadAvatarProps {
  photoUrl: string | null | undefined;
  contactName: string | null;
  companyName: string | null;
  /** Diameter in px. 28 = list row, 56 = profile header. */
  size?: number;
}

export default function LeadAvatar({ photoUrl, contactName, companyName, size = 28 }: LeadAvatarProps) {
  const src = safeImageUrl(photoUrl);
  // A hosted URL that 404s later falls back to the initials, not a broken
  // image glyph. Keyed on the src so a replaced picture gets a fresh chance.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showPhoto = src !== null && failedSrc !== src;

  const box: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    width: size,
    height: size,
    borderRadius: '50%',
    overflow: 'hidden',
    boxSizing: 'border-box',
    // A hairline so a white-background headshot still has an edge on the
    // porcelain card, and the initials disc reads as the same object.
    border: '1px solid var(--a-border)',
    background: 'var(--a-border-soft)',
    color: 'var(--a-fg2)',
    fontSize: Math.round(size * 0.38),
    fontWeight: 600,
    lineHeight: 1,
    letterSpacing: '0.02em',
    userSelect: 'none',
  };

  return (
    <span aria-hidden="true" style={box} data-lead-avatar={showPhoto ? 'photo' : 'initials'}>
      {showPhoto ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={() => setFailedSrc(src)}
        />
      ) : (
        leadInitials(contactName, companyName) ?? '·'
      )}
    </span>
  );
}
