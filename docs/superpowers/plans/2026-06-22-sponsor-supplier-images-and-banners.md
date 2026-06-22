# Sponsor/Supplier Image Uploads + Gold Copy + Silver Banner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins upload (not just paste-URL) a photo/icon for sponsorships and suppliers, stored as base64 data-URLs in the DB; surface the supplier logo across all sponsor boards; add a "Visit Website" mention to the empty Gold ad; add a "Preferred Partners" floating pill to the Silver board.

**Architecture:** Image bytes live as `data:image/...;base64,...` strings in the DB (columns widened `String(500)→Text`), produced by a client-side canvas downscale (256px / WebP). A shared `ImageUploadField` (admin) drives both forms; a shared `safeImageUrl` guard sanitizes every logo render site. No upload endpoint, no object storage (the API container has no volume mount).

**Tech Stack:** FastAPI + SQLAlchemy + Alembic (Postgres prod / SQLite tests) · React 19 + TypeScript + Vite + SCSS Modules · pytest · vitest.

## Global Constraints

- **No Co-Authored-By lines in commits** (project rule).
- **Branch:** work on `updates`. Do not touch `master`.
- **Storage = base64 data-URL in DB.** No file-upload endpoint, no disk/S3.
- **Frontend boundaries:** `ImageUploadField` + `image.ts` live in `@admin/` (both consumers are admin). `safeImageUrl` lives in `@shared/utils/url.ts` (public render consumers). admin ↛ public, public ↛ admin.
- **Type-gate is `npx tsc -b` / `npm run build`**, NOT `tsc --noEmit` (a no-op here).
- **JSX glyphs:** use HTML entities / JS expressions, never raw non-ASCII (`&rarr;`, `&#9670;`, `{'→'}`).
- **`safeHttpUrl` stays on `website` only**; logos use `safeImageUrl` (data-URLs would be rejected by `safeHttpUrl`).
- **Tests use SQLite** (`Base.metadata.create_all`) — assert column contracts on table metadata, not via DB length enforcement.
- **Empty SCSS rule → undefined class**; every new selector needs ≥1 declaration.
- Run `cd api && pytest tests/ -q` and `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test` as the gates.

---

### Task 1: Widen image columns to `Text` (migration 017 + models)

**Files:**
- Modify: `api/app/models/sponsor.py:28` (`image_url`)
- Modify: `api/app/models/supplier.py:21` (`logo_url`)
- Create: `api/alembic/versions/017_widen_image_columns_to_text.py`
- Test: `api/tests/test_image_column_widening.py`

**Interfaces:**
- Produces: `Sponsor.image_url` and `Supplier.logo_url` as `Text` columns (no length cap) — Tasks 2 & 6 store base64 data-URLs there.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_image_column_widening.py
"""Image columns must hold base64 data-URLs (no 500-char cap).

SQLite ignores String(N) length, so a length-based DB test can't catch the
regression — assert the SQLAlchemy column TYPE is Text (length is None) and
prove a long value round-trips through the ORM.
"""
import uuid

from sqlalchemy import Text

from app.models import Sponsor, Supplier


def test_sponsor_image_url_is_text():
    col = Sponsor.__table__.c.image_url
    assert isinstance(col.type, Text)
    assert getattr(col.type, "length", None) is None


def test_supplier_logo_url_is_text():
    col = Supplier.__table__.c.logo_url
    assert isinstance(col.type, Text)
    assert getattr(col.type, "length", None) is None


def test_long_data_url_round_trips(db):
    big = "data:image/webp;base64," + ("A" * 4000)
    sup = Supplier(id=uuid.uuid4(), name="LogoCo", logo_url=big)
    db.add(sup)
    db.flush()
    db.refresh(sup)
    assert sup.logo_url == big
    assert len(sup.logo_url) > 500
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_image_column_widening.py -q`
Expected: FAIL — `image_url`/`logo_url` are `String(500)`, not `Text` (assertion error on `isinstance`).

- [ ] **Step 3: Widen the model columns**

In `api/app/models/sponsor.py`, ensure `Text` is imported from `sqlalchemy` and change line 28:
```python
image_url = Column(Text, nullable=True)
```
In `api/app/models/supplier.py`, ensure `Text` is imported and change line 21:
```python
logo_url = Column(Text, nullable=True)
```

- [ ] **Step 4: Write the migration**

```python
# api/alembic/versions/017_widen_image_columns_to_text.py
"""widen image columns to text

Revision ID: 017
Revises: 016
Create Date: 2026-06-22

Base64 data-URLs (uploaded logos/icons) exceed the old String(500) cap.
varchar(500)->text is a metadata-only, non-destructive widening on Postgres.
"""

