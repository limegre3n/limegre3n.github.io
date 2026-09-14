/**
 * Lens-ladder heuristics (CAMERA-010) — pure unit tests, no DOM, no browser.
 *   node --test tests/unit/
 *
 * Fixtures are real `enumerateDevices()` / `getCapabilities()` shapes collected
 * from the phones we care about. The one assertion every fixture shares: the
 * ladder STARTS at 1× and 1× frames the phone's main wide lens — that is the
 * guest complaint ("1× is actually the 0.5× wide lens") turned into a test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLadder, resolve, snapToRung, opticalCeiling, describeLadder,
} from '../../app/src/guest/lens.js';

const dev = (deviceId, label) => ({ deviceId, kind: 'videoinput', label });
const mags = (ladder) => ladder.rungs.map((r) => r.mag);

/** Every fixture must agree that 1× is reachable and is the default. */
function assertOneXIsHome(ladder) {
  assert.ok(ladder.min <= 1 && ladder.max >= 1, `1× outside ${ladder.min}–${ladder.max}`);
  assert.ok(ladder.rungs.some((r) => r.mag === 1), 'no 1× rung');
  const r = resolve(ladder, 1);
  assert.equal(r.digital, 1, '1× must never need a digital crop');
  return r;
}

/* ------------------------------------------------------ iOS virtual devices */

test('iPhone 15 Pro — Back Triple Camera 1–15.9 → oneX 2, rungs 0.5/1/2/3/5', () => {
  const d = dev('tripleAAA111', 'Back Triple Camera');
  const ladder = buildLadder({
    devices: [d, dev('frontAAA111', 'Front Camera')],
    capsById: { tripleAAA111: { zoom: { min: 1, max: 15.9, step: 0.1 }, facingMode: ['environment'] } },
  });
  assert.equal(ladder.mode, 'native');
  assert.equal(ladder.oneX, 2);
  assert.equal(ladder.min, 0.5);
  assert.equal(ladder.max, 7.95); // 15.9/2, under the 8× slider ceiling
  assert.deepEqual(mags(ladder), [0.5, 1, 2, 3, 5]);

  // The bug, nailed: default 1× must ask the hardware for native 2.0, not 1.0.
  assert.deepEqual(assertOneXIsHome(ladder), { deviceId: 'tripleAAA111', nativeZoom: 2, digital: 1 });
  // …and the ultra-wide is what native 1.0 gives you, shown honestly as 0.5×.
  assert.equal(resolve(ladder, 0.5).nativeZoom, 1);
  assert.equal(resolve(ladder, 3).nativeZoom, 6);
});

test('iPhone 12 — Back Dual Wide Camera 1–8 → oneX 2, 0.5× reachable', () => {
  const ladder = buildLadder({
    devices: [dev('dualBBB222', 'Back Dual Wide Camera')],
    capsById: { dualBBB222: { zoom: { min: 1, max: 8 } } },
  });
  assert.equal(ladder.mode, 'native');
  assert.equal(ladder.oneX, 2);
  assert.equal(ladder.min, 0.5);
  assert.equal(ladder.max, 4);
  assert.deepEqual(mags(ladder), [0.5, 1, 2, 3]);
  assert.equal(assertOneXIsHome(ladder).nativeZoom, 2);
  assert.equal(resolve(ladder, 0.5).nativeZoom, 1);
  // Above the range the slider simply stops; it never invents a crop.
  assert.equal(resolve(ladder, 99).nativeZoom, 8);
  assert.equal(resolve(ladder, 99).digital, 1);
});

test('iPhone SE — Back Camera 1–4 → oneX 1, no 0.5× rung', () => {
  const ladder = buildLadder({
    devices: [dev('seCCC333', 'Back Camera')],
    capsById: { seCCC333: { zoom: { min: 1, max: 4 } } },
  });
  assert.equal(ladder.mode, 'native');
  assert.equal(ladder.oneX, 1);
  assert.equal(ladder.min, 1);
  assert.equal(ladder.max, 4);
  assert.deepEqual(mags(ladder), [1, 2, 3]);
  assert.ok(!ladder.rungs.some((r) => r.mag < 1), 'single-lens phone must not offer 0.5×');
  assert.deepEqual(assertOneXIsHome(ladder), { deviceId: 'seCCC333', nativeZoom: 1, digital: 1 });
});

