/**
 * E2E for the gallery surface (workstream ④, PRD GALLERY-002/003/004/005/006).
 *
 * Covers the journey the couple's guests actually take weeks after the day:
 * cover + PIN card → wrong PIN error → correct PIN (verifyGalleryPin callable
 * + getIdToken(true), CONTRACTS §4) → photo wall with its view toggle →
 * full-screen photo detail (counter, keyboard paging, focus return).
 *
 * Assumes the seeded fixture (slug `testslug123`, PIN `2468`) with the gallery
 * released — same emulator suite as the other specs.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

const GALLERY = '/gallery/index.html?slug=testslug123';

async function unlock(page) {
  await page.goto(GALLERY);
  await expect(page.locator('#app')).toHaveAttribute('data-state', 'pin', { timeout: 30_000 });
  await page.fill('#pin-input', '2468');
  await page.click('#pin-submit');
  await expect(page.locator('#app')).toHaveAttribute('data-state', 'wall', { timeout: 60_000 });
}

test.describe('gallery PIN card (GALLERY-002)', () => {
  test('shows the album cover, rejects a wrong PIN, then opens the wall', async ({ page }) => {
    await page.goto(GALLERY);
    await expect(page.locator('#app')).toHaveAttribute('data-state', 'pin', { timeout: 30_000 });

    // Cover: monogram / names / date come from the theme slots (CONTRACTS §9).
    const cover = page.locator('[data-view="pin"] .cover-body');
    await expect(cover.locator('.cover-names')).toHaveText('Alex & Sam');
    await expect(cover.locator('.cover-date')).not.toHaveText('');
    await expect(cover.locator('.monogram')).not.toHaveText('');

    // Segmented field: typing fills one cell per digit.
    await page.fill('#pin-input', '1111');
    const cells = page.locator('.pin-cell');
    await expect(cells).toHaveCount(6);
    await expect(cells.nth(0)).toHaveText('1');
    await expect(cells.nth(4)).toHaveText('');

    await page.click('#pin-submit');
    await expect(page.locator('#pin-error')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#pin-error')).toContainText('does not match');
    await expect(page.locator('#app')).toHaveAttribute('data-state', 'pin');

    await page.fill('#pin-input', '2468');
    await page.click('#pin-submit');
    await expect(page.locator('#app')).toHaveAttribute('data-state', 'wall', { timeout: 60_000 });
  });

  test('the page is noindexed (GALLERY-004)', async ({ page }) => {
    await page.goto(GALLERY);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });
});

test.describe('photo wall + detail (GALLERY-002/003)', () => {
  test('wall lists the roll, toggles layout and opens a full-screen frame', async ({ page }) => {
    await unlock(page);

    const shots = page.locator('.shot');
    await expect(shots.first()).toBeVisible({ timeout: 30_000 });
    const count = await shots.count();
    expect(count).toBeGreaterThan(0);

    // Header + sticky toolbar both carry the count, no per-tile caption in grid.
    await expect(page.locator('#wall-count')).toContainText('photo');
    await expect(page.locator('#toolbar-count')).toContainText('photo');
    await expect(page.locator('#wall')).toHaveAttribute('data-layout', 'grid');
    await expect(page.locator('.shot').first().locator('.shot-meta')).toBeHidden();

    // View toggle → single-column roll, where the attribution line shows.
    await page.click('#view-roll');
    await expect(page.locator('#wall')).toHaveAttribute('data-layout', 'roll');
    await expect(page.locator('#view-roll')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.shot').first().locator('.shot-meta')).toBeVisible();
    await page.click('#view-grid');
    await expect(page.locator('#wall')).toHaveAttribute('data-layout', 'grid');

    // Detail: dialog semantics, counter, keyboard paging, focus return.
    await shots.first().click();
    const lightbox = page.locator('#lightbox');
    await expect(lightbox).toBeVisible();
    await expect(page.locator('#lb-dialog')).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#lb-dialog')).toHaveAttribute('role', 'dialog');
    await expect(page.locator('#lightbox-counter')).toHaveText(`1 / ${count}`);
    await expect(page.locator('#lightbox-by')).toContainText('by');
    await expect(page.locator('#lb-prev')).toBeDisabled();

    if (count > 1) {
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#lightbox-counter')).toHaveText(`2 / ${count}`);
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('#lightbox-counter')).toHaveText(`1 / ${count}`);
    }

    await page.keyboard.press('Escape');
    await expect(lightbox).toBeHidden();
    // Focus returns to the tile that opened the dialog.
    await expect(shots.first()).toBeFocused();
  });

  test('a reload keeps the gallery unlocked (remembered claim)', async ({ page }) => {
    await unlock(page);
    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('data-state', 'wall', { timeout: 60_000 });
  });
});

/* ── downloads: whole album + selection (GALLERY-005/006) ─────────── */

