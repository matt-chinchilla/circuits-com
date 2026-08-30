import { describe, it, expect } from 'vitest';
import {
  INTEL_CARD,
  cityLabel,
  clampCardPosition,
  deviceSplitLabel,
  formatLastSeen,
  networkLines,
  plural,
  viewsVisitorsLabel,
} from './cityIntel';

/** The interpunct the card joins inline pairs with, as a literal for the
 *  assertions below (the module writes it as an escape on purpose). */
const SEP = ' · ';

describe('cityLabel', () => {
  it('appends the region when there is one', () => {
    expect(cityLabel({ city: 'Austin', region: 'Texas' })).toBe('Austin, Texas');
  });

  it('leaves a region-less city alone rather than printing a dangling comma', () => {
    expect(cityLabel({ city: 'Austin', region: null })).toBe('Austin');
    expect(cityLabel({ city: 'Austin' })).toBe('Austin');
    expect(cityLabel({ city: 'Austin', region: '' })).toBe('Austin');
  });
});

describe('plural', () => {
  it('drops the s only at exactly one', () => {
    expect(plural(1, 'view')).toBe('1 view');
    expect(plural(0, 'view')).toBe('0 views');
    expect(plural(2, 'visitor')).toBe('2 visitors');
  });
});

describe('viewsVisitorsLabel', () => {
  it('joins both counts when the payload carries visitors', () => {
    expect(viewsVisitorsLabel(12, 4)).toBe(`12 views${SEP}4 visitors`);
  });

  it('degrades to views alone on a payload that predates the visitor count', () => {
    expect(viewsVisitorsLabel(12)).toBe('12 views');
    expect(viewsVisitorsLabel(12, null)).toBe('12 views');
  });

  it('keeps a real zero rather than treating it as absent', () => {
    expect(viewsVisitorsLabel(3, 0)).toBe(`3 views${SEP}0 visitors`);
  });
});

describe('networkLines', () => {
  const networks = [
    { name: 'Comcast', views: 40 },
    { name: 'Verizon', views: 91 },
    { name: 'AT&T', views: 12 },
    { name: 'Google Fiber', views: 7 },
  ];

  it('orders by views and keeps only the top three', () => {
    expect(networkLines(networks)).toEqual([
      'Verizon (91)',
      'Comcast (40)',
      'AT&T (12)',
    ]);
  });

  it('honours an explicit limit', () => {
    expect(networkLines(networks, 1)).toEqual(['Verizon (91)']);
  });

  it('does not mutate the caller array while sorting', () => {
    const input = [...networks];
    networkLines(input);
    expect(input).toEqual(networks);
  });

  it('returns nothing at all when the section has no data', () => {
    expect(networkLines(undefined)).toEqual([]);
    expect(networkLines(null)).toEqual([]);
    expect(networkLines([])).toEqual([]);
    expect(networkLines([{ name: '', views: 5 }])).toEqual([]);
  });
});

describe('deviceSplitLabel', () => {
  it('renders one line, busiest first', () => {
    expect(deviceSplitLabel([
      { type: 'mobile', views: 30 },
      { type: 'desktop', views: 70 },
    ])).toBe(`desktop 70%${SEP}mobile 30%`);
  });

  it('adds up to 100 even where plain rounding would print 99', () => {
    const label = deviceSplitLabel([
      { type: 'desktop', views: 1 },
      { type: 'mobile', views: 1 },
      { type: 'tablet', views: 1 },
    ]);
    const total = (label ?? '').match(/\d+(?=%)/g)?.reduce((a, b) => a + Number(b), 0);
    expect(total).toBe(100);
  });

  it('drops a share that rounds to zero instead of printing "0%"', () => {
    const label = deviceSplitLabel([
      { type: 'desktop', views: 999 },
      { type: 'tablet', views: 1 },
    ]);
    expect(label).toBe('desktop 100%');
  });

  it('says nothing when there is nothing to split', () => {
    expect(deviceSplitLabel(undefined)).toBeNull();
    expect(deviceSplitLabel(null)).toBeNull();
    expect(deviceSplitLabel([])).toBeNull();
    expect(deviceSplitLabel([{ type: 'desktop', views: 0 }])).toBeNull();
  });

  it('handles a single device without dividing by zero', () => {
    expect(deviceSplitLabel([{ type: 'desktop', views: 5 }])).toBe('desktop 100%');
  });
});

