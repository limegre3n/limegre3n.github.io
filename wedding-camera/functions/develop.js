/**
 * Film development — the image half of CONTRACTS §11.
 *
 * Guests pick a "film stock" on the camera; the upload itself stays the clean original
 * and only carries the stock id. This module turns that original into the DEVELOPED
 * copy: the stock's look baked in with sharp, plus (when the couple enable it) a 90s
 * quartz-camera date stamp burned into the bottom-right corner.
 *
 * Deliberately free of Firestore/Storage: everything here is buffer in → buffer out, so
 * it can be exercised straight from a script (`scripts/develop-samples.js`) without the
 * emulator suite. `functions/index.js` owns the I/O and the bookkeeping.
 *
 * No fonts are used anywhere. The date stamp is hand-written seven-segment geometry, so
 * the pipeline never touches fontconfig (which is absent in the Functions runtime).
 */
const sharp = require('sharp');
const FILM_STOCKS = require('./film-stocks.json');

/** Canonical stock id used whenever the guest sent nothing, or something unknown. */
const DEFAULT_STOCK_ID = 'clean';

const STOCKS_BY_ID = new Map(
  (FILM_STOCKS.stocks || []).map((stock) => [stock.id, stock]));

/** Output quality for every developed copy (CONTRACTS §11). */
const DEVELOPED_QUALITY = 88;

/** Date-stamp geometry, all relative to the image so it scales with any capture size. */
const STAMP_HEIGHT_RATIO = 0.032;   // of the longer edge
const STAMP_MARGIN_X_RATIO = 0.03;  // of the width
const STAMP_MARGIN_Y_RATIO = 0.035; // of the height
const STAMP_COLOR = '#ff9a2e';
const STAMP_GLOW_COLOR = '#ffbe6a';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Numeric coercion that never lets a malformed recipe field poison the pipeline. */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Map whatever the guest app put in the `filter` metadata onto a known stock id.
 * Absent, non-string or unknown → 'clean' (CONTRACTS §11).
 *
 * @param {*} raw
 * @returns {string}
 */
function resolveStockId(raw) {
  return typeof raw === 'string' && STOCKS_BY_ID.has(raw) ? raw : DEFAULT_STOCK_ID;
}

/**
 * The server-side recipe for a stock id, or null for 'clean' / unknown ids.
 *
 * @param {string} id
 * @returns {object|null}
 */
function stockRecipe(id) {
  const stock = STOCKS_BY_ID.get(resolveStockId(id));
  return (stock && stock.recipe) || null;
}

/* ------------------------------------------------------------------ tone curve --- */

/**
 * Fold the recipe's contrast / lift / explicit linear / tint into ONE affine transform
 * per channel, so the whole tone curve costs a single `linear()` pass.
 *
 * Applied in order: contrast about mid-grey → black lift → explicit linear → tint.
 * The tint is normalised against its strongest channel, which makes it a pure colour
 * cast (the brightest channel is untouched, the others are pulled down) rather than an
 * exposure change hiding inside a colour.
 *
 * @param {object} recipe
 * @returns {{ a: number|number[], b: number|number[] }}
 */
function toneTransform(recipe) {
  const contrast = num(recipe.contrast, 1);
  const lift = clamp(num(recipe.lift, 0), 0, 40);
  const linear = Array.isArray(recipe.linear) && recipe.linear.length === 2
    ? [num(recipe.linear[0], 1), num(recipe.linear[1], 0)]
    : [1, 0];

  // y = contrast * (x - 128) + 128
  let a = contrast;
  let b = 128 * (1 - contrast);
  // y = ((255 - lift) / 255) * y + lift   — compresses into [lift, 255]
  const liftA = (255 - lift) / 255;
  a = liftA * a;
  b = liftA * b + lift;
  // y = linear[0] * y + linear[1]
  a = linear[0] * a;
  b = linear[0] * b + linear[1];

  const tint = recipe.tint;
  if (!Array.isArray(tint) || tint.length !== 3) return { a, b };
  const channels = tint.map((v) => clamp(num(v, 255), 0, 255));
  const peak = Math.max(...channels) || 255;
  const factors = channels.map((v) => v / peak);
  return { a: factors.map((f) => a * f), b: factors.map((f) => b * f) };
}

