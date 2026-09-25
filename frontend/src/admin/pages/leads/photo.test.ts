import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PHOTO_MAX_CHARS, leadInitials, photoError, photoForSave } from './photo';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('leadInitials', () => {
  it('takes the first and last word of the person', () => {
    expect(leadInitials('Ian Locke', 'FDH Electronics')).toBe('IL');
    expect(leadInitials('Mary Ann de la Cruz', 'X')).toBe('MC');
    expect(leadInitials('  ada  ', 'X')).toBe('A');
  });

  it('falls back to the company for a company-only row', () => {
    expect(leadInitials(null, 'FDH Electronics')).toBe('FE');
    expect(leadInitials('', 'Lumissil')).toBe('L');
  });

  it('leaves a branch in parentheses out of the company', () => {
    expect(leadInitials(null, 'Bisco Industries (Bohemia)')).toBe('BI');
  });

  it('skips punctuation to the first letter or digit of a word', () => {
    expect(leadInitials('"Doc" O\'Neil', 'X')).toBe('DO');
    expect(leadInitials(null, '3M Company')).toBe('3C');
  });

  it('is null when neither name has anything to show', () => {
    expect(leadInitials('- .', '()')).toBeNull();
    expect(leadInitials(null, null)).toBeNull();
  });
});

describe('photoForSave', () => {
  it('trims, and sends null for a cleared field', () => {
    expect(photoForSave(`  ${PNG}  `)).toBe(PNG);
    expect(photoForSave('')).toBeNull();
    expect(photoForSave('   ')).toBeNull();
    expect(photoForSave(null)).toBeNull();
  });
});

describe('photoError — the server allowlist, mirrored', () => {
  it('accepts nothing (that clears the picture), raster data-URLs and http(s)', () => {
    expect(photoError('')).toBeUndefined();
    expect(photoError(PNG)).toBeUndefined();
    expect(photoError('data:image/webp;base64,AAAA')).toBeUndefined();
    expect(photoError('https://cdn.example.com/ada.jpg')).toBeUndefined();
    expect(photoError('http://cdn.example.com/ada.jpg')).toBeUndefined();
  });

  it.each([
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:text/html;base64,PHA+',
    'ftp://example.com/a.png',
    'linkedin.com/in/ada',
    'htt',
  ])('refuses %s', (value) => {
    expect(photoError(value)).toMatch(/image link|upload/i);
  });

  it('refuses a blob past the server cap', () => {
    const huge = `data:image/png;base64,${'A'.repeat(PHOTO_MAX_CHARS)}`;
    expect(photoError(huge)).toMatch(/too large/);
  });

  it('uses the same cap as api/app/utils/image_url.py', () => {
    const py = readFileSync(
      join(__dirname, '..', '..', '..', '..', '..', 'api', 'app', 'utils', 'image_url.py'),
      'utf8',
    );
    const match = py.match(/MAX_IMAGE_URL_LEN = \(?\s*([\d_]+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1].replace(/_/g, ''))).toBe(PHOTO_MAX_CHARS);
  });
});
