/**
 * Render one sample per film stock so the look can actually be eyeballed
 * (CONTRACTS §11 — "make the recipes look like their names").
 *
 * Runs entirely offline: no emulator, no Firestore, no Storage.
 *
 *   node scripts/develop-samples.js [--in photo.jpg] [--out /tmp/samples]
 *                                   [--no-stamp] [--long 2560] [--sensor-noise 6]
 *
 * With no `--in` it synthesises a reference scene (sky, foliage, skin tones, a white
 * dress against a dark suit, plus colour and greyscale ramps) — enough to judge warmth,
 * saturation, black lift, grain and vignette without shipping a binary fixture. The
 * scene is authored in 1600x1200 units and rasterised at `--long` (default 2560, the
 * guest app's capture size) so the grain is judged at the size it will actually ship at.
 *
 * Writes, into `--out`:
 *   stock-original.jpg, stock-<id>.jpg   the clean scene and its six developments
 *   contact-sheet.jpg                    all six tiled, catalogue order, row-major
 *   noisy-original.jpg, noisy-<id>.jpg   the same, over a scene carrying sensor noise
 *   noisy-sheet.jpg                      (`--sensor-noise` sigma, default 6) — this is
 *                                        the honest test: grain has to read as grain on
 *                                        top of a phone frame that is already noisy
 *   crop-<id>.png                        100 % crops over the mid-grey ramp patches,
 *                                        for silver and golden, clean and noisy
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('../functions/node_modules/sharp');
const {
  FILM_STOCKS, developBuffer, stockRecipe, dateStampText,
} = require('../functions/develop.js');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const outDir = arg('out', '/tmp/film-samples');
const inPath = arg('in', null);
const withStamp = !process.argv.includes('--no-stamp');
/** Long edge of the rasterised scene — the guest app uploads at 2560 (CAMERA-007). */
const LONG_EDGE = Math.max(320, Number(arg('long', 2560)) || 2560);
/** Sensor noise added to the "dim room" variant, in 0..255 units. */
const SENSOR_SIGMA = Math.max(0, Number(arg('sensor-noise', 6)) || 6);

/** Scene authoring units. The SVG below is written against these. */
const WIDTH = 1600;
const HEIGHT = 1200;
/** Rasterised size: the authoring units scaled up to LONG_EDGE via the viewBox. */
const OUT_W = Math.round(LONG_EDGE);
const OUT_H = Math.round((LONG_EDGE * HEIGHT) / WIDTH);

/** A synthetic "wedding photo" with the tones every recipe is judged on. */
function referenceScene() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_W}" height="${OUT_H}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#5c8fc4"/>
      <stop offset="55%" stop-color="#bcd3e6"/>
      <stop offset="100%" stop-color="#e8dcc6"/>
    </linearGradient>
    <radialGradient id="sun" cx="78%" cy="16%" r="30%">
      <stop offset="0%" stop-color="#fffdf4" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#fffdf4" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="grass" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#5d7a3a"/>
      <stop offset="100%" stop-color="#33491f"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#sky)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#sun)"/>
  <rect y="740" width="${WIDTH}" height="460" fill="url(#grass)"/>
  <!-- foliage -->
  <ellipse cx="170" cy="640" rx="240" ry="300" fill="#2f4a23"/>
  <ellipse cx="330" cy="720" rx="190" ry="230" fill="#3f5f2b"/>
  <ellipse cx="1470" cy="600" rx="260" ry="330" fill="#27401f"/>
  <ellipse cx="1300" cy="720" rx="180" ry="220" fill="#446330"/>
  <!-- bride: white dress, light skin -->
  <path d="M760 470 q60 -40 120 0 l70 470 q-130 40 -260 0 Z" fill="#f6f1e8"/>
  <path d="M760 470 q60 -40 120 0 l18 120 q-78 26 -156 0 Z" fill="#e6ded1"/>
  <circle cx="820" cy="404" r="66" fill="#eac3a3"/>
  <path d="M754 392 a66 66 0 0 1 132 0 q-18 -52 -66 -52 q-48 0 -66 52 Z" fill="#4a3524"/>
  <!-- groom: dark suit, deeper skin -->
  <path d="M980 480 q64 -42 128 0 l58 460 q-126 38 -244 0 Z" fill="#1e2433"/>
  <path d="M1030 486 l14 96 l30 -96 Z" fill="#f2efe9"/>
  <circle cx="1044" cy="414" r="64" fill="#9c6a45"/>
  <path d="M980 404 a64 64 0 0 1 128 0 q-14 -50 -64 -50 q-50 0 -64 50 Z" fill="#20160f"/>
  <!-- bouquet: saturated flowers -->
  <circle cx="900" cy="700" r="42" fill="#d8455f"/>
  <circle cx="946" cy="676" r="34" fill="#f0d34a"/>
  <circle cx="864" cy="668" r="30" fill="#f4efe4"/>
  <circle cx="924" cy="742" r="30" fill="#b23a72"/>
  <!-- colour patches -->
  <g>
    <rect x="60" y="1060" width="110" height="100" fill="#c0392b"/>
    <rect x="170" y="1060" width="110" height="100" fill="#27ae60"/>
    <rect x="280" y="1060" width="110" height="100" fill="#2874c8"/>
    <rect x="390" y="1060" width="110" height="100" fill="#16a3a3"/>
    <rect x="500" y="1060" width="110" height="100" fill="#a83fa0"/>
    <rect x="610" y="1060" width="110" height="100" fill="#e0b429"/>
    <rect x="720" y="1060" width="110" height="100" fill="#e7b99a"/>
  </g>
  <!-- greyscale ramp -->
  <g>
    <rect x="880" y="1060" width="100" height="100" fill="#000000"/>
    <rect x="980" y="1060" width="100" height="100" fill="#202020"/>
    <rect x="1080" y="1060" width="100" height="100" fill="#4d4d4d"/>
    <rect x="1180" y="1060" width="100" height="100" fill="#808080"/>
    <rect x="1280" y="1060" width="100" height="100" fill="#b3b3b3"/>
    <rect x="1380" y="1060" width="100" height="100" fill="#e0e0e0"/>
    <rect x="1480" y="1060" width="100" height="100" fill="#ffffff"/>
  </g>