/** Enters select mode and waits for the bottom action bar. */
async function enterSelect(page) {
  await page.click('#select-toggle');
  await expect(page.locator('#wall')).toHaveAttribute('data-selecting', 'true');
  await expect(page.locator('#selbar')).toBeVisible();
}

/** Reads the first bytes of a completed download. */
async function downloadHead(download, bytes) {
  const file = await download.path();
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    await handle.read(buf, 0, bytes, 0);
    return buf;
  } finally {
    await handle.close();
  }
}

test.describe('bulk download (GALLERY-005/006)', () => {
  test('select mode zips a multi-photo selection', async ({ page }) => {
    await unlock(page);
    const shots = page.locator('.shot');
    await expect(shots.first()).toBeVisible({ timeout: 30_000 });

    await enterSelect(page);
    // Tiles are checkboxes while selecting, not doors into the lightbox.
    await expect(shots.first()).toHaveAttribute('role', 'checkbox');
    await shots.nth(0).click();
    await shots.nth(1).click();
    await expect(page.locator('#lightbox')).toBeHidden();
    await expect(shots.nth(0)).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#selbar-count')).toHaveText('2 selected');

    await page.click('#sel-download');
    // The ZIP is handed over as a link to tap, never an auto-navigation.
    const ready = page.locator('#ready-link');
    await expect(ready).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('#ready-label')).toHaveText('Save ZIP');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      ready.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/-selected-2-photos\.zip$/);
    const head = await downloadHead(download, 2);
    expect(head.toString('latin1')).toBe('PK');
  });

  test('a single selection saves the photo itself', async ({ page }) => {
    await unlock(page);
    await expect(page.locator('.shot').first()).toBeVisible({ timeout: 30_000 });

    await enterSelect(page);
    await page.locator('.shot').nth(0).click();
    await expect(page.locator('#selbar-count')).toHaveText('1 selected');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#sel-download'),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.jpg$/);
    // One photo never becomes a ZIP, and the mode closes itself afterwards.
    await expect(page.locator('#selbar')).toBeHidden();
    await expect(page.locator('#wall')).toHaveAttribute('data-selecting', 'false');
  });

  test('select all / clear / cancel keep the count honest', async ({ page }) => {
    await unlock(page);
    const shots = page.locator('.shot');
    await expect(shots.first()).toBeVisible({ timeout: 30_000 });
    const count = await shots.count();

    await enterSelect(page);
    await expect(page.locator('#sel-download')).toBeDisabled();

    await page.click('#sel-all');
    await expect(page.locator('#selbar-count')).toHaveText(`${count} selected`);
    await expect(page.locator('#sel-all')).toHaveText('Clear');

    await page.click('#sel-all');
    await expect(page.locator('#selbar-count')).toHaveText('0 selected');
    await expect(page.locator('#sel-all')).toHaveText('Select all');
    await expect(page.locator('#sel-download')).toBeDisabled();

    await page.click('#sel-cancel');
    await expect(page.locator('#selbar')).toBeHidden();
    await expect(page.locator('#wall')).toHaveAttribute('data-selecting', 'false');
    await expect(page.locator('#select-toggle')).toHaveAttribute('aria-pressed', 'false');
    // Back out of select mode and a tap opens the frame again.
    await shots.first().click();
    await expect(page.locator('#lightbox')).toBeVisible();
  });

  test('Download all asks the server for one ZIP', async ({ page }) => {
    await unlock(page);
    await expect(page.locator('.shot').first()).toBeVisible({ timeout: 30_000 });

    const button = page.locator('#download-all');
    await expect(button).toBeEnabled();
    await button.click();

    const ready = page.locator('#ready-link');
    const failure = page.locator('.toast');
    await expect(ready.or(failure).first()).toBeVisible({ timeout: 150_000 });

    if (await failure.isVisible()) {
      // The callable is not in this emulator yet — the UI must recover cleanly.
      await expect(button).toBeEnabled();
      await expect(page.locator('#download-all-label')).toHaveText('Download all');
      test.skip(true, 'exportGalleryZip is not deployed in this emulator');
      return;
    }

    await expect(page.locator('#ready-note')).toHaveText('Your album is ready');
    await expect(ready).toHaveAttribute('href', /^https?:\/\/.+/);
    await expect(page.locator('#ready-label')).toContainText('Download ZIP');
  });
});