/* --------------------------------------------------------- discrete lenses */

test('iPhone with separate Ultra Wide + Back Camera and no zoom caps → discrete', () => {
  const ladder = buildLadder({
    devices: [dev('uwDDD444', 'Back Ultra Wide Camera'), dev('wideDDD444', 'Back Camera')],
    capsById: { uwDDD444: { facingMode: ['environment'] }, wideDDD444: { facingMode: ['environment'] } },
  });
  assert.equal(ladder.mode, 'discrete');
  assert.deepEqual(mags(ladder), [0.5, 1]);
  assert.equal(ladder.min, 0.5);
  assert.equal(ladder.max, 2); // 2× digital on top of the 1× lens
  assert.equal(opticalCeiling(ladder), 1);

  // 1× streams the wide lens with no crop; 0.5× switches to the ultra-wide.
  assert.deepEqual(assertOneXIsHome(ladder), { deviceId: 'wideDDD444', nativeZoom: null, digital: 1 });
  assert.deepEqual(resolve(ladder, 0.5), { deviceId: 'uwDDD444', nativeZoom: null, digital: 1 });
  // Between rungs: crop the LOWER lens rather than jump early.
  assert.deepEqual(resolve(ladder, 0.75), { deviceId: 'uwDDD444', nativeZoom: null, digital: 1.5 });
  assert.deepEqual(resolve(ladder, 1.6), { deviceId: 'wideDDD444', nativeZoom: null, digital: 1.6 });
});

test('discrete: an unrecognisable extra back device is skipped with a note', () => {
  const ladder = buildLadder({
    devices: [
      dev('uwEEE555', 'Back Ultra Wide Camera'),
      dev('wideEEE555', 'Back Camera'),
      dev('depthEEE555', 'Back LiDAR Depth Camera'),
    ],
  });
  assert.deepEqual(mags(ladder), [0.5, 1]);
  assert.ok(ladder.notes.some((n) => /Skipped back device .*LiDAR/i.test(n)), 'no skip note');
});

test('discrete: a telephoto stating 3x lands on a 3× rung', () => {
  const ladder = buildLadder({
    devices: [
      dev('uwFFF666', 'Back Ultra Wide Camera'),
      dev('wideFFF666', 'Back Camera'),
      dev('teleFFF666', 'Back Telephoto Camera 3x'),
    ],
  });
  assert.equal(ladder.mode, 'discrete');
  assert.deepEqual(mags(ladder), [0.5, 1, 3]);
  assert.equal(ladder.max, 6);
  assert.deepEqual(resolve(ladder, 3), { deviceId: 'teleFFF666', nativeZoom: null, digital: 1 });
  assert.deepEqual(resolve(ladder, 2), { deviceId: 'wideFFF666', nativeZoom: null, digital: 2 });
});

/* ----------------------------------------------------------------- Android */

test('Pixel 7 — "camera2 0, facing back" 1–8 → native, oneX 1', () => {
  const ladder = buildLadder({
    devices: [dev('pix0GGG777', 'camera2 0, facing back'), dev('pix1GGG777', 'camera2 1, facing front')],
    capsById: { pix0GGG777: { zoom: { min: 1, max: 8 } } },
  });
  assert.equal(ladder.mode, 'native');
  assert.equal(ladder.oneX, 1);
  assert.equal(ladder.min, 1);
  assert.equal(ladder.max, 8);
  assert.deepEqual(mags(ladder), [1, 2, 3, 5]);
  assert.deepEqual(assertOneXIsHome(ladder), { deviceId: 'pix0GGG777', nativeZoom: 1, digital: 1 });
});

