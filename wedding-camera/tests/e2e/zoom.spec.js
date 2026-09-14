/**
 * E2E for the step-less, lens-aware zoom control (CAMERA-006 / CAMERA-010).
 *
 * The guest complaint this suite guards: "1× is actually the 0.5× wide lens."
 * On a virtual multi-lens device the app must open at 1× AND ask the hardware
 * for native zoom 2.0 (the main wide lens), not 1.0 (the ultra-wide).
 *
 * navigator.mediaDevices is replaced per test by `installFakeCamera` so the run
 * can pose as whichever handset the case is about; the fake tracks are real
 * canvas streams, so the <video> plays and capture() really re-encodes pixels.
 * Nothing here touches Storage — no uploads, no queue.
 */
import { test, expect } from '@playwright/test';
import { installFakeCamera, openViewfinder, CAMERA_FIXTURES } from './helpers.js';

const GUEST_URL = '/e/testslug123/';

const readout = (page) => page.locator('.zoomctl__readout');
const track = (page) => page.locator('.zoomctl__track');
const tickLabels = (page) => page.locator('.zoomctl__label');

/** Every zoom constraint the app pushed at the given fake device, in order. */
const zooms = (page, deviceId) => page.evaluate(
  (id) => window.__cam.zooms(id), deviceId,
);

const cssZoom = (page) => page.evaluate(
  () => getComputedStyle(document.querySelector('.vf__video')).getPropertyValue('--zoom').trim(),
);

test.describe('lens ladder in the viewfinder (CAMERA-010)', () => {
  test('a Dual Wide device opens at 1.0× and asks the hardware for native 2.0', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.dualWide);
    await page.goto(GUEST_URL);
    await openViewfinder(page);

    // (a) The guest sees 1.0×, and 1× is the phone's MAIN lens, not the ultra-wide.
    await expect(readout(page)).toHaveText('1.0×');
    await expect(track(page)).toHaveAttribute('aria-valuenow', '1');
    await expect(track(page)).toHaveAttribute('aria-valuetext', '1.0 times');
    await expect.poll(() => zooms(page, 'back-dual-wide'), { timeout: 10_000 })
      .toContain(2);

    // The ladder calibrated oneX = 2, so 0.5× is reachable and 8/2 = 4× is the top.
    await expect(tickLabels(page)).toHaveText(['0.5×', '1×', '2×', '3×']);
    await expect(track(page)).toHaveAttribute('aria-valuemin', '0.5');
    await expect(track(page)).toHaveAttribute('aria-valuemax', '4');

    // (b) Down to the ultra-wide: displayed 0.5× must apply NATIVE 1.0.
    await track(page).focus();
    await page.keyboard.press('Home');
    await expect(readout(page)).toHaveText('0.5×');
    await expect.poll(async () => (await zooms(page, 'back-dual-wide')).at(-1), { timeout: 10_000 })
      .toBe(1);
    // Optical the whole way — no crop is faked on top.
    expect(await cssZoom(page)).toBe('1');

    // Arrow keys are step-less (0.1) and land between the rungs.
    await page.keyboard.press('End');
    await expect(readout(page)).toHaveText('4.0×');
    await page.keyboard.press('ArrowLeft');
    await expect(readout(page)).toHaveText('3.9×');
    await expect.poll(async () => (await zooms(page, 'back-dual-wide')).at(-1), { timeout: 10_000 })
      .toBe(7.8); // 3.9 displayed × oneX 2
  });

  test('dragging the thumb is continuous and snaps onto a lens tick', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.dualWide);
    await page.goto(GUEST_URL);
    await openViewfinder(page);

    const box = await track(page).boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.72, box.y + box.height / 2, { steps: 8 });
    const mid = await readout(page).textContent();
    await page.mouse.up();
    expect(mid).toMatch(/^\d\.\d×$/);
    expect(Number(mid.replace('×', ''))).toBeGreaterThan(1);

    // Tapping a tick takes that lens exactly, however imprecise the tap.
    const tick = page.locator('.zoomctl__tick', { hasText: '2×' }).first();
    const tb = await tick.boundingBox();
    await page.mouse.click(tb.x + tb.width / 2 + 4, box.y + box.height / 2);
    await expect(readout(page)).toHaveText('2.0×');
  });

  test('a single camera with no zoom capability shows an honest 1–2× digital ladder', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.single);
    await page.goto(GUEST_URL);
    await openViewfinder(page);

    // (c) Two rungs only, the top one marked as the digital-quality stretch.
    await expect(tickLabels(page)).toHaveText(['1×', '2×']);
    await expect(page.locator('.zoomctl')).toHaveAttribute('data-mode', 'digital');
    await expect(page.locator('.zoomctl__digital')).toBeVisible();
    await expect(readout(page)).toHaveText('1.0×');
    expect(await cssZoom(page)).toBe('1');

    // …and it really is CSS scale, with no zoom constraint pushed at the track.
    await track(page).focus();
    await page.keyboard.press('End');
    await expect(readout(page)).toHaveText('2.0×');
    await expect.poll(() => cssZoom(page), { timeout: 10_000 }).toBe('2');
    expect(await zooms(page, 'back-plain')).toEqual([]);
  });

  test('separate fixed lenses switch the stream when the guest crosses a rung', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.discrete);
    await page.goto(GUEST_URL);
    await openViewfinder(page);

    await expect(tickLabels(page)).toHaveText(['0.5×', '1×']);
    await expect(page.locator('.zoomctl')).toHaveAttribute('data-mode', 'discrete');
    await expect(readout(page)).toHaveText('1.0×');

    const lastOpened = () => page.evaluate(() => window.__cam.opened.at(-1));
    // facingMode:environment handed us the ULTRA-WIDE first — the exact bug the
    // guests reported. Opening at 1× must have switched to the wide lens itself.
    await expect.poll(lastOpened, { timeout: 15_000 }).toBe('back-wide');

    await track(page).focus();
    await page.keyboard.press('Home');
    await expect(readout(page)).toHaveText('0.5×');
    // Crossing down to 0.5× swaps the stream to the ultra-wide (no crop).
    await expect.poll(lastOpened, { timeout: 15_000 }).toBe('back-ultra');
    await expect.poll(() => cssZoom(page), { timeout: 10_000 }).toBe('1');
  });
});

