// Whether the /viewer guide is shown. A first visit sees it; "Hide the guide"
// is remembered per browser. Same storage rules as viewerMode.ts: try/catch on
// every read and write, and anything that is not one of our two values — or no
// storage at all — means SHOWN, so a private window never hides the rules.

export const GUIDE_KEY = 'cc.viewer.guide';

export interface GuideStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): GuideStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readGuideOpen(storage: GuideStorage | null = defaultStorage()): boolean {
  if (storage == null) return true;
  try {
    return storage.getItem(GUIDE_KEY) !== 'hidden';
  } catch {
    return true;
  }
}

export function writeGuideOpen(open: boolean, storage: GuideStorage | null = defaultStorage()): void {
  if (storage == null) return;
  try {
    storage.setItem(GUIDE_KEY, open ? 'shown' : 'hidden');
  } catch {
    // Quota, private mode, a denied origin: the choice is simply not kept.
  }
}
