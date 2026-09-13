/**
 * E2E for the couple's captions in the darkroom (PRD ADMIN-009 / GALLERY-007).
 *
 * The admin grid is newest-first, so a card is addressed by its `data-uuid`
 * rather than by position — the fixture grows as other specs upload frames.
 * Every test restores the caption it wrote, so the seeded album stays pristine.
 *
 * Assumes the shared emulator suite (project demo-wedding) seeded with slug
 * `testslug123` and the admin account admin@test.dev / testpass123.
 */
import { test, expect } from '@playwright/test';
import { firestoreGet } from './helpers.js';

const CAPTION_MAX = 200;

/** Signs in to /admin/ and waits for the contact sheet to paint. */
async function signInAdmin(page) {
  await page.goto('/admin/');
  await page.fill('#login-email', 'admin@test.dev');
  await page.fill('#login-password', 'testpass123');
  await page.click('#login-submit');
  await expect(page.locator('#app')).toHaveAttribute('data-state', 'main', { timeout: 30_000 });
  await expect(page.locator('.photo-card').first()).toBeVisible({ timeout: 30_000 });
}

/** The oldest frame in the roll — the gallery's first tile (receivedAt asc). */
function oldestCard(page) {
  return page.locator('.photo-card').last();
}

/** Opens the inline editor on a card and returns its live parts. */
async function openEditor(card) {
  await card.locator('.caption-view').click();
  const input = card.locator('.caption-input');
  await expect(input).toBeVisible();
  return { input, counter: card.locator('.caption-counter') };
}

async function setCaption(card, text) {
  const { input } = await openEditor(card);
  await input.fill(text);
  await card.locator('.caption-save').click();
  await expect(input).toBeHidden({ timeout: 30_000 });
}

/** The caption as Firestore actually stored it (owner read, bypassing rules). */
async function storedCaption(uuid) {
  const doc = await firestoreGet(`photos/${uuid}`);
  const field = doc.fields.caption;
  return field ? field.stringValue : null;
}

test.describe('admin captions (ADMIN-009)', () => {
  test('adds, edits and clears a note, writing an audit record each time', async ({ page }) => {
    await signInAdmin(page);
    const card = oldestCard(page);
    const uuid = await card.getAttribute('data-uuid');
    expect(uuid).toBeTruthy();

    // A frame with no note invites one.
    await expect(card.locator('.caption-view')).toHaveText('Add a note');
    await expect(card.locator('.caption-view')).toHaveClass(/is-empty/);

    const note = 'Our first dance — nobody warned us about the smoke machine.';
    await setCaption(card, note);
    await expect(card.locator('.caption-view')).toHaveText(note);
    await expect(card.locator('.caption-tick')).toBeVisible();
    await expect.poll(() => storedCaption(uuid), { timeout: 20_000 }).toBe(note);

    // Escape abandons an edit without touching what is stored.
    const { input } = await openEditor(card);
    await input.fill('scratch that');
    await input.press('Escape');
    await expect(input).toBeHidden();
    await expect(card.locator('.caption-view')).toHaveText(note);

    // Enter saves, so the couple never hunt for the button.
    const second = 'The cake survived exactly four minutes.';
    const again = await openEditor(card);
    await again.input.fill(second);
    await again.input.press('Enter');
    await expect(again.input).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => storedCaption(uuid), { timeout: 20_000 }).toBe(second);

    // Clearing stores an empty string, never a deleted photo or a stale note.
    await setCaption(card, '');
    await expect(card.locator('.caption-view')).toHaveText('Add a note');
    await expect.poll(() => storedCaption(uuid), { timeout: 20_000 }).toBe('');
  });

  test('the editor caps a note at 200 characters (ADMIN-009)', async ({ page }) => {
    await signInAdmin(page);
    const card = oldestCard(page);
    const uuid = await card.getAttribute('data-uuid');

    const { input, counter } = await openEditor(card);
    await expect(counter).toHaveText(`0/${CAPTION_MAX}`);

    // 201 characters cannot survive the editor — neither typed nor pasted.
    const tooLong = 'x'.repeat(CAPTION_MAX + 1);
    await input.fill(tooLong);
    await expect(counter).toHaveText(`${CAPTION_MAX}/${CAPTION_MAX}`);
    await expect(counter).toHaveClass(/is-full/);
    expect(await input.inputValue()).toHaveLength(CAPTION_MAX);

    // Typing one more character on top is refused by the field itself.
    await input.press('End');
    await input.type('y');
    expect(await input.inputValue()).toHaveLength(CAPTION_MAX);

    await card.locator('.caption-save').click();
    await expect(input).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => storedCaption(uuid), { timeout: 20_000 })
      .toBe('x'.repeat(CAPTION_MAX));

    await setCaption(card, ''); // restore the fixture
    await expect.poll(() => storedCaption(uuid), { timeout: 20_000 }).toBe('');
  });

  test('a hidden frame can still be captioned (ADMIN-003 + ADMIN-009)', async ({ page }) => {
    await signInAdmin(page);
    const card = oldestCard(page);
    const uuid = await card.getAttribute('data-uuid');

    await card.locator('.frame').click(); // hide
    await expect(card.locator('.frame')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });

    try {
      await setCaption(card, 'Kept for us, not for the wall.');
      await expect.poll(() => storedCaption(uuid), { timeout: 20_000 })
        .toBe('Kept for us, not for the wall.');
    } finally {
      await setCaption(card, '');
      await card.locator('.frame').click(); // unhide
      await expect(card.locator('.frame')).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    }
  });
});