/**
 * Apply the colour/tone half of a recipe (everything before the composited overlays).
 *
 * @param {import('sharp').Sharp} pipe
 * @param {object|null} recipe
 * @returns {import('sharp').Sharp}
 */
function applyTone(pipe, recipe) {
  if (!recipe) return pipe;

  if (recipe.bw === true) {
    // Stay 3-band: the grain and vignette overlays below are sRGB, and libvips will not
    // silently band-expand a single-band base underneath them.
    pipe = pipe.greyscale().toColourspace('srgb');
  }

  const mod = recipe.modulate || {};
  const brightness = clamp(num(mod.brightness, 1), 0.2, 3);
  const saturation = recipe.bw === true ? 1 : clamp(num(mod.saturation, 1), 0, 3);
  const hue = recipe.bw === true ? 0 : Math.round(num(mod.hue, 0));
  if (brightness !== 1 || saturation !== 1 || hue !== 0) {
    pipe = pipe.modulate({ brightness, saturation, hue });
  }

  // sharp's gamma() decodes with the first exponent and re-encodes with the second, so
  // a near-identity decode plus `g` on the way out is the classic midtone lift.
  const gamma = recipe.gamma === null || recipe.gamma === undefined ? null : num(recipe.gamma, null);
  if (gamma !== null) pipe = pipe.gamma(1.0001, clamp(gamma, 1, 3));

  const { a, b } = toneTransform(recipe);
  pipe = pipe.linear(a, b);

  // A per-channel tint would have re-coloured a black & white stock; pull it back.
  if (recipe.bw === true) pipe = pipe.greyscale().toColourspace('srgb');
  return pipe;
}

/* -------------------------------------------------------------------- overlays --- */

/**
 * Grain geometry. One noise sample is one grain "cell", and there are always
 * GRAIN_CELLS_LONG_EDGE of them across the longer edge — so a cell is ~1 px on a
 * 1400 px photo and ~1.8 px on a 2560 px one. That is what makes the grain look the
 * same size at a given DISPLAY size instead of getting finer as uploads get bigger,
 * and it is why the layer is drawn small and scaled up rather than drawn per pixel.
 */
const GRAIN_CELLS_LONG_EDGE = 1400;
/** Soft-edge blur on the upscaled layer, in full-resolution pixels. */
const GRAIN_BLUR_SIGMA = 0.4;
/** libvips drops a blur kernel this shallow by default; ask for the real one. */
const GRAIN_BLUR_MIN_AMPLITUDE = 0.02;
/** Fraction of a white-noise RMS a bicubic enlargement keeps (measured, v8.15). */
const GRAIN_RESAMPLE_RETENTION = 0.817;
/** Autocorrelation width of one enlarged cell, in cells (fitted to the same runs). */
const GRAIN_CELL_SPREAD = 1.35;
/** How much grain survives in crushed blacks and blown highlights; 1 = no masking. */
const GRAIN_SHADOW_FLOOR = 0.45;

/**
 * Mid-tone weighting, `luma → 0..1`. Film grain is a mid-tone phenomenon: the emulsion
 * has nothing left to develop where it is clear or fully exposed. A parabola through
 * mid-grey, lifted off zero so the extremes thin out rather than go glassy.
 */
const MIDTONE_WEIGHT = new Float32Array(256);
for (let v = 0; v < 256; v += 1) {
  const t = v / 255;
  MIDTONE_WEIGHT[v] = GRAIN_SHADOW_FLOOR + (1 - GRAIN_SHADOW_FLOOR) * 4 * t * (1 - t);
}

/**
 * A luma thumbnail of the base, one sample per grain cell, used to modulate the grain.
 * Measured on the pre-tone image: the recipe shifts tones a little, but not enough to
 * move a pixel between "mid-tone" and "extreme", and this way it costs one reduction.
 *
 * @param {Buffer} base
 * @param {{ width: number, height: number, channels: number }} raw
 * @param {number} cellsW
 * @param {number} cellsH
 * @returns {Promise<Buffer>} cellsW * cellsH single-band luma
 */