test.describe('capture crop follows the digital factor (CAMERA-006/007)', () => {
  test('a 2× digital magnification captures a half-width centre crop', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.single);
    await page.goto(GUEST_URL);

    // Drives the REAL camera.js against the fake device, so the crop maths under
    // test is the same code the shutter runs — without spending an exposure.
    const shot = await page.evaluate(async () => {
      const { Camera } = await import('/src/guest/camera.js');
      const video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.muted = true;
      video.style.cssText = 'position:fixed;left:-9999px;width:32px;height:32px';
      document.body.append(video);
      const cam = new Camera(video);
      await cam.start();

      const measure = async () => {
        const blob = await cam.capture();
        const bmp = await createImageBitmap(blob);
        return { w: bmp.width, h: bmp.height, digital: cam.digitalZoom, crop: cam.cropAtCapture };
      };
      const at1 = await measure();
      await cam.setMagnification(2);
      const at2 = await measure();
      await cam.setMagnification(1.6);
      const at16 = await measure();
      cam.dispose();
      video.remove();
      return { at1, at2, at16, source: { w: video.videoWidth, h: video.videoHeight } };
    });

    // 1×: the whole 1280×720 frame, no crop.
    expect(shot.at1).toMatchObject({ w: 1280, h: 720, digital: 1, crop: false });
    // 2×: a centred half-width/half-height crop of the same frame.
    expect(shot.at2).toMatchObject({ w: 640, h: 360, digital: 2, crop: true });
    // …and a step-less value in between crops by exactly that factor.
    expect(shot.at16).toMatchObject({ digital: 1.6, crop: true });
    expect(shot.at16.w).toBe(Math.round(1280 / 1.6));
    expect(shot.at16.h).toBe(Math.round(720 / 1.6));
  });
});

test.describe('diagnostics sheet (?diag=1)', () => {
  test('reports the devices, the ladder and the live mapping', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.dualWide);
    await page.goto(`${GUEST_URL}?diag=1`);
    await openViewfinder(page);

    const body = page.locator('.zoomdiag__body');
    await expect(body).toBeVisible();
    await expect(body).toContainText('Back Dual Wide Camera');
    await expect(body).toContainText('zoom 1–8');
    await expect(body).toContainText('mode: native');
    await expect(body).toContainText('oneX (native value that means 1×): 2');
    await expect(body).toContainText('WebKit does not normalise');
    await expect(body).toContainText('mapping at 1.0×');
    await expect(page.locator('.zoomdiag__btn').first()).toHaveText('Copy');

    await page.locator('.zoomdiag__btn', { hasText: 'Close' }).click();
    await expect(page.locator('.zoomdiag')).toHaveCount(0);
  });

  test('is absent without the flag', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.single);
    await page.goto(GUEST_URL);
    await openViewfinder(page);
    await expect(page.locator('.zoomdiag')).toHaveCount(0);
  });
});
