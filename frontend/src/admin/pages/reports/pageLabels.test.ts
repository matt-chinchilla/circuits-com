import { describe, it, expect } from 'vitest';
import { pageLabel, pageUrl } from './pageLabels';

describe('pageUrl', () => {
  it('turns the bare root into a real URL, which is the whole point', () => {
    expect(pageUrl('/', 'https://circuitcenter.ai')).toBe('https://circuitcenter.ai/');
  });

  it('keeps deeper paths intact under the origin', () => {
    expect(pageUrl('/category/power-management-ics-pmics', 'https://circuitcenter.ai')).toBe(
      'https://circuitcenter.ai/category/power-management-ics-pmics',
    );
  });

  it('tolerates a stored path that lost its leading slash', () => {
    expect(pageUrl('about', 'https://circuitcenter.ai')).toBe('https://circuitcenter.ai/about');
  });

  it('says nothing rather than something wrong when there is no page', () => {
    expect(pageUrl(undefined)).toBe('—');
  });
});

describe('pageLabel', () => {
  it('drops the leading slash every row would otherwise repeat', () => {
    expect(pageLabel('/category/power-management-ics-pmics')).toBe(
      'category/power-management-ics-pmics',
    );
  });

  it('names the root instead of rendering an empty cell', () => {
    // "/" with its slash stripped is "", which reads as a bug rather than as
    // the busiest page on the site.
    expect(pageLabel('/')).toBe('home');
  });

  it('survives a doubled or missing slash', () => {
    expect(pageLabel('//bom')).toBe('bom');
    expect(pageLabel('bom')).toBe('bom');
  });

  it('says nothing rather than something wrong when there is no page', () => {
    expect(pageLabel(undefined)).toBe('—');
  });
});
