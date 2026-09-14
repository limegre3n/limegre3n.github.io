/**
 * E2E for the film dial and the quartz date back (PRD CAMERA-011 / CAMERA-012,
 * CONTRACTS §11).
 *
 * Runs against the real guest page, the real emulator suite and the fake camera
 * device Chromium is launched with (see playwright.config.js). The point of the
 * upload test is the CONTRACT, not the pixels: the bytes stay the clean original
 * and the chosen stock travels as custom metadata, which is observable as the
 * `filter` field the finalize function writes onto `photos/{uuid}`.
 *
 * Assumes the shared fixture: slug `testslug123`, dateStamp true.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStorageRulesLoaded, firestoreGet, EMULATOR_FIRESTORE, PROJECT_ID } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOGUE = JSON.parse(
  readFileSync(path.resolve(HERE, '../../functions/film-stocks.json'), 'utf8'),
);
const STOCKS = CATALOGUE.stocks;
const GOLDEN = STOCKS.find((s) => s.id === 'golden');

const FS_BASE = `http://${EMULATOR_FIRESTORE}/v1/projects/${PROJECT_ID}`
  + '/databases/(default)/documents';
const FS_HEADERS = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

/**
 * Admin-only switch on the SHARED config/event (the guest client may not write it) —
 * always restored in a finally so the fixture stays as seeded.
 */
async function setDateStamp(value) {
  const res = await fetch(`${FS_BASE}/config/event?updateMask.fieldPaths=dateStamp`, {
    method: 'PATCH',
    headers: FS_HEADERS,
    body: JSON.stringify({ fields: { dateStamp: { booleanValue: !!value } } }),
  });
  if (!res.ok) throw new Error(`emulator PATCH config/event → ${res.status} ${await res.text()}`);
}

/**
 * Collects the uuid of every object the page PUTs to the Storage emulator. The
 * upload URL is `…/o?name=uploads/{uid}/{uuid}`, so the shot can be followed all
 * the way to its `photos/{uuid}` doc without the test reaching into the app's
 * modules (Vite hands main.js a cache-busted module URL after an edit, so an
 * imported instance is not guaranteed to be the same one).
 */
function watchUploads(page) {
  const uuids = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().includes(':9199')) return;
    const name = new URL(req.url()).searchParams.get('name') || '';
    const match = /^uploads\/[^/]+\/([0-9a-f-]{36})$/.exec(name);
    if (match) uuids.push(match[1]);
  });
  return uuids;
}

/** Registers the phone if needed and waits for the viewfinder + dial to paint. */
async function openViewfinder(page, nickname) {
  await page.goto('/e/testslug123/');
  await page.waitForSelector('.form input, .film__dial', { timeout: 30_000 });
  const nameInput = page.locator('.form input');
  if (await nameInput.count()) {
    await nameInput.fill(nickname);
    await page.locator('.btn--primary').click();
  }
  await expect(page.locator('#app')).toHaveAttribute('data-state', 'viewfinder', { timeout: 30_000 });
  await expect(page.locator('.film__dial')).toBeVisible();
}

const item = (page, id) => page.locator(`.film__item[data-stock="${id}"]`);

async function selectStock(page, id) {
  await item(page, id).click();
  await expect(item(page, id)).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(700); // let the snap scroll settle, then re-assert
  await expect(item(page, id)).toHaveAttribute('aria-checked', 'true');
}

const storedStock = (page) => page.evaluate(() => localStorage.getItem('wc.filter'));