from alembic import op
import sqlalchemy as sa

revision = "017"
down_revision = "016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "sponsors", "image_url",
        existing_type=sa.String(length=500), type_=sa.Text(), existing_nullable=True,
    )
    op.alter_column(
        "suppliers", "logo_url",
        existing_type=sa.String(length=500), type_=sa.Text(), existing_nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "suppliers", "logo_url",
        existing_type=sa.Text(), type_=sa.String(length=500), existing_nullable=True,
    )
    op.alter_column(
        "sponsors", "image_url",
        existing_type=sa.Text(), type_=sa.String(length=500), existing_nullable=True,
    )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && pytest tests/test_image_column_widening.py -q`
Expected: PASS (3 tests).

- [ ] **Step 6: Confirm the migration chain is linear**

Run: `cd api && alembic heads`
Expected: a single head — `017 (head)`.

- [ ] **Step 7: Commit**

```bash
git add api/app/models/sponsor.py api/app/models/supplier.py \
  api/alembic/versions/017_widen_image_columns_to_text.py \
  api/tests/test_image_column_widening.py
git commit -m "feat(db): widen sponsor.image_url + supplier.logo_url to Text (migration 017)"
```

---

### Task 2: Wire `logo_url` through supplier create/update

**Files:**
- Modify: `api/app/routes/suppliers.py` — `SupplierCreate` (`:33`), `SupplierUpdate` (`:46`), `create_supplier` (`:107`)
- Test: `api/tests/test_supplier_logo_url.py`

**Interfaces:**
- Consumes: nothing new (`supplier_to_dict` already returns `logo_url`; `update_supplier` already does `setattr` over `model_dump(exclude_unset=True)`).
- Produces: `POST/PUT /api/suppliers` accept + persist `logo_url`; `GET` returns it — the admin supplier form (Task 7) relies on this.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_supplier_logo_url.py
"""Admins can set a supplier's logo_url (a data-URL or http URL) on create/edit."""


def _auth(client):
    token = client.post(
        "/api/auth/login", json={"username": "admin", "password": "testpass123"}
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_create_supplier_persists_logo_url(client, seeded_db):
    headers = _auth(client)
    data_url = "data:image/webp;base64," + ("A" * 3000)
    r = client.post(
        "/api/suppliers/",
        json={"name": "PixelParts", "logo_url": data_url},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    sid = r.json()["id"]
    got = client.get(f"/api/suppliers/{sid}")
    assert got.status_code == 200
    assert got.json()["logo_url"] == data_url


def test_update_supplier_sets_logo_url(client, seeded_db):
    headers = _auth(client)
    created = client.post(
        "/api/suppliers/", json={"name": "NoLogo Inc"}, headers=headers
    ).json()
    assert created["logo_url"] is None
    r = client.put(
        f"/api/suppliers/{created['id']}",
        json={"logo_url": "https://cdn.example.com/logo.png"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["logo_url"] == "https://cdn.example.com/logo.png"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_supplier_logo_url.py -q`
Expected: FAIL — `SupplierCreate` ignores the unknown `logo_url` (Pydantic drops it), so the create test's `logo_url` comes back `None`.

- [ ] **Step 3: Add `logo_url` to the schemas + create handler**

