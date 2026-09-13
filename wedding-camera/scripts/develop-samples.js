/**
 * Render one sample per film stock so the look can actually be eyeballed
 * (CONTRACTS §11 — "make the recipes look like their names").
 *
 * Runs entirely offline: no emulator, no Firestore, no Storage.
 *
 *   node scripts/develop-samples.js [--in photo.jpg] [--out /tmp/samples] [--no-stamp]
 *
 * With no `--in` it synthesises a reference scene (sky, foliage, skin tones, a white
 * dress against a dark suit, plus colour and greyscale ramps) — enough to judge warmth,
 * saturation, black lift, grain and vignette without shipping a binary fixture.
 * Writes `stock-original.jpg` plus `stock-<id>.jpg` for every stock.
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

const WIDTH = 1600;
const HEIGHT = 1200;

/** A synthetic "wedding photo" with the tones every recipe is judged on. */
function referenceScene() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
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

mkdirSync(outDir, { recursive: true });
const original = inPath ? readFileSync(inPath) : await referenceScene();
writeFileSync(join(outDir, 'stock-original.jpg'), original);

// A fixed date so repeated runs are byte-comparable; matches the contract example.
const stampText = withStamp ? dateStampText(Date.UTC(2026, 8, 13, 4, 30), 480) : null;

for (const stock of FILM_STOCKS.stocks) {
  const out = await developBuffer(original, { recipe: stockRecipe(stock.id), stampText });
  const file = join(outDir, `stock-${stock.id}.jpg`);
  writeFileSync(file, out);
  console.log(`${stock.id.padEnd(9)} ${String(out.length).padStart(8)} bytes  ${file}`);
}
console.log(`\noriginal: ${join(outDir, 'stock-original.jpg')}   stamp: ${stampText || '(none)'}`);