describe('formatLastSeen', () => {
  it('drops an absent or unreadable value so the line can be omitted', () => {
    expect(formatLastSeen(undefined)).toBeNull();
    expect(formatLastSeen(null)).toBeNull();
    expect(formatLastSeen('')).toBeNull();
    expect(formatLastSeen('not a date')).toBeNull();
  });

  it('reads a zone-less timestamp as UTC, not as the viewer local time', () => {
    // The API serializes UTC. Date.parse would read the bare form as LOCAL and
    // shift the reading by the viewer offset, so the two must agree.
    const bare = formatLastSeen('2026-08-30T14:05:00');
    const explicit = formatLastSeen('2026-08-30T14:05:00Z');
    expect(bare).toBe(explicit);
    expect(bare).not.toBeNull();
  });

  it('leaves an explicit offset alone', () => {
    expect(formatLastSeen('2026-08-30T14:05:00+00:00')).toBe(
      formatLastSeen('2026-08-30T14:05:00Z'),
    );
    expect(formatLastSeen('2026-08-30T10:05:00-04:00')).toBe(
      formatLastSeen('2026-08-30T14:05:00Z'),
    );
  });

  it('renders a date-only value rather than mangling it into NaN', () => {
    expect(formatLastSeen('2026-08-30')).not.toBeNull();
  });

  it('reads the exact shape the analytics route sends', () => {
    // `str(datetime)` off a TIMESTAMPTZ column: space separator, six
    // fractional digits, explicit offset. Safari returns NaN for the space
    // form and the ES grammar allows only three fractional digits, so this
    // is the case that actually ships.
    expect(formatLastSeen('2026-08-30 14:05:00.123456+00:00')).toBe(
      formatLastSeen('2026-08-30T14:05:00Z'),
    );
    expect(formatLastSeen('2026-08-30 14:05:00')).toBe(formatLastSeen('2026-08-30T14:05:00Z'));
  });
});

describe('clampCardPosition', () => {
  // Derived from the card constant, not hardcoded, so a re-measured ceiling
  // (190 → 224 on 2026-08-30) cannot silently break placement expectations.
  const box = { width: INTEL_CARD.width * 3, height: INTEL_CARD.height + 120 };

  it('sits just past the click when there is room', () => {
    expect(clampCardPosition(40, 60, box)).toEqual({ left: 52, top: 72 });
  });

  it('flips to the other side of the click near the right or bottom edge', () => {
    const { left, top } = clampCardPosition(600, 290, box);
    expect(left).toBeLessThan(600);
    expect(top).toBeLessThan(290);
  });

  it('never lets the card leave the map box', () => {
    for (let x = -50; x <= box.width + 50; x += 7) {
      for (let y = -50; y <= box.height + 50; y += 7) {
        const { left, top } = clampCardPosition(x, y, box);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(left + INTEL_CARD.width).toBeLessThanOrEqual(box.width);
        expect(top + INTEL_CARD.height).toBeLessThanOrEqual(box.height);
      }
    }
  });

  it('pins to the near edge when the box cannot hold the card at all', () => {
    expect(clampCardPosition(10, 10, { width: 100, height: 80 })).toEqual({ left: 8, top: 8 });
  });

  it('survives a box that has not been measured yet', () => {
    const { left, top } = clampCardPosition(0, 0, { width: 0, height: 0 });
    expect(Number.isFinite(left)).toBe(true);
    expect(Number.isFinite(top)).toBe(true);
  });
});

describe('formatLastSeen year handling', () => {
  it('omits the year for a date in the current year', () => {
    const iso = `${new Date().getFullYear()}-03-15 09:30:00.000000+00:00`;
    const out = formatLastSeen(iso);
    expect(out).not.toBeNull();
    expect(out).not.toContain(`${new Date().getFullYear()}`);
  });

  it('shows the year once it differs, so stale data cannot pass as fresh', () => {
    const out = formatLastSeen('2001-08-30 14:05:00+00:00');
    expect(out).toContain('2001');
  });
});
