/**
 * Film grain (CONTRACTS §11) — pure unit tests, no emulator, no browser.
 *   node --test tests/unit/
 *
 * These are property tests on real pixels: every case renders a flat patch through
 * `developBuffer` and measures what came back. The properties are the ones that make
 * grain read as film rather than as sensor noise —
 *
 *   1. it is resolution-scaled: the same scene at 1600 px and at 2560 px is equally
 *      grainy once both are viewed at the same display size;
 *   2. it clumps: neighbouring pixels are correlated, where per-pixel noise is not;
 *   3. it is a mid-tone phenomenon: crushed blacks and blown highlights stay clean;
 *   4. it is zero-mean — the overlay blend must not shift exposure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('../../functions/node_modules/sharp');
const { developBuffer } = require('../../functions/develop.js');

/** A recipe that does nothing at all except grain, so the measurement is unambiguous. */
const grainOnly = (grain) => ({
  bw: false,
  modulate: { brightness: 1, saturation: 1, hue: 0 },
  tint: null,
  gamma: null,
  linear: null,
  contrast: 1,
  lift: 0,
  grain,
  vignette: 0,
});

/** A flat JPEG patch, encoded well enough that it carries no noise of its own. */
const patch = (width, height, background) => sharp({
  create: { width, height, channels: 3, background },
}).jpeg({ quality: 100 }).toBuffer();

/**
 * Mean, standard deviation and lag-1 horizontal autocorrelation of one band,
 * optionally after resampling to a common display size.
 *
 * @param {Buffer} jpeg
 * @param {number} [displayW]
 * @param {number} [displayH]
 */
async function measure(jpeg, displayW = 0, displayH = 0) {
  let pipe = sharp(jpeg);
  if (displayW && displayH) pipe = pipe.resize(displayW, displayH, { kernel: 'lanczos3' });
  const { data, info } = await pipe.extractChannel(1).raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (const v of data) sum += v;
  const mean = sum / data.length;
  let variance = 0;
  for (const v of data) variance += (v - mean) ** 2;
  variance /= data.length;
  let cov = 0;
  let pairs = 0;
  for (let y = 0; y < info.height; y += 1) {
    const row = y * info.width;
    for (let x = 0; x < info.width - 1; x += 1) {
      cov += (data[row + x] - mean) * (data[row + x + 1] - mean);
      pairs += 1;
    }
  }
  return {
    mean,
    std: Math.sqrt(variance),
    corr: variance > 0 ? cov / pairs / variance : 0,
  };
}

test('grain is resolution-scaled: 1600 px and 2560 px look equally grainy at one size', async () => {
  const recipe = grainOnly(6.5);
  const small = await measure(
    await developBuffer(await patch(1600, 1200, '#808080'), { recipe }), 800, 600);
  const big = await measure(
    await developBuffer(await patch(2560, 1920, '#808080'), { recipe }), 800, 600);
  const ratio = big.std / small.std;
  assert.ok(small.std > 1, `no grain at 1600 px (std ${small.std.toFixed(2)})`);
  assert.ok(ratio > 0.75 && ratio < 1.33,
    `grain does not hold across capture sizes: 1600 px ${small.std.toFixed(2)} vs `
    + `2560 px ${big.std.toFixed(2)} at the same display size`);
});

test('recipe grain is the sigma the picture receives, whatever the capture size', async () => {
  for (const [w, h] of [[2560, 1920], [1600, 1200]]) {
    const { std } = await measure(
      await developBuffer(await patch(w, h, '#808080'), { recipe: grainOnly(6.5) }));
    assert.ok(std > 4.5 && std < 8.5, `${w}px: sigma 6.5 landed as ${std.toFixed(2)}`);
  }
});

test('grain clumps — neighbouring pixels are correlated, unlike per-pixel noise', async () => {
  const { corr } = await measure(
    await developBuffer(await patch(2560, 1920, '#808080'), { recipe: grainOnly(6.5) }));
  assert.ok(corr > 0.4, `grain reads as per-pixel noise (lag-1 correlation ${corr.toFixed(2)})`);
});

test('grain is strongest in the mid-tones and clears out of the extremes', async () => {
  const recipe = grainOnly(6.5);
  const at = async (background) => (await measure(
    await developBuffer(await patch(1200, 900, background), { recipe }))).std;
  const [black, shadow, mid, highlight] = await Promise.all(
    ['#0a0a0a', '#404040', '#808080', '#f2f2f2'].map(at));
  assert.ok(mid > 4, `no grain in the mid-tones (std ${mid.toFixed(2)})`);
  assert.ok(shadow < mid * 0.7, `shadows as grainy as mid-tones (${shadow.toFixed(2)} vs ${mid.toFixed(2)})`);
  assert.ok(black < mid * 0.25, `crushed black is not clean (std ${black.toFixed(2)})`);
  assert.ok(highlight < mid * 0.25, `blown highlight is not clean (std ${highlight.toFixed(2)})`);
});

test('grain is zero-mean, and grain 0 develops a flat patch flat', async () => {
  const grainy = await measure(
    await developBuffer(await patch(1200, 900, '#808080'), { recipe: grainOnly(6.5) }));
  assert.ok(Math.abs(grainy.mean - 128) < 1.5, `grain shifted exposure to ${grainy.mean.toFixed(2)}`);
  const clean = await measure(
    await developBuffer(await patch(1200, 900, '#808080'), { recipe: grainOnly(0) }));
  assert.equal(clean.std, 0, `grain 0 still laid down noise (std ${clean.std})`);
});

test('develop is size-agnostic — a 2560 px capture comes back 2560 px', async () => {
  const out = await developBuffer(await patch(2560, 1920, '#6a8fb0'),
    { recipe: grainOnly(3.5), stampText: "'26 9 13" });
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 2560);
  assert.equal(meta.height, 1920);
});