</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

/**
 * Additive gaussian sensor noise, the kind a phone puts in a dim-room frame before the
 * developer ever sees it. Per channel and NOT luminance-weighted — that is the point:
 * it is the thing film grain has to stay distinguishable from.
 *
 * @param {Buffer} jpeg
 * @param {number} sigma  0..255 units
 * @returns {Promise<Buffer>}
 */
async function addSensorNoise(jpeg, sigma) {
  if (sigma <= 0) return jpeg;
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  let i = 0;
  while (i < data.length) {
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = Math.random() * 2 - 1;
      v = Math.random() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const m = Math.sqrt((-2 * Math.log(s)) / s) * sigma;
    data[i] = Math.max(0, Math.min(255, Math.round(data[i] + u * m)));
    i += 1;
    if (i < data.length) {
      data[i] = Math.max(0, Math.min(255, Math.round(data[i] + v * m)));
      i += 1;
    }
  }
  return sharp(data, { raw: info }).jpeg({ quality: 92 }).toBuffer();
}

/** Every stock at a glance: catalogue order, row-major, three across. */
async function contactSheet(buffers) {
  const cols = 3;
  const rows = Math.ceil(buffers.length / cols);
  const tileW = 720;
  const tileH = Math.round((tileW * OUT_H) / OUT_W);
  const gap = 12;
  const tiles = await Promise.all(buffers.map(async (buf, i) => ({
    input: await sharp(buf).resize(tileW, tileH, { fit: 'fill' }).toBuffer(),
    left: gap + (i % cols) * (tileW + gap),
    top: gap + Math.floor(i / cols) * (tileH + gap),
  })));
  return sharp({
    create: {
      width: cols * tileW + (cols + 1) * gap,
      height: rows * tileH + (rows + 1) * gap,
      channels: 3,
      background: '#141414',
    },
  }).composite(tiles).jpeg({ quality: 90 }).toBuffer();
}

/**
 * A 1:1 crop across the greyscale ramp (#202020 → #b3b3b3) and the sky above it — flat
 * areas, where grain either reads as film or reads as noise. PNG so nothing is hidden
 * by a second round of JPEG, and always off a stamp-free development so seven-segment
 * digits do not land in the middle of the one thing the crop exists to show.
 */
function midGreyCrop(buffer) {
  const s = OUT_W / WIDTH;
  const left = Math.round(940 * s);
  const top = Math.round(960 * s);
  const width = Math.min(Math.round(400 * s), OUT_W - left);
  const height = Math.min(Math.round(215 * s), OUT_H - top);
  return sharp(buffer).extract({ left, top, width, height }).png().toBuffer();
}

mkdirSync(outDir, { recursive: true });
const original = inPath ? readFileSync(inPath) : await referenceScene();
const noisyOriginal = await addSensorNoise(original, SENSOR_SIGMA);
writeFileSync(join(outDir, 'stock-original.jpg'), original);
writeFileSync(join(outDir, 'noisy-original.jpg'), noisyOriginal);

// A fixed date so repeated runs are byte-comparable; matches the contract example.
const stampText = withStamp ? dateStampText(Date.UTC(2026, 8, 13, 4, 30), 480) : null;

const CROP_STOCKS = new Set(['silver', 'golden']);
const sheets = { stock: [], noisy: [] };

for (const stock of FILM_STOCKS.stocks) {
  const recipe = stockRecipe(stock.id);
  for (const [prefix, src] of [['stock', original], ['noisy', noisyOriginal]]) {
    const started = Date.now();
    const out = await developBuffer(src, { recipe, stampText });
    sheets[prefix].push(out);
    const file = join(outDir, `${prefix}-${stock.id}.jpg`);
    writeFileSync(file, out);
    console.log(`${prefix.padEnd(5)} ${stock.id.padEnd(9)} ${String(out.length).padStart(8)} bytes`
      + `  ${String(Date.now() - started).padStart(5)} ms  ${file}`);
    if (!CROP_STOCKS.has(stock.id)) continue;
    const cropName = prefix === 'stock' ? `crop-${stock.id}.png` : `crop-noisy-${stock.id}.png`;
    const bare = stampText ? await developBuffer(src, { recipe, stampText: null }) : out;
    writeFileSync(join(outDir, cropName), await midGreyCrop(bare));
  }
}

writeFileSync(join(outDir, 'contact-sheet.jpg'), await contactSheet(sheets.stock));
writeFileSync(join(outDir, 'noisy-sheet.jpg'), await contactSheet(sheets.noisy));

const order = FILM_STOCKS.stocks.map((s) => s.id).join(', ');
console.log(`\nscene: ${OUT_W}x${OUT_H}   sensor noise sigma: ${SENSOR_SIGMA}   stamp: ${stampText || '(none)'}`);
console.log(`sheets: ${join(outDir, 'contact-sheet.jpg')} / noisy-sheet.jpg — row-major: ${order}`);
