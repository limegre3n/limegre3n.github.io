/**
 * E2E for photo quality: the still-photo path and the JPEG encoder
 * (CAMERA-013 / CAMERA-007).
 *
 * The guest complaint this suite guards: "the photos look grainy." Two causes,
 * one file each side of `capture()` — shots used to come off the *video*
 * preview (video-grade processing, heavy denoise) and were then squeezed to
 * ≤1MB at quality 0.55. Now a shot prefers `ImageCapture.takePhoto()` and is
 * encoded at ≥0.72 up to 2560px.
 *
 * `installFakeCamera` supplies both a scripted video track AND (optionally) a
 * scripted `ImageCapture` whose still is a four-quadrant plate at "sensor"
 * resolution — deliberately nothing like the video pattern, so which source a
 * shot came from is readable from four pixels. Nothing here touches Storage.
 */
import { test, expect } from '@playwright/test';
import { installFakeCamera, CAMERA_FIXTURES } from './helpers.js';

const GUEST_URL = '/e/testslug123/';

/** The quadrant plate the fake ImageCapture paints, top-left → bottom-right. */
const STILL_QUADRANTS = [
  [0, 183, 195],
  [209, 63, 184],
  [242, 227, 74],
  [27, 42, 107],
];

/** JPEG round-trips twice (fake still, then our encode) — allow a little drift. */
function expectColor(actual, expected, label) {
  const near = expected.every((channel, i) => Math.abs(actual[i] - channel) <= 16);
  expect(near, `${label}: got rgb(${actual.join(',')}), want rgb(${expected.join(',')})`).toBe(true);
}

/**
 * Drives the REAL camera.js against the fake device on its own offscreen
 * <video>, so the code under test is exactly what the shutter runs — without
 * spending an exposure or an upload. Returns the decoded JPEG's geometry, four
 * probe pixels, the encoder stats and how long the shot took.
 */
async function shoot(page, { magnification = 1 } = {}) {
  return page.evaluate(async (mag) => {
    const { Camera } = await import('/src/guest/camera.js');
    const video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.style.cssText = 'position:fixed;left:-9999px;width:32px;height:32px';
    document.body.append(video);
    const cam = new Camera(video);
    await cam.start();
    if (mag !== 1) await cam.setMagnification(mag);

    const started = performance.now();
    const blob = await cam.capture();
    const ms = performance.now() - started;

    const bmp = await createImageBitmap(blob);
    const probe = document.createElement('canvas');
    probe.width = bmp.width;
    probe.height = bmp.height;
    probe.getContext('2d').drawImage(bmp, 0, 0);
    const at = (fx, fy) => Array.from(probe.getContext('2d')
      .getImageData(Math.round(bmp.width * fx), Math.round(bmp.height * fy), 1, 1).data)
      .slice(0, 3);
    const pixels = [at(0.25, 0.25), at(0.75, 0.25), at(0.25, 0.75), at(0.75, 0.75)];

    const result = {
      w: bmp.width,
      h: bmp.height,
      bytes: blob.size,
      type: blob.type,
      ms,
      source: cam.lastCaptureSource,
      encode: cam.lastEncode,
      stills: window.__cam.stills.length,
      video: { w: video.videoWidth, h: video.videoHeight },
      pixels,
    };
    bmp.close?.();
    cam.dispose();
    video.remove();
    return result;
  }, magnification);
}