In `api/app/routes/suppliers.py`, add to `SupplierCreate` (after `description`, line ~43):
```python
    logo_url: str | None = None
```
Add to `SupplierUpdate` (after `description`, line ~54):
```python
    logo_url: str | None = None
```
Add to the `Supplier(...)` ctor in `create_supplier` (after `description=body.description,`, line ~116):
```python
        logo_url=body.logo_url,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && pytest tests/test_supplier_logo_url.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full API suite (no regressions)**

Run: `cd api && pytest tests/ -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add api/app/routes/suppliers.py api/tests/test_supplier_logo_url.py
git commit -m "feat(api): accept logo_url on supplier create/update"
```

---

### Task 3: `safeImageUrl` guard (shared)

**Files:**
- Modify: `frontend/src/shared/utils/url.ts`
- Test: `frontend/src/shared/utils/url.test.ts` (extend existing)

**Interfaces:**
- Produces: `export function safeImageUrl(input: string | null | undefined): string | null` — returns a safe `http(s)` URL or a raster `data:image/*;base64` URL, else `null`. Consumed by every logo render site (Task 9).

- [ ] **Step 1: Write the failing test (extend the existing file)**

```typescript
// append to frontend/src/shared/utils/url.test.ts
import { safeImageUrl } from './url';

describe('safeImageUrl', () => {
  it('allows http and https URLs', () => {
    expect(safeImageUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(safeImageUrl('http://example.com/a.jpg')).toBe('http://example.com/a.jpg');
  });
  it('allows raster data-image URLs', () => {
    const d = 'data:image/webp;base64,AAAA';
    expect(safeImageUrl(d)).toBe(d);
    expect(safeImageUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(safeImageUrl('data:image/jpeg;base64,AAAA')).toBe('data:image/jpeg;base64,AAAA');
  });
  it('rejects script and html data URLs', () => {
    expect(safeImageUrl('javascript:alert(1)')).toBeNull();
    expect(safeImageUrl('data:text/html;base64,AAAA')).toBeNull();
    expect(safeImageUrl('data:image/svg+xml;base64,AAAA')).toBeNull();
  });
  it('returns null for empty/garbage', () => {
    expect(safeImageUrl('')).toBeNull();
    expect(safeImageUrl(null)).toBeNull();
    expect(safeImageUrl('not a url')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- url.test.ts`
Expected: FAIL — `safeImageUrl` is not exported.

- [ ] **Step 3: Implement `safeImageUrl`**

Append to `frontend/src/shared/utils/url.ts`:
```typescript
// Raster image data-URLs we trust to render in <img src>. SVG is excluded —
// it can carry inline script. http(s) URLs are validated by URL parsing.
const RASTER_DATA_IMAGE = /^data:image\/(png|jpe?g|webp|gif|avif);base64,/i;

/**
 * Sanitize a value destined for an <img src>. Allows http(s) URLs and raster
 * base64 data-URLs; rejects javascript:, data:text/html, data:image/svg+xml,
 * and anything unparseable. NOTE: distinct from safeHttpUrl — that rejects
 * data: URLs, so logos (which may be data-URLs) must use THIS function.
 */
export function safeImageUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (RASTER_DATA_IMAGE.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- url.test.ts`
Expected: PASS (existing `safeHttpUrl` tests + the new `safeImageUrl` block).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/shared/utils/url.ts frontend/src/shared/utils/url.test.ts
git commit -m "feat(shared): safeImageUrl guard for logo src (allows data:image raster)"
```

---

### Task 4: `fileToDataUrl` client-side downscale util (admin)

**Files:**
- Create: `frontend/src/admin/utils/image.ts`
- Test: `frontend/src/admin/utils/image.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface ImageEncodeResult { ok: true; dataUrl: string } | { ok: false; error: string }
  export const MAX_DATA_URL_BYTES = 64000;
  export function fileToDataUrl(file: File, maxEdge?: number): Promise<ImageEncodeResult>;
  ```
  Consumed by `ImageUploadField` (Task 5).

- [ ] **Step 1: Write the failing test**

Canvas encoding isn't available in happy-dom, so the test targets the *guard* logic (MIME + size) which runs before any canvas call. The util must reject non-images before touching the canvas.

```typescript
// frontend/src/admin/utils/image.test.ts
import { describe, it, expect } from 'vitest';
import { fileToDataUrl } from './image';

function fakeFile(type: string, bytes = 10): File {
  return new File([new Uint8Array(bytes)], 'x', { type });
}

describe('fileToDataUrl', () => {
  it('rejects a non-image file before encoding', async () => {
    const r = await fileToDataUrl(fakeFile('application/pdf'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/image/i);
  });

  it('rejects an empty file', async () => {
    const r = await fileToDataUrl(fakeFile('image/png', 0));
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- image.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `fileToDataUrl`**

```typescript
// frontend/src/admin/utils/image.ts
// Client-side image normalizer: downscale to a bounded raster data-URL so a
// logo/icon can be stored inline in the DB (no upload endpoint). WebP first,
// JPEG fallback. Pure async — no React. Caller stores the returned data-URL.

export type ImageEncodeResult = { ok: true; dataUrl: string } | { ok: false; error: string };

/** Hard ceiling on the encoded string; keeps /partners responses lean. */
export const MAX_DATA_URL_BYTES = 64000;
const DEFAULT_MAX_EDGE = 256;

function loadImage(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = objectUrl;
  });
}