function midtoneMask(base, raw, cellsW, cellsH) {
  // Green stands in for luma: it is ~59 % of it, it needs no full-resolution pass to
  // extract, and the mask only has to know shadow from mid-tone from highlight.
  return sharp(base, { raw })
    .extractChannel(1)
    .resize(cellsW, cellsH, { kernel: 'cubic' })
    .raw().toBuffer();
}

/**
 * One gaussian sample per grain cell, centred on mid-grey and scaled by the mid-tone
 * mask underneath it. Marsaglia polar, which yields two samples per pair of randoms.
 *
 * @param {number} count  cells to fill
 * @param {number} sigma  per-cell standard deviation, in 0..255 units
 * @param {Buffer} mask   `count` luma samples
 * @returns {Buffer} `count` single-band pixels
 */
function grainSamples(count, sigma, mask) {
  const out = Buffer.allocUnsafe(count);
  let i = 0;
  while (i < count) {
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = Math.random() * 2 - 1;
      v = Math.random() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const m = Math.sqrt((-2 * Math.log(s)) / s) * sigma;
    out[i] = clamp(Math.round(128 + u * m * MIDTONE_WEIGHT[mask[i]]), 0, 255);
    i += 1;
    if (i < count) {
      out[i] = clamp(Math.round(128 + v * m * MIDTONE_WEIGHT[mask[i]]), 0, 255);
      i += 1;
    }
  }
  return out;
}

/**
 * Monochrome film grain as an `overlay`-blended layer: mid-grey is a no-op, so only the
 * noise deviations reach the picture, and the blend's own response (strongest at
 * mid-grey, tapering to nothing at both ends) already behaves like an emulsion.
 *
 * The layer is drawn at one sample per grain cell, enlarged bicubically and softened,
 * which turns per-pixel hash into clumps with soft edges — the difference between
 * "film" and "a noisy sensor". Both steps eat amplitude (an enlargement averages
 * neighbouring cells, the blur averages neighbouring pixels), so the per-cell sigma is
 * divided back out by how much of it survives; the recipe's `grain` therefore stays the
 * standard deviation the picture actually receives, at any capture size.
 *
 * @param {Buffer} base   raw sRGB pixels the grain will sit on, for the mid-tone mask
 * @param {{ width: number, height: number, channels: number }} raw  shape of `base`
 * @param {number} sigma  recipe grain, 0..30
 * @returns {Promise<object>} a sharp composite entry
 */
async function grainLayer(base, raw, sigma) {
  const { width, height } = raw;
  const k = Math.max(1, Math.max(width, height) / GRAIN_CELLS_LONG_EDGE);
  const cellsW = Math.max(1, Math.round(width / k));
  const cellsH = Math.max(1, Math.round(height / k));
  // Below one cell per pixel there is nothing to enlarge, and nothing to compensate for.
  const enlarged = cellsW !== width || cellsH !== height;

  const spread = GRAIN_CELL_SPREAD * (enlarged ? k : 1);
  // Variance a gaussian blur leaves on a gaussian-correlated field of width `spread`.
  const blurKept = (spread * spread) / (spread * spread + 2 * GRAIN_BLUR_SIGMA ** 2);
  const kept = (enlarged ? GRAIN_RESAMPLE_RETENTION : 1) * blurKept;

  const mask = await midtoneMask(base, raw, cellsW, cellsH);
  const cells = grainSamples(cellsW * cellsH, clamp(sigma, 0, 30) / kept, mask);

  let layer = sharp(cells, { raw: { width: cellsW, height: cellsH, channels: 1 } });
  if (enlarged) layer = layer.resize(width, height, { kernel: 'cubic' });
  // Three bands, because libvips will not band-expand a b-w layer over an sRGB base.
  const input = await layer
    .blur({ sigma: GRAIN_BLUR_SIGMA, minAmplitude: GRAIN_BLUR_MIN_AMPLITUDE })
    .toColourspace('srgb')
    .raw().toBuffer();
  return { input, raw: { width, height, channels: 3 }, blend: 'overlay' };
}

