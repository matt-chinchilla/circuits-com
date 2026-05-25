import { adminApi } from '@admin/services/adminApi';

const KEYS = {
  supplier: 'wiz-demo-supplier',
  part: 'wiz-demo-part',
} as const;

type EntityKind = keyof typeof KEYS;

export function trackDemoEntity(kind: EntityKind, id: string): void {
  localStorage.setItem(KEYS[kind], id);
}

export function clearDemoEntity(kind: EntityKind): void {
  localStorage.removeItem(KEYS[kind]);
}

export function getTrackedDemoEntity(kind: EntityKind): string | null {
  return localStorage.getItem(KEYS[kind]);
}

export async function cleanupDemoEntity(kind: EntityKind): Promise<void> {
  const id = getTrackedDemoEntity(kind);
  if (!id) return;
  try {
    if (kind === 'supplier') {
      await adminApi.deleteSupplier(id);
    } else {
      await adminApi.deletePart(id);
    }
  } catch {
    // 404 = already deleted, 401 = not logged in — both fine.
  }
  clearDemoEntity(kind);
}

export async function cleanupAllDemoEntities(): Promise<void> {
  await Promise.allSettled([
    cleanupDemoEntity('supplier'),
    cleanupDemoEntity('part'),
  ]);
}
