/**
 * E2E for the two UI surfaces that guard "no photo is ever lost":
 *
 *  1. Guest terminal cards (workstream ①, GUEST-004 / UPLOAD-005). Uploads keep
 *     draining behind "the camera is closed", so the pending line on that card must
 *     be LIVE — subscribed to queue 'change' — and must say so when there is no
 *     signal, then flip to "all photos sent" once the roll settles.
 *  2. Admin "Deliver pending photos now" (workstream ④, UPLOAD-009 / CONTRACTS §5
 *     `reconcileNow`) — the manual reconciliation sweep.
 *
 * Uses the real emulator suite + the real Vite dev server, like queue.spec.js.
 */
import { test, expect } from '@playwright/test';
import {
  assertStorageRulesLoaded, blockUploads, unblockUploads,
  firestoreGet, EMULATOR_FIRESTORE, PROJECT_ID,
} from './helpers.js';

const FS_BASE = `http://${EMULATOR_FIRESTORE}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const FS_HEADERS = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

/** Admin-only window switch on the SHARED config/event — always restore in a finally. */
async function setEndAt(iso) {
  const res = await fetch(`${FS_BASE}/config/event?updateMask.fieldPaths=endAt`, {
    method: 'PATCH',
    headers: FS_HEADERS,
    body: JSON.stringify({ fields: { endAt: { timestampValue: iso } } }),
  });
  if (!res.ok) throw new Error(`emulator PATCH config/event → ${res.status} ${await res.text()}`);
}

async function readEndAt() {
  const doc = await firestoreGet('config/event');
  return doc.fields.endAt.timestampValue;
}

/**
 * Registers a device out-of-band. firestore.rules only let a client join inside the
 * upload window, and this test deliberately runs with the window closed (the whole
 * point: a registered phone still delivers its film afterwards, GUEST-004).
 */
async function createDevice(uid, nickname, snaps = 10) {
  const now = new Date().toISOString();
  const res = await fetch(`${FS_BASE}/devices?documentId=${encodeURIComponent(uid)}`, {
    method: 'POST',
    headers: FS_HEADERS,
    body: JSON.stringify({
      fields: {
        nickname: { stringValue: nickname },
        snapsRemaining: { integerValue: String(snaps) },
        snapsGranted: { integerValue: '0' },
        createdAt: { timestampValue: now },
        lastSeenAt: { timestampValue: now },
        consentShownAt: { timestampValue: now },
      },
    }),
  });
  if (!res.ok) throw new Error(`emulator POST devices/${uid} → ${res.status} ${await res.text()}`);
}

/**
 * Exposes the guest page's OWN module instances (same URLs Vite hands main.js, so
 * the same module registry entries) — the test drives the very queue the guest UI
 * is subscribed to, without the guest app having to export anything for tests.
 */
function exposeGuestModules() {
  window.__t = { ready: false };
  window.__t.loading = Promise.all([
    import('/src/lib/firebase.js'),
    import('/src/guest/queue.js'),
  ]).then(([fb, q]) => {
    window.__t.auth = fb.auth;
    window.__t.queue = q.queue;
    window.__t.ready = true;
  }).catch((err) => { window.__t.error = String(err); });
}

const waitForUid = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const deadline = Date.now() + 20_000;
  const tick = () => {
    if (window.__t?.error) { reject(new Error(window.__t.error)); return; }
    const uid = window.__t?.auth?.currentUser?.uid;
    if (uid) { resolve(uid); return; }
    if (Date.now() > deadline) { reject(new Error('anonymous sign-in timed out')); return; }
    setTimeout(tick, 100);
  };
  tick();
}));

/** Enqueues a real canvas-encoded JPEG into the page's live queue instance. */
const shootOne = (page) => page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#c8a15a';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#3b2a12';
  ctx.fillRect(8, 8, 24, 24);
  const blob = await new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.8);
  });
  return window.__t.queue.enqueue(blob, Date.now());
});

test.describe('guest terminal card (GUEST-004 / UPLOAD-005)', () => {
  test.beforeAll(assertStorageRulesLoaded);

  test('the "camera closed" card keeps the pending count live and settles to "all sent"', async ({ page, context }) => {
    const originalEndAt = await readEndAt();
    try {
      // Close the upload window: guests see "camera closed" while their queued film
      // is still legitimately accepted for 7 days (CONTRACTS §5).
      await setEndAt(new Date(Date.now() - 10 * 60 * 1000).toISOString());

      await page.addInitScript(exposeGuestModules);
      await blockUploads(page); // hold the item pending while we watch the card
      await page.goto('/e/testslug123/');

      const app = page.locator('#app');
      await expect(app).toHaveAttribute('data-state', 'ended', { timeout: 30_000 });

      const status = page.locator('.status-line');
      const offlineHint = page.locator('.notice');
      // Card rendered with an empty roll: no pending line, no false "all sent".
      await expect(status).toHaveText('');
      await expect(offlineHint).toBeHidden();

      const uid = await waitForUid(page);
      await createDevice(uid, 'Closed Camera');

      // …a photo enters the queue while the terminal card is already on screen.
      await shootOne(page);
      await expect(status).toContainText('1 photo still sending', { timeout: 20_000 });

      // Offline hint on the same card.
      await context.setOffline(true);
      await expect(status).toContainText('1 photo waiting for signal', { timeout: 20_000 });
      await expect(offlineHint).toBeVisible();
      await expect(offlineHint).toContainText('will send when signal returns');
      await context.setOffline(false);
      await expect(offlineHint).toBeHidden({ timeout: 20_000 });

      // Let it upload: the verdict arrives behind the closed-camera card and the
      // live line flips to "all sent" without a re-render or reload.
      await unblockUploads(page);
      await expect(status).toHaveText('All photos sent. ✓', { timeout: 120_000 });
      await expect(app).toHaveAttribute('data-state', 'ended'); // still the same card
    } finally {
      await setEndAt(originalEndAt);
    }
  });
});

test.describe('admin recovery sweep (UPLOAD-009)', () => {
  test('“Deliver pending photos now” runs reconcileNow and reports the sweep', async ({ page }) => {
    await page.goto('/admin/');
    await page.fill('#login-email', 'admin@test.dev');
    await page.fill('#login-password', 'testpass123');
    await page.click('#login-submit');

    const btn = page.locator('#reconcile-btn');
    await expect(btn).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#reconcile-note'))
      .toContainText('Photos normally arrive automatically');

    await btn.click();
    await expect(page.locator('.toast')).toContainText('Checked', { timeout: 60_000 });
    await expect(page.locator('.toast').first()).not.toHaveClass(/bad/);
    // Button returns to its resting state (no stuck loading label).
    await expect(btn).toBeEnabled({ timeout: 60_000 });
    await expect(btn).toHaveText('Deliver pending photos now');
  });
});