export async function fileToDataUrl(
  file: File,
  maxEdge: number = DEFAULT_MAX_EDGE,
): Promise<ImageEncodeResult> {
  if (!file.type.startsWith('image/')) {
    return { ok: false, error: 'Please choose an image file (PNG, JPG, WebP, GIF).' };
  }
  if (file.size === 0) {
    return { ok: false, error: 'That file is empty.' };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return { ok: false, error: 'Could not read that image.' };

    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, error: 'Image processing is unavailable in this browser.' };
    ctx.drawImage(img, 0, 0, cw, ch);

    // Prefer WebP; fall back to JPEG if the browser can't encode WebP
    // (toDataURL silently returns a PNG instead — detect via the prefix).
    let dataUrl = canvas.toDataURL('image/webp', 0.82);
    if (!dataUrl.startsWith('data:image/webp')) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    }

    if (dataUrl.length > MAX_DATA_URL_BYTES) {
      return { ok: false, error: 'That image is too detailed — try a smaller or simpler logo.' };
    }
    return { ok: true, dataUrl };
  } catch {
    return { ok: false, error: 'Could not process that image.' };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- image.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/admin/utils/image.ts frontend/src/admin/utils/image.test.ts
git commit -m "feat(admin): fileToDataUrl — client-side downscale to bounded data-URL"
```

---

### Task 5: `ImageUploadField` reusable control (admin)

**Files:**
- Create: `frontend/src/admin/components/ImageUploadField.tsx`
- Create: `frontend/src/admin/components/ImageUploadField.module.scss`

**Interfaces:**
- Consumes: `fileToDataUrl` (Task 4), `safeImageUrl` (Task 3) for preview safety.
- Produces:
  ```typescript
  interface ImageUploadFieldProps {
    id: string; label: string; value: string;
    onChange: (next: string) => void; hint?: string;
  }
  export default function ImageUploadField(props: ImageUploadFieldProps): ReactElement
  ```
  Consumed by the sponsor form (Task 6) + supplier form (Task 7).

- [ ] **Step 1: Implement the component**

(UI control — verified visually in Task 12, not unit-tested. Build it complete.)

```tsx
// frontend/src/admin/components/ImageUploadField.tsx
import { useId, useRef, useState, type ReactElement } from 'react';
import { fileToDataUrl } from '@admin/utils/image';
import { safeImageUrl } from '@shared/utils/url';
import styles from './ImageUploadField.module.scss';

interface ImageUploadFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
}