/**
 * How much smaller than the picture the vignette gradient is rasterised. Rasterising an
 * SVG gradient at 2560 px costs ~200 ms and nothing in it is higher-frequency than a
 * few hundred pixels, so it is drawn small and scaled back up.
 */
const VIGNETTE_RASTER_DIVISOR = 4;

/**
 * Soft elliptical vignette as a `multiply`-blended radial gradient: white in the middle
 * (a no-op) darkening towards the corners.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} strength  recipe vignette, 0..1
 * @returns {Promise<object>} a sharp composite entry
 */
async function vignetteLayer(width, height, strength) {
  const edge = Math.round(255 * (1 - clamp(strength, 0, 1)));
  const hex = edge.toString(16).padStart(2, '0').repeat(3);
  const rasterW = Math.max(2, Math.round(width / VIGNETTE_RASTER_DIVISOR));
  const rasterH = Math.max(2, Math.round(height / VIGNETTE_RASTER_DIVISOR));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${rasterW}" height="${rasterH}" `
    + `viewBox="0 0 ${width} ${height}">`
    + '<defs><radialGradient id="v" cx="50%" cy="50%" r="72%">'
    + '<stop offset="42%" stop-color="#ffffff"/>'
    + `<stop offset="100%" stop-color="#${hex}"/>`
    + '</radialGradient></defs>'
    + `<rect width="${width}" height="${height}" fill="url(#v)"/></svg>`;
  const input = await sharp(Buffer.from(svg))
    .removeAlpha()
    .toColourspace('b-w')
    .resize(width, height, { kernel: 'cubic' })
    .toColourspace('srgb')
    .raw().toBuffer();
  return { input, raw: { width, height, channels: 3 }, blend: 'multiply' };
}

/* ------------------------------------------------------------------ date stamp --- */

/**
 * Seven-segment glyph cell. A digit occupies CELL_W x CELL_H units; every segment is a
 * hexagon with mitred ends, exactly like an LCD element.
 *
 *    aaa
 *   f   b
 *    ggg
 *   e   c
 *    ddd
 */
const CELL_W = 100;
const CELL_H = 180;
const SEG_T = 20;            // segment thickness
const SEG_GAP = 6;           // gap between neighbouring segments
const SEG_L = 12;            // left rail
const SEG_R = 88;            // right rail
const SEG_TOP = 12;
const SEG_MID = 90;
const SEG_BOT = 168;
/** Space between glyph cells, and the advance of the two non-digit glyphs. */
const GLYPH_GAP = 30;
const APOSTROPHE_W = 46;
const SPACE_W = 46;
/** Italic lean, matching the slightly slanted digits of a quartz-date back. */
const SKEW_DEG = 8;
/** Padding around the glyph run so the glow is not clipped by the SVG viewport. */
const STAMP_PAD = 26;

const half = SEG_T / 2;

/** Horizontal segment (a, g, d) as a mitred hexagon. */
function hSeg(y, x0, x1) {
  return `M${x0},${y} L${x0 + half},${y - half} L${x1 - half},${y - half} `
    + `L${x1},${y} L${x1 - half},${y + half} L${x0 + half},${y + half} Z`;
}

/** Vertical segment (b, c, e, f) as a mitred hexagon. */
function vSeg(x, y0, y1) {
  return `M${x},${y0} L${x + half},${y0 + half} L${x + half},${y1 - half} `
    + `L${x},${y1} L${x - half},${y1 - half} L${x - half},${y0 + half} Z`;
}

const SEGMENTS = {
  a: hSeg(SEG_TOP, SEG_L + SEG_GAP, SEG_R - SEG_GAP),
  g: hSeg(SEG_MID, SEG_L + SEG_GAP, SEG_R - SEG_GAP),
  d: hSeg(SEG_BOT, SEG_L + SEG_GAP, SEG_R - SEG_GAP),
  f: vSeg(SEG_L, SEG_TOP + SEG_GAP, SEG_MID - SEG_GAP),
  b: vSeg(SEG_R, SEG_TOP + SEG_GAP, SEG_MID - SEG_GAP),
  e: vSeg(SEG_L, SEG_MID + SEG_GAP, SEG_BOT - SEG_GAP),
  c: vSeg(SEG_R, SEG_MID + SEG_GAP, SEG_BOT - SEG_GAP),
};

