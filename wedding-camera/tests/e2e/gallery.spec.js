/**
 * E2E for the gallery surface (workstream ④, PRD GALLERY-002/003/004).
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