// Dual-path image input: upload a file (downscaled to a data-URL) OR paste a
// hosted URL. Both write the same `value`. The preview uses safeImageUrl so a
// hostile pasted string never reaches an <img src> here either.
export default function ImageUploadField({
  id, label, value, onChange, hint,
}: ImageUploadFieldProps): ReactElement {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errId = useId();
  const safePreview = safeImageUrl(value);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    const result = await fileToDataUrl(file);
    setBusy(false);
    if (result.ok) onChange(result.dataUrl);
    else setError(result.error);
    if (fileRef.current) fileRef.current.value = ''; // allow re-picking the same file
  }

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <div className={styles.row}>
        <div className={styles.previewBox} aria-hidden={!safePreview}>
          {safePreview ? (
            <img className={styles.preview} src={safePreview} alt={`${label} preview`} />
          ) : (
            <span className={styles.previewEmpty}>No image</span>
          )}
        </div>
        <div className={styles.controls}>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className={styles.fileInput}
            onChange={(e) => onPick(e.target.files?.[0])}
          />
          <div className={styles.btnRow}>
            <button
              type="button"
              className={styles.uploadBtn}
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              {busy ? 'Processing…' : value ? 'Replace image' : 'Upload image'}
            </button>
            {value && (
              <button
                type="button"
                className={styles.clearBtn}
                onClick={() => { setError(null); onChange(''); }}
              >
                Clear
              </button>
            )}
          </div>
          <input
            id={id}
            type="text"
            inputMode="url"
            className={styles.urlInput}
            value={value.startsWith('data:') ? '' : value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="…or paste an image URL"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={error ? errId : undefined}
          />
        </div>
      </div>
      {hint && !error && <div className={styles.hint}>{hint}</div>}
      {error && <div className={styles.error} id={errId} role="alert">{error}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Add styles**

```scss
// frontend/src/admin/components/ImageUploadField.module.scss
.field { display: flex; flex-direction: column; gap: 8px; }
.label { font-size: 0.82rem; font-weight: 600; color: var(--a-text, #1f2733); }
.row { display: flex; gap: 14px; align-items: flex-start; }
.previewBox {
  flex: 0 0 auto; width: 72px; height: 72px; border-radius: 10px;
  border: 1px dashed rgba(0, 0, 0, 0.18); background: #f4f6f9;
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.preview { width: 100%; height: 100%; object-fit: contain; }
.previewEmpty { font-size: 0.62rem; color: #8a93a0; text-transform: uppercase; letter-spacing: 0.06em; }
.controls { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.fileInput { display: none; }
.btnRow { display: flex; gap: 8px; }
.uploadBtn, .clearBtn {
  font-size: 0.8rem; font-weight: 600; line-height: 1; padding: 9px 14px;
  border-radius: 8px; cursor: pointer; border: 1px solid transparent;
}
.uploadBtn { background: var(--a-blue, #2f6df0); color: #fff; }
.uploadBtn:disabled { opacity: 0.6; cursor: default; }
.clearBtn { background: transparent; border-color: rgba(0, 0, 0, 0.16); color: #4a5562; }
.urlInput {
  width: 100%; font-size: 0.84rem; padding: 9px 11px; border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.16); font-family: ui-monospace, monospace;
}
.hint { font-size: 0.74rem; color: #6b7480; }
.error { font-size: 0.76rem; color: var(--error-red, #c0392b); font-weight: 600; }
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/admin/components/ImageUploadField.tsx \
  frontend/src/admin/components/ImageUploadField.module.scss
git commit -m "feat(admin): reusable ImageUploadField (upload-or-paste, safe preview)"
```

---

### Task 6: Sponsor form uses `ImageUploadField`

**Files:**
- Modify: `frontend/src/admin/pages/sponsors/form/index.tsx` (the Creative-panel `image_url` input, lines ~674–689)

**Interfaces:**
- Consumes: `ImageUploadField` (Task 5). `form.image_url` + `update('image_url', …)` already exist.

- [ ] **Step 1: Replace the text input with the field**

Add the import near the other admin imports:
```tsx
import ImageUploadField from '@admin/components/ImageUploadField';
```
Replace the `<input id="image_url" … />` block (and its surrounding `<label>` if separate) with:
```tsx
<ImageUploadField
  id="image_url"
  label="Sponsor image / logo"
  value={form.image_url}
  onChange={(v) => update('image_url', v)}
  hint="Upload a logo/icon or paste an image URL. Shown on the sponsor board."
/>
```

- [ ] **Step 2: Type-check + lint**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/`
Expected: clean (exit 0).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/admin/pages/sponsors/form/index.tsx
git commit -m "feat(admin): upload-or-paste sponsor image via ImageUploadField"
```

---

### Task 7: Supplier form gains a logo field

**Files:**
- Modify: `frontend/src/admin/pages/suppliers/form/index.tsx` — `FormData` (`:13`), `emptyForm` (`:29`), hydrate (`:91`), submit payload (`:131`), Identity panel JSX (`:249`)

**Interfaces:**
- Consumes: `ImageUploadField` (Task 5); `adminApi.createSupplier/updateSupplier` already pass arbitrary payload fields; backend accepts `logo_url` (Task 2).

- [ ] **Step 1: Add `logo_url` to form state**

Add the import:
```tsx
import ImageUploadField from '@admin/components/ImageUploadField';
```
Add to the `FormData` interface (after `coverage_hours`):
```tsx
  logo_url: string;
```
Add to `emptyForm()` return (after `coverage_hours: ''`):
```tsx
    logo_url: '',
```
Add to the hydrate `setForm({...})` block (after `coverage_hours: s.coverage_hours ?? ''`):
```tsx
          logo_url: s.logo_url ?? '',
```
Add to the `payload` in `handleSubmit` (after `coverage_hours: ...`):
```tsx
        logo_url: form.logo_url.trim() || null,
```

- [ ] **Step 2: Render the field in the Identity panel**

Inside the Identity `<div className={styles.panelBody}>`, after the description `<div className={styles.field} data-field="description">…</div>` block, add:
```tsx
            <div className={styles.field} data-field="logo_url">
              <ImageUploadField
                id="sup-logo"
                label="Logo / photo"
                value={form.logo_url}
                onChange={(v) => set('logo_url', v)}
                hint="Shown on supplier cards and as the company logo on sponsor boards."
              />
            </div>
```

- [ ] **Step 3: Type-check + lint**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/admin/pages/suppliers/form/index.tsx
git commit -m "feat(admin): supplier logo upload field (create + edit)"
```

---

### Task 8: Supplier logo thumbnail in admin list + detail

**Files:**
- Modify: `frontend/src/admin/pages/suppliers/list/index.tsx` (card avatar, lines ~161–187)
- Modify: `frontend/src/admin/pages/suppliers/detail/index.tsx` (header, lines ~200–230)

**Interfaces:**
- Consumes: `supplier.logo_url` (already on `AdminSupplier`), `safeImageUrl` (Task 3).

- [ ] **Step 1: Render the logo with lettermark fallback (list)**

In the list card, where `lettermark(supplier.name)` is rendered as the avatar, gate on a safe logo. Add `import { safeImageUrl } from '@shared/utils/url';` then replace the avatar node with:
```tsx
{safeImageUrl(supplier.logo_url) ? (
  <img
    className={styles.avatarImg}
    src={safeImageUrl(supplier.logo_url) as string}
    alt=""
  />
) : (
  <span className={styles.avatar}>{lettermark(supplier.name)}</span>
)}
```
Add a `.avatarImg` rule to the list's SCSS module mirroring `.avatar` dimensions with `object-fit: contain; background: #f4f6f9;`.

- [ ] **Step 2: Render the logo in the detail header**

Mirror the same pattern in `detail/index.tsx` wherever the supplier name/lettermark header is. Add `safeImageUrl` import + an `<img>`/fallback and a matching SCSS rule.

- [ ] **Step 3: Type-check + lint + build**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/admin/pages/suppliers/list/index.tsx \
  frontend/src/admin/pages/suppliers/detail/index.tsx \
  frontend/src/admin/pages/suppliers/list/*.module.scss \
  frontend/src/admin/pages/suppliers/detail/*.module.scss
git commit -m "feat(admin): show supplier logo thumbnail in list + detail"
```

---

### Task 9: Sanitize + extend logo rendering on public boards

**Files:**
- Modify: `frontend/src/public/pages/category/components/CategorySponsor.tsx` (Platinum `logo` map `:339`, `CsLogo`)
- Modify: `frontend/src/public/pages/category/components/SponsorBlock.tsx` (Gold `SbLogo` use `:526`)
- Modify: `frontend/src/public/pages/category/components/SilverPartners.tsx` (Silver chip avatar)
- Modify: `frontend/src/public/types/sponsor.ts` (ensure the Gold sponsor type carries `logo_url`)

**Interfaces:**
- Consumes: `safeImageUrl` (Task 3); the board dict already provides `image_url` + `logo_url` for all tiers.

- [ ] **Step 1: Verify the Gold sponsor TS type has `logo_url`**

Run: `grep -n "logo_url" frontend/src/public/types/sponsor.ts`
If the Gold sponsor shape (the type `SponsorBlock` consumes) lacks `logo_url`, add `logo_url?: string | null;` to it.

- [ ] **Step 2: Platinum — route the existing fallback through `safeImageUrl`**

In `CategorySponsor.tsx`, add `import { safeImageUrl } from '@shared/utils/url';` (if absent) and change the logo map (line ~339):
```tsx
logo: safeImageUrl(sponsor.image_url ?? sponsor.logo_url),
```
(`CsLogo`'s `broken` state + lettermark already handle `null`/load failure; ensure `s.logo` being `null` renders the lettermark — guard `CsLogo` to treat a falsy `src` as broken, matching `SbLogo`.)

- [ ] **Step 3: Gold — add the supplier-logo fallback + sanitize**

In `SponsorBlock.tsx`, add the `safeImageUrl` import and change the `SbLogo` usage (line ~526):
```tsx
<SbLogo src={safeImageUrl(sponsor.image_url ?? sponsor.logo_url)} name={sponsor.supplier_name} />
```

- [ ] **Step 4: Silver — render the supplier logo avatar when present**

In `SilverPartners.tsx`, in `SvChip` where `s.lettermark` is rendered inside `<span className="svp-mark">`, add `import { safeImageUrl } from '@shared/utils/url';` and render:
```tsx
{safeImageUrl(s.logo_url) ? (
  <img className="svp-markimg" src={safeImageUrl(s.logo_url) as string} alt="" />
) : (
  <span className="svp-mark">{s.lettermark}</span>
)}
```
Add a `.svp-markimg` rule in `silverPartners.scss` matching `.svp-mark` box size with `object-fit: contain; border-radius: 6px;`.

- [ ] **Step 5: Type-check + lint + unit tests**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test`
Expected: clean + green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/public/pages/category/components/CategorySponsor.tsx \
  frontend/src/public/pages/category/components/SponsorBlock.tsx \
  frontend/src/public/pages/category/components/SilverPartners.tsx \
  frontend/src/public/pages/category/components/silverPartners.scss \
  frontend/src/public/types/sponsor.ts
git commit -m "feat(public): supplier-logo fallback on Gold/Silver + safeImageUrl on all logos"
```

---

### Task 10: Gold empty-ad copy mentions "Visit Website"

**Files:**
- Modify: `frontend/src/public/pages/category/components/SponsorBlock.tsx:504-506`

**Interfaces:** none.

- [ ] **Step 1: Update the copy**

Replace the empty-state `<p className={styles.text}>` body with:
```tsx
        <p className={styles.text}>
          Reach buyers actively browsing this category. Get featured placement
          with your brand, logo, direct contact details, and a &ldquo;Visit
          Website&rdquo; button linking shoppers straight to your store.
        </p>
```
(Final wording confirmed in Task 12's frontend-design pass.)

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc -b`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/public/pages/category/components/SponsorBlock.tsx
git commit -m "copy(gold): empty-ad pitch names the Visit Website direct link"
```

---

### Task 11: Silver "Preferred Partners" floating pill

**Files:**
- Modify: `frontend/src/public/pages/category/components/SilverPartners.tsx` (add the pill in the `.svp` root, before `.svp-rail`)
- Modify: `frontend/src/public/pages/category/components/silverPartners.scss` (add `.svp-badge`; nudge `.svp-headrow` down to clear it)

**Interfaces:** none. Mirror the Platinum `.csb-badge` visual.

- [ ] **Step 1: Add the floating pill to the JSX**

In `SilverPartners.tsx`, inside the `<div className="csb svp" …>` root, after the `<span className="csb-des">CS2 · SILVER-TIER</span>` line and before `<div className="svp-rail">`, add:
```tsx
    <div className="svp-badge" aria-hidden="true">
      <span className="dot"></span>
      <span className="svp-badge-txt">&#9670; Preferred Partners</span>
    </div>
```

- [ ] **Step 2: Style the pill + clear the column labels**

In `silverPartners.scss`, add (reuse the Platinum badge proportions; tokens `--gold`, `--txt-strong`, `--font-mono` are in scope on the board):
```scss
.svp-badge {
  position: absolute;
  top: 11px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 4;
  pointer-events: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid color-mix(in srgb, var(--gold) 32%, transparent);

  .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--gold);
    box-shadow: 0 0 8px color-mix(in srgb, var(--gold) 60%, transparent);
  }
}
.svp-badge-txt {
  font-family: var(--font-mono);
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--txt-strong);
}
```
Then nudge the sticky column-label row down so it clears the pill — find `.svp-headrow` and increase its top offset/padding (it is `position: sticky; top: 0`). Change to:
```scss
.svp-headrow {
  // …existing rules…
  top: 0;
  padding-top: 40px; // clears the floating .svp-badge (pill height + 11px top)
}
```
(Verify the exact current `.svp-headrow` block during edit; only add the top-padding so the first row of labels no longer sits under the pill. Height-matching with Gold is unaffected — Silver is externally sized.)

- [ ] **Step 3: Type-check + lint**

Run: `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/public/pages/category/components/SilverPartners.tsx \
  frontend/src/public/pages/category/components/silverPartners.scss
git commit -m "feat(silver): floating Preferred Partners pill (mirrors Platinum badge)"
```

---

### Task 12: frontend-design balance + chrome-devtools visual/a11y verify

**Files:** iterative tweaks to `SponsorBlock.tsx`, `SilverPartners.tsx`, `silverPartners.scss`, `ImageUploadField.module.scss` as the screenshots dictate.

- [ ] **Step 1: Build the frontend container**

Run: `cd /home/matthew/circuits-com && docker compose up -d --build frontend`
Expected: frontend rebuilt with the new components.

- [ ] **Step 2: Use the `/frontend-design` skill** to refine the Silver pill spacing, the Gold copy length/line-fit, and the `ImageUploadField` layout. Apply the visual-balance review to the category page's tier row at desktop and mobile.

- [ ] **Step 3: chrome-devtools screenshots** of a subcategory page (e.g. a subcategory with a sold Gold + Silver board, and an UNSOLD one for the empty Gold copy) at 1440×900, 900×700, and 430×932. Confirm: Silver pill centered + not overlapping labels; Silver still equal-height to Gold; Gold copy fits without overflow; supplier logos render where set.

- [ ] **Step 4: a11y pass** (`/a11y-debugging`) on `ImageUploadField` in the admin sponsor + supplier forms: label association, keyboard reach to the upload button + URL input, preview `alt`, error `role="alert"`/`aria-live`. Fix any gaps.

- [ ] **Step 5: Commit any visual fixes**

```bash
git add -A && git commit -m "polish(boards): frontend-design balance + a11y for image fields and Silver pill"
```

---

### Task 13: Full verification + simplify + review

- [ ] **Step 1: Backend suite** — `cd api && pytest tests/ -q` → all green.
- [ ] **Step 2: Frontend gates** — `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test` → clean + green.
- [ ] **Step 3: `/simplify`** the diff; run the `pr-review-toolkit:code-simplifier` agent over the changed files.
- [ ] **Step 4: `/code-review` (high)** the full diff; plus parallel `silent-failure-hunter` (the FileReader/canvas + axios paths) and `type-design-analyzer` (the new `ImageEncodeResult` union + `ImageUploadFieldProps`). Fix confirmed findings.
- [ ] **Step 5: `/verification-before-completion`** — confirm every spec requirement maps to a shipped change; manually exercise an upload in the running admin.

## Self-Review (plan vs. spec)

**Spec coverage:** Edit 1 → Tasks 1,5,6. Edit 2 → Tasks 1,2,5,7,8,9. Edit 3 → Task 10. Edit 4 → Task 11. Shared blocks (`safeImageUrl`, `fileToDataUrl`, `ImageUploadField`) → Tasks 3,4,5. Migration → Task 1. Tests → woven per task + Task 13. Visual/a11y → Task 12. No spec requirement is unmapped.

**Type consistency:** `fileToDataUrl(file, maxEdge?) → Promise<ImageEncodeResult>` and `ImageUploadFieldProps {id,label,value,onChange,hint?}` are defined in Tasks 4/5 and consumed unchanged in Tasks 5/6/7. `safeImageUrl(input) → string|null` defined in Task 3, consumed in Tasks 5,8,9. `logo_url` naming consistent across model/schema/dict/TS/form.

**Placeholder scan:** No TBD/TODO; all code steps carry complete code. The only deferred items are *intentional* visual-tuning tweaks gated behind Task 12's screenshots (the working copy/spacing values are present and functional).