test.describe('film dial (CAMERA-011)', () => {
  test.beforeAll(assertStorageRulesLoaded);

  test('renders every stock, defaults to clean and remembers the pick across a reload', async ({ page }) => {
    await openViewfinder(page, 'Dial Spinner');

    const items = page.locator('.film__item');
    await expect(items).toHaveCount(STOCKS.length);
    expect(await items.evaluateAll((nodes) => nodes.map((n) => n.dataset.stock)))
      .toEqual(STOCKS.map((s) => s.id));
    await expect(page.locator('.film__dial')).toHaveAttribute('role', 'radiogroup');
    await expect(items.first()).toHaveAttribute('role', 'radio');

    // Fresh phone: clean film is loaded.
    await expect(item(page, 'clean')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.film__title')).toHaveText('Film · Clean');

    await selectStock(page, 'golden');
    await expect(item(page, 'clean')).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('.film__title')).toHaveText('Film · Golden Hour');
    expect(await storedStock(page)).toBe('golden');

    // The roll survives the app being reopened (localStorage `wc.filter`).
    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('data-state', 'viewfinder', { timeout: 30_000 });
    await expect(item(page, 'golden')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.film__title')).toHaveText('Film · Golden Hour');
  });

  test('paints the stock onto the live viewfinder without touching the transform', async ({ page }) => {
    await openViewfinder(page, 'Look Checker');

    const video = page.locator('.vf__video');
    const grain = page.locator('.film-grain');
    const vignette = page.locator('.film-vignette');

    // Clean is literally no processing at all.
    await expect(grain).toBeHidden();
    await expect(vignette).toBeHidden();
    expect(await video.evaluate((v) => v.style.filter)).toBe('');

    await selectStock(page, 'golden');

    // The catalogue's css.filter, as the browser normalises it (".24" → "0.24").
    const applied = await video.evaluate((v) => getComputedStyle(v).filter);
    for (const fn of ['sepia', 'saturate', 'contrast', 'brightness', 'hue-rotate']) {
      expect(applied).toContain(fn);
    }
    expect(applied.replace(/\s+/g, '')).toBe(
      GOLDEN.css.filter.replace(/\s+/g, '').replace(/\(\./g, '(0.'),
    );
    // The zoom control owns `transform` — the film look must never write to it.
    expect(await video.evaluate((v) => v.style.transform)).toBe('');

    await expect(grain).toBeVisible();
    expect(await grain.evaluate((n) => n.style.opacity)).toBe(String(GOLDEN.css.grain));
    await expect(vignette).toBeVisible();
    expect(await vignette.evaluate((n) => n.style.opacity)).toBe(String(GOLDEN.css.vignette));
    // Overlays never steal a tap from the shutter or the dial.
    for (const layer of [grain, vignette]) {
      expect(await layer.evaluate((n) => getComputedStyle(n).pointerEvents)).toBe('none');
    }
  });

  test('a shot taken on golden uploads the clean original tagged with the stock', async ({ page }) => {
    const uploaded = watchUploads(page);
    await openViewfinder(page, 'Golden Shooter');
    await selectStock(page, 'golden');

    // The shutter only arms once the stream is delivering frames.
    await expect(page.locator('#app')).toHaveAttribute('data-camera', 'live', { timeout: 30_000 });
    // `|| 0` folds the UTC browser's -0 into 0 (Object.is(-0, 0) is false).
    const expectedTz = await page.evaluate(() => -new Date().getTimezoneOffset() || 0);

    await page.locator('.shutter').click();
    await expect.poll(() => uploaded.length, { timeout: 60_000, message: 'the shot should upload' })
      .toBeGreaterThan(0);
    const uuid = uploaded[0];

    // The finalize function copies the upload's custom metadata onto the photo doc
    // (CONTRACTS §2/§11), so this one read covers the whole client→server contract.
    await expect.poll(
      async () => (await firestoreGet(`photos/${uuid}`).catch(() => null)) !== null,
      { timeout: 120_000, intervals: [500, 1000, 2000], message: 'photo doc should be written' },
    ).toBe(true);
    const photo = await firestoreGet(`photos/${uuid}`);

    expect(photo.fields.filter.stringValue).toBe('golden');
    expect(Number(photo.fields.tzOffsetMinutes.integerValue)).toBe(expectedTz);
    // The stored object is the untouched original; the developed copy is a second,
    // server-owned artefact — the guest never bakes the look into the JPEG.
    expect(photo.fields.storagePath.stringValue).toBe(`uploads/${photo.fields.deviceUid.stringValue}/${uuid}`);
  });
});

test.describe('date-stamp preview (CAMERA-012)', () => {
  test('prints today in the quartz format and follows config/event.dateStamp', async ({ page }) => {
    await openViewfinder(page, 'Stamp Watcher');

    const stamp = page.locator('.film-stamp');
    await expect(stamp).toBeVisible();
    // Computed in the BROWSER's clock: 'YY M D, no zero padding (CONTRACTS §11).
    const expected = await page.evaluate(() => {
      const d = new Date();
      return `'${String(d.getFullYear() % 100).padStart(2, '0')} ${d.getMonth() + 1} ${d.getDate()}`;
    });
    await expect(stamp).toHaveText(expected);
    expect(expected).toMatch(/^'\d{2} \d{1,2} \d{1,2}$/);

    try {
      await setDateStamp(false);
      await expect(stamp).toBeHidden({ timeout: 30_000 });
      await setDateStamp(true);
      await expect(stamp).toBeVisible({ timeout: 30_000 });
      await expect(stamp).toHaveText(expected);
    } finally {
      await setDateStamp(true); // the fixture ships with the stamp on
    }
  });
});