test('Samsung — zoom 0.5–10 → native, oneX 1, 0.5× is native 0.5 (already normalised)', () => {
  const ladder = buildLadder({
    devices: [dev('samHHH888', 'camera2 0, facing back')],
    capsById: { samHHH888: { zoom: { min: 0.5, max: 10 } } },
  });
  assert.equal(ladder.mode, 'native');
  assert.equal(ladder.oneX, 1);
  assert.equal(ladder.min, 0.5);
  assert.equal(ladder.max, 8, 'slider stops at 8× even though the phone reaches 10×');
  assert.deepEqual(mags(ladder), [0.5, 1, 2, 3, 5]);
  assert.deepEqual(assertOneXIsHome(ladder), { deviceId: 'samHHH888', nativeZoom: 1, digital: 1 });
  assert.equal(resolve(ladder, 0.5).nativeZoom, 0.5);
});

/* ------------------------------------------------------------- degenerate */

test('single back camera with no zoom capability → digital 1–2× only', () => {
  const ladder = buildLadder({
    devices: [dev('plainIII999', 'Back Camera')],
    capsById: { plainIII999: {} },
  });
  assert.equal(ladder.mode, 'digital');
  assert.equal(ladder.min, 1);
  assert.equal(ladder.max, 2);
  assert.deepEqual(mags(ladder), [1, 2]);
  assert.deepEqual(assertOneXIsHome(ladder), { deviceId: 'plainIII999', nativeZoom: null, digital: 1 });
  assert.deepEqual(resolve(ladder, 2), { deviceId: 'plainIII999', nativeZoom: null, digital: 2 });
});

test('no devices at all (labels empty before permission) → safe digital ladder', () => {
  const ladder = buildLadder({ devices: [] });
  assert.equal(ladder.mode, 'digital');
  assertOneXIsHome(ladder);
  assert.ok(ladder.notes.some((n) => /No back-facing camera identified/.test(n)));
});

test('a zoom range too short to be useful (1–1.5) falls back to digital', () => {
  const ladder = buildLadder({
    devices: [dev('shortJJJ000', 'Back Camera')],
    capsById: { shortJJJ000: { zoom: { min: 1, max: 1.5 } } },
  });
  assert.equal(ladder.mode, 'digital');
  assert.equal(ladder.max, 2);
});

test('front camera always gets the plain 1–2× digital ladder', () => {
  const ladder = buildLadder({
    devices: [dev('frontKKK111', 'Front Camera')],
    capsById: { frontKKK111: { zoom: { min: 1, max: 8 } } },
    facing: 'user',
  });
  assert.equal(ladder.mode, 'digital');
  assert.equal(ladder.facing, 'user');
  assert.deepEqual(mags(ladder), [1, 2]);
  assert.deepEqual(assertOneXIsHome(ladder), { deviceId: 'frontKKK111', nativeZoom: null, digital: 1 });
});

/* ------------------------------------------------------------ slider glue */

test('snapToRung pulls within ±0.06 and leaves the rest step-less', () => {
  const ladder = buildLadder({
    devices: [dev('snapLLL222', 'Back Dual Wide Camera')],
    capsById: { snapLLL222: { zoom: { min: 1, max: 8 } } },
  });
  assert.equal(snapToRung(ladder, 1.04), 1);
  assert.equal(snapToRung(ladder, 0.95), 1);
  assert.equal(snapToRung(ladder, 0.54), 0.5);
  assert.equal(snapToRung(ladder, 1.3), 1.3, 'mid-range values stay exactly where the guest put them');
  assert.equal(snapToRung(ladder, 0.2), 0.5, 'below the floor clamps to the floor rung');
});

test('describeLadder returns copy-pasteable text naming the mode and every rung', () => {
  const ladder = buildLadder({
    devices: [dev('descMMM333', 'Back Triple Camera')],
    capsById: { descMMM333: { zoom: { min: 1, max: 15.9 } } },
  });
  const text = describeLadder(ladder);
  assert.match(text, /mode: native/);
  assert.match(text, /oneX \(native value that means 1×\): 2/);
  for (const r of ladder.rungs) assert.ok(text.includes(r.label), `missing ${r.label}`);
  assert.match(text, /WebKit does not normalise/);
});