/** Which segments are lit for each digit. */
const DIGIT_SEGMENTS = {
  0: 'abcdef',
  1: 'bc',
  2: 'abged',
  3: 'abgcd',
  4: 'fgbc',
  5: 'afgcd',
  6: 'afgecd',
  7: 'abc',
  8: 'abcdefg',
  9: 'abfgcd',
};

/** The apostrophe of `'26` — a tapered tick hung from the top of the cell. */
const APOSTROPHE_PATH = 'M22,8 L44,8 L28,68 L10,68 Z';

/**
 * Lay the stamp text out as SVG path data in glyph-cell units.
 *
 * @param {string} text  digits, spaces and a leading apostrophe
 * @returns {{ paths: string, width: number }}
 */
function layoutGlyphs(text) {
  const paths = [];
  let x = 0;
  for (const ch of text) {
    if (ch === ' ') { x += SPACE_W + GLYPH_GAP; continue; }
    if (ch === "'") {
      paths.push(`<path transform="translate(${x},0)" d="${APOSTROPHE_PATH}"/>`);
      x += APOSTROPHE_W + GLYPH_GAP;
      continue;
    }
    const lit = DIGIT_SEGMENTS[ch];
    if (!lit) continue;
    const d = [...lit].map((s) => SEGMENTS[s]).join(' ');
    paths.push(`<path transform="translate(${x},0)" d="${d}"/>`);
    x += CELL_W + GLYPH_GAP;
  }
  return { paths: paths.join(''), width: Math.max(0, x - GLYPH_GAP) };
}

/**
 * Render the date stamp: hand-drawn seven-segment digits in quartz orange, softened by
 * a blur and sat on a wider blurred copy so it reads as a glowing LCD burn-in rather
 * than crisp vector text.
 *
 * @param {string} text        e.g. `'26 9 13`
 * @param {number} cellHeight  rendered height of one digit, in pixels
 * @returns {{ input: Buffer, width: number, height: number, inkPad: number }}
 */
function dateStampLayer(text, cellHeight) {
  const { paths, width } = layoutGlyphs(text);
  const skewShift = Math.tan((SKEW_DEG * Math.PI) / 180) * CELL_H;
  const viewW = width + skewShift + STAMP_PAD * 2;
  const viewH = CELL_H + STAMP_PAD * 2;
  const scale = cellHeight / CELL_H;
  const pxW = Math.max(1, Math.round(viewW * scale));
  const pxH = Math.max(1, Math.round(viewH * scale));

  // skewX(-8) shifts the top of each glyph right and leaves the baseline where it is,
  // so the run is pre-translated by the full shift to keep it inside the viewBox.
  const group = `transform="translate(${STAMP_PAD + skewShift},${STAMP_PAD}) skewX(${-SKEW_DEG})"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${pxH}" `
    + `viewBox="0 0 ${viewW} ${viewH}">`
    + '<defs>'
    + '<filter id="glow" x="-40%" y="-40%" width="180%" height="180%">'
    + '<feGaussianBlur stdDeviation="7"/></filter>'
    + '<filter id="soft" x="-20%" y="-20%" width="140%" height="140%">'
    + '<feGaussianBlur stdDeviation="1.8"/></filter>'
    + '</defs>'
    + `<g ${group}>`
    + `<g filter="url(#glow)" fill="${STAMP_GLOW_COLOR}" opacity="0.7">${paths}</g>`
    + `<g filter="url(#soft)" fill="${STAMP_COLOR}">${paths}</g>`
    + '</g></svg>';

  return {
    input: Buffer.from(svg),
    width: pxW,
    height: pxH,
    inkPad: Math.round(STAMP_PAD * scale),
  };
}

/**
 * The stamp text for a capture: `'YY M D`, apostrophe + 2-digit year then month and day
 * with NO zero padding, in the guest's own local time.
 *
 * @param {number} capturedAtMs     epoch millis (UTC)
 * @param {number} tzOffsetMinutes  minutes to ADD to UTC for the guest's local time
 * @returns {string}
 */
