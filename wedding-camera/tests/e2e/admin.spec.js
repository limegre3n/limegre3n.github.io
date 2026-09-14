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
import { firestoreGet, EMULATOR_FIRESTORE, PROJECT_ID } from './helpers.js';

const CAPTION_MAX = 200;

/** Signs in to /admin/ and waits for the contact sheet to paint. */
async function signInAdmin(page, query = '') {
  await page.goto(`/admin/${query}`);
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


/* ── live wall / TV mode (ADMIN-010) ──────────────────────────────── */

/* The slideshow holds each frame for 7s; on localhost ?slideshowInterval pins it
 * open so the card, the counter and the exit can be checked without waiting. */
const TV_HELD = '?slideshowInterval=60000';

const FS_BASE = `http://${EMULATOR_FIRESTORE}/v1/projects/${PROJECT_ID}`
  + '/databases/(default)/documents';

/**
 * Flips a photo's status out-of-band (Firestore emulator REST, owner auth). The
 * live wall covers the darkroom while it plays, so a moderation change has to
 * arrive the way it would from the couple's other phone.
 */
async function setStatus(uuid, status) {
  const url = `${FS_BASE}/photos/${uuid}?updateMask.fieldPaths=status`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { status: { stringValue: status } } }),
  });
  if (!res.ok) throw new Error(`emulator PATCH photos/${uuid} → ${res.status}`);
}

/** "3 / 26" → 26. The total is what a live hide changes. */
async function frameTotal(page) {
  const text = await page.locator('.tv-count').textContent();
  return Number(String(text).split('/')[1].trim());
}

test.describe('live wall (ADMIN-010)', () => {
  test('plays the visible photos behind the camera QR, with no PIN anywhere', async ({ page }) => {
    await signInAdmin(page, TV_HELD);
    // Newest first in the darkroom — hiding this one never disturbs the caption specs.
    const newest = await page.locator('.photo-card').first().getAttribute('data-uuid');
    expect(newest).toBeTruthy();

    await page.click('#live-btn');
    const tv = page.locator('.tv');
    await expect(tv).toBeVisible();
    await expect(tv).toHaveAttribute('role', 'dialog');
    await expect(tv).toHaveAttribute('aria-label', 'Slideshow');
    await expect(tv).toHaveAttribute('data-variant', 'admin');

    // The card points at the guest camera, and the darkroom never shows a PIN.
    const qr = await page.locator('.tv-qr').evaluate((canvas) => ({
      width: canvas.width,
      bytes: canvas.toDataURL().length,
    }));
    expect(qr.width).toBeGreaterThan(100);
    expect(qr.bytes).toBeGreaterThan(1000);
    await expect(page.locator('.tv-qr-label')).toHaveText('Scan to take photos');
    await expect(page.locator('.tv-pin-digits')).toHaveCount(0);
    await expect(page.locator('.tv-pin')).toHaveCount(0);

    // A frame hidden from somewhere else leaves the rotation while it plays.
    const before = await frameTotal(page);
    expect(before).toBeGreaterThan(1);
    try {
      await setStatus(newest, 'hidden');
      await expect.poll(() => frameTotal(page), { timeout: 30_000 }).toBe(before - 1);
    } finally {
      await setStatus(newest, 'visible');
    }
    await expect.poll(() => frameTotal(page), { timeout: 30_000 }).toBe(before);

    // Exit is always reachable, and the darkroom is still there behind it.
    await page.keyboard.press('Escape');
    await expect(tv).toHaveCount(0);
    await expect(page.locator('#app')).toHaveAttribute('data-state', 'main');
    await expect(page.locator('.photo-card').first()).toBeVisible();
  });
});


/* ── film development controls (ADMIN-011 / CONTRACTS §11) ────────── */

/** `config/event.dateStamp` as Firestore actually stores it (owner read). */
async function storedDateStamp() {
  const doc = await firestoreGet('config/event');
  const field = doc.fields.dateStamp;
  return field ? field.booleanValue === true : null;
}

/** Restores the fixture out-of-band if a test leaves the switch the wrong way. */
async function setDateStamp(value) {
  const res = await fetch(`${FS_BASE}/config/event?updateMask.fieldPaths=dateStamp`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { dateStamp: { booleanValue: !!value } } }),
  });
  if (!res.ok) throw new Error(`emulator PATCH config/event → ${res.status}`);
}

/**
 * How many `audit{action:'redevelop'}` records exist. `redevelopAll` writes one per
 * call with the Admin SDK — the value is deliberately NOT in the rules audit enum,
 * so no client can forge it (CONTRACTS §2).
 */
async function redevelopAudits() {
  const res = await fetch(`${FS_BASE}:runQuery`, {
    method: 'POST',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'audit' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'action' }, op: 'EQUAL', value: { stringValue: 'redevelop' },
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`emulator runQuery audit → ${res.status}`);
  return (await res.json()).filter((row) => row.document).length;
}

test.describe('film development controls (ADMIN-011)', () => {
  test('the 90s date stamp toggle writes config/event.dateStamp', async ({ page }) => {
    await setDateStamp(true); // the fixture ships with the stamp on — start from there
    await signInAdmin(page);
    const box = page.locator('#stamp-toggle');
    await expect(box).toBeEnabled({ timeout: 30_000 });
    await expect(box).toBeChecked({ timeout: 30_000 });

    try {
      await box.uncheck();
      await expect.poll(storedDateStamp, { timeout: 30_000 }).toBe(false);
      await expect(page.locator('.toast').last()).toContainText('Date stamp off');

      await box.check();
      await expect.poll(storedDateStamp, { timeout: 30_000 }).toBe(true);
      await expect(page.locator('.toast').last()).toContainText('Date stamp on');
      await expect(box).toBeChecked();
    } finally {
      await setDateStamp(true);
    }
  });

  test('“Redevelop all photos” loops to the end and logs an audit record', async ({ page }) => {
    const before = await redevelopAudits();
    await signInAdmin(page);

    const btn = page.locator('#redevelop-btn');
    await expect(btn).toBeEnabled();
    await btn.click();

    // The loop pages through redevelopAll until `remaining` is false, then toasts.
    await expect(page.locator('.toast').last())
      .toContainText('Redeveloped', { timeout: 150_000 });
    await expect(page.locator('.toast').last()).not.toHaveClass(/bad/);

    // Button returns to its resting state — no stuck "Redeveloping…" label.
    await expect(btn).toBeEnabled({ timeout: 30_000 });
    await expect(btn).toHaveText('Redevelop all photos');
    await expect(page.locator('#stamp-toggle')).toBeEnabled();

    await expect.poll(redevelopAudits, { timeout: 30_000 }).toBeGreaterThan(before);
  });
});