test.describe('still-photo capture (CAMERA-013)', () => {
  test('a shot comes from the still, not the video frame, and fits 2560px', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.single, {
      video: { width: 1280, height: 720 },
      still: { width: 4032, height: 3024 },
    });
    await page.goto(GUEST_URL);

    const shot = await shoot(page);

    expect(shot.source).toBe('still');
    expect(shot.stills).toBeGreaterThan(0);
    expect(shot.type).toBe('image/jpeg');
    // A 4:3 "sensor" still, centre-cropped to the 16:9 preview, then capped.
    expect(Math.max(shot.w, shot.h)).toBe(2560);
    expect(shot).toMatchObject({ w: 2560, h: 1440 });

    // The pixels are the still's quadrant plate — the video pattern has no
    // cyan/magenta/yellow/navy anywhere in it.
    shot.pixels.forEach((px, i) => expectColor(px, STILL_QUADRANTS[i], `quadrant ${i}`));
  });

  test('a 3:2 still is centre-cropped to the 4:3 preview aspect', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.single, {
      video: { width: 1280, height: 960 },
      still: { width: 4032, height: 2688 },
    });
    await page.goto(GUEST_URL);

    const shot = await shoot(page);

    expect(shot.source).toBe('still');
    expect(shot.video).toMatchObject({ w: 1280, h: 960 });
    // Guests get what the viewfinder framed, not what the sensor saw.
    const aspect = shot.w / shot.h;
    expect(Math.abs(aspect - 4 / 3) / (4 / 3)).toBeLessThan(0.01);
    expect(Math.max(shot.w, shot.h)).toBeLessThanOrEqual(2560);
    shot.pixels.forEach((px, i) => expectColor(px, STILL_QUADRANTS[i], `quadrant ${i}`));
  });

  test('the digital-zoom crop still applies to a still', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.single, {
      video: { width: 1280, height: 720 },
      still: { width: 4032, height: 3024 },
    });
    await page.goto(GUEST_URL);

    const shot = await shoot(page, { magnification: 2 });

    expect(shot.source).toBe('still');
    // 4032×3024 → 16:9 crop 4032×2268 → halved by the 2× digital factor → 2016×1134.
    expect(shot).toMatchObject({ w: 2016, h: 1134 });
    // The crop stayed centred: each probe is still inside its own quadrant.
    shot.pixels.forEach((px, i) => expectColor(px, STILL_QUADRANTS[i], `quadrant ${i}`));
  });

  test('a rejected takePhoto falls back to the frame grab and the shot succeeds', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.single, {
      video: { width: 1280, height: 720 },
      still: { width: 4032, height: 3024, mode: 'fail' },
    });
    await page.goto(GUEST_URL);

    const shot = await shoot(page);

    expect(shot.stills).toBeGreaterThan(0); // it really tried
    expect(shot.source).toBe('frame');
    expect(shot).toMatchObject({ w: 1280, h: 720, type: 'image/jpeg' });
    expect(shot.bytes).toBeGreaterThan(0);
  });

  test('a takePhoto that never resolves times out into the frame grab', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.single, {
      video: { width: 1280, height: 720 },
      still: { width: 4032, height: 3024, mode: 'slow' },
    });
    await page.goto(GUEST_URL);

    const shot = await shoot(page);

    expect(shot.source).toBe('frame');
    expect(shot).toMatchObject({ w: 1280, h: 720 });
    // The 2500ms budget really elapsed, and the shutter was not held much past it.
    expect(shot.ms).toBeGreaterThan(2000);
    expect(shot.ms).toBeLessThan(4500);
  });

  test('a constraints rejection is retried once with empty photo settings', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.single, {
      video: { width: 1280, height: 720 },
      still: { width: 4032, height: 3024, mode: 'constrained' },
    });
    await page.goto(GUEST_URL);

    const shot = await shoot(page);
    const calls = await page.evaluate(() => window.__cam.stills);

    expect(shot.source).toBe('still');
    expect(calls.map((c) => c.settings)).toEqual(['none', {}]);
  });

  test('without ImageCapture nothing changes: the frame grab is used', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.single, { video: { width: 1280, height: 720 } });
    await page.goto(GUEST_URL);

    const hasApi = await page.evaluate(() => !!window.ImageCapture);
    const shot = await shoot(page);

    expect(hasApi).toBe(false);
    expect(shot.source).toBe('frame');
    expect(shot).toMatchObject({ w: 1280, h: 720 });
  });
});

test.describe('JPEG encoder budget (CAMERA-007)', () => {
  test('a highly detailed frame lands under 2.5MB without dropping below q0.72', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.single, {
      video: { width: 2560, height: 1440, pattern: 'detail', cell: 2 },
    });
    await page.goto(GUEST_URL);

    const shot = await shoot(page);

    expect(shot.source).toBe('frame');
    expect(shot).toMatchObject({ w: 2560, h: 1440 });
    // Worst-case entropy at 2560px still fits the budget at the top quality, so
    // the ladder is a safety net rather than a routine cost — but if it ever
    // does run, it must stop at the floor and never resize this frame.
    expect(shot.bytes).toBeLessThanOrEqual(2_500_000);
    expect(shot.encode.quality).toBeGreaterThanOrEqual(0.72);
    expect(shot.encode.quality).toBeLessThanOrEqual(0.86);
    expect(shot.encode.steps).toBeLessThanOrEqual(2);
    // Nowhere near the 8MB cap in storage.rules / the finalize function.
    expect(shot.bytes).toBeLessThan(8 * 1024 * 1024);
  });

  test('a bland frame is encoded at the first quality step, untouched', async ({ page }) => {
    await installFakeCamera(page, CAMERA_FIXTURES.single, {
      video: { width: 1280, height: 720, pattern: 'flat' },
    });
    await page.goto(GUEST_URL);

    const shot = await shoot(page);

    expect(shot.encode).toMatchObject({ quality: 0.86, steps: 0, width: 1280, height: 720 });
    expect(shot.bytes).toBeLessThan(2_500_000);
  });
});