function dateStampText(capturedAtMs, tzOffsetMinutes) {
  const ms = num(capturedAtMs, Date.now());
  const offset = clamp(num(tzOffsetMinutes, 0), -840, 840);
  const local = new Date(ms + offset * 60 * 1000);
  const yy = String(local.getUTCFullYear() % 100).padStart(2, '0');
  return `'${yy} ${local.getUTCMonth() + 1} ${local.getUTCDate()}`;
}

/* --------------------------------------------------------------------- develop --- */

/**
 * Develop one image: recipe, grain, vignette and the optional date stamp, out as JPEG.
 *
 * The tone pass is flushed to a raw buffer first so the overlay geometry is measured
 * AFTER `rotate()` has honoured any EXIF orientation — the guest app already strips
 * EXIF, but an original that arrives another way must not stamp its own corner.
 * Metadata is never carried over: the developed copy has no EXIF at all.
 *
 * @param {Buffer} buffer                 the original JPEG bytes
 * @param {object} [opts]
 * @param {object|null} [opts.recipe]     film-stock recipe, or null for a clean pass
 * @param {string|null} [opts.stampText]  date-stamp text, or null for no stamp
 * @returns {Promise<Buffer>} developed JPEG
 */
async function developBuffer(buffer, { recipe = null, stampText = null } = {}) {
  // Stage 1 — decode, honour orientation, and normalise to three sRGB bands. `rotate()`
  // is why this is its own stage at all: the overlay geometry below must be measured on
  // the FINAL orientation. The band normalisation needs an output boundary too — a
  // greyscale or CMYK JPEG (both of which a phone can legitimately produce) would
  // otherwise reach `linear()` with one band, which libvips will not band-expand.
  const { data, info } = await sharp(buffer, { failOn: 'none' })
    .rotate().toColourspace('srgb').removeAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const layers = [];
  if (recipe && num(recipe.grain, 0) > 0) {
    layers.push(await grainLayer(data, { width, height, channels }, num(recipe.grain, 0)));
  }
  if (recipe && num(recipe.vignette, 0) > 0) {
    layers.push(await vignetteLayer(width, height, num(recipe.vignette, 0)));
  }
  if (stampText) {
    const longEdge = Math.max(width, height);
    const stamp = dateStampLayer(stampText, Math.max(8, Math.round(longEdge * STAMP_HEIGHT_RATIO)));
    // A thumbnail-sized original has nowhere to put a legible stamp; silently skip it
    // rather than fail the whole develop (libvips refuses an oversized composite).
    if (stamp.width <= width && stamp.height <= height) {
      // The ink stops `inkPad` inside the layer, so margins are measured from the ink.
      const left = clamp(
        Math.round(width - width * STAMP_MARGIN_X_RATIO - stamp.width + stamp.inkPad),
        0, width - stamp.width);
      const top = clamp(
        Math.round(height - height * STAMP_MARGIN_Y_RATIO - stamp.height + stamp.inkPad),
        0, height - stamp.height);
      layers.push({ input: stamp.input, left, top });
    }
  }

  // Stage 2 — tone curve then overlays. sharp applies its colour operations before the
  // composites, which is exactly the order the recipe wants.
  let out = applyTone(sharp(data, { raw: { width, height, channels } }), recipe);
  if (layers.length) out = out.composite(layers);
  return out.jpeg({ quality: DEVELOPED_QUALITY }).toBuffer();
}

/**
 * Does this photo need a developed copy at all? (CONTRACTS §11.)
 *
 * @param {string} stockId          resolved film-stock id
 * @param {object} cfg              `config/event` data
 * @returns {boolean}
 */
function needsDevelop(stockId, cfg) {
  return resolveStockId(stockId) !== DEFAULT_STOCK_ID || (cfg && cfg.dateStamp === true);
}

module.exports = {
  DEFAULT_STOCK_ID,
  DEVELOPED_QUALITY,
  FILM_STOCKS,
  dateStampLayer,
  dateStampText,
  developBuffer,
  needsDevelop,
  resolveStockId,
  stockRecipe,
};
