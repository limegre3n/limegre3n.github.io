/**
 * Interactive provisioning of the event configuration (DEPLOYMENT.md Step 6).
 * Writes config/event, config/private and counters/event with correct types, so
 * nobody has to hand-type ~30 fields into the Firestore console.
 *
 * Production:
 *   GOOGLE_APPLICATION_CREDENTIALS=sa.json GCLOUD_PROJECT=<project-id> node scripts/setup-event.js
 * Emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/setup-event.js
 *
 * Re-running is safe: it shows the existing values as defaults and overwrites only
 * the three config documents (photos, devices and counters are never touched, except
 * counters/event which is created only if missing).
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';

const isEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
if (!isEmulator && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS=sa.json (production) or FIRESTORE_EMULATOR_HOST (emulator).');
  process.exit(1);
}
const projectId = process.env.GCLOUD_PROJECT || (isEmulator ? 'demo-wedding' : null);
if (!projectId) {
  console.error('Set GCLOUD_PROJECT=<your-firebase-project-id>.');
  process.exit(1);
}

initializeApp({ projectId });
const db = getFirestore();

// Line reader that works both interactively and with piped/scripted input: lines that
// arrive before a question is asked are buffered instead of being lost.
const rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
const pendingLines = [];
const waiters = [];
let closed = false;
rl.on('line', (line) => { const w = waiters.shift(); if (w) w(line); else pendingLines.push(line); });
rl.on('close', () => { closed = true; for (const w of waiters.splice(0)) w(null); });
function question(prompt) {
  stdout.write(prompt);
  if (pendingLines.length) { const l = pendingLines.shift(); if (!stdin.isTTY) stdout.write(`${l}\n`); return Promise.resolve(l); }
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => waiters.push(resolve));
}

const FONTS = ['system', 'serif', 'mono', 'rounded'];
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

async function ask(label, { def, validate, secret = false } = {}) {
  for (;;) {
    const suffix = def !== undefined && def !== null && def !== '' ? ` [${secret ? '••••' : def}]` : '';
    const answer = await question(`${label}${suffix}: `);
    if (answer === null) { console.error('\nInput ended before setup finished — nothing written.'); process.exit(1); }
    const raw = answer.trim();
    const value = raw === '' && def !== undefined ? String(def) : raw;
    const problem = validate ? validate(value) : null;
    if (!problem) return value;
    console.log(`  ✗ ${problem}`);
  }
}

function parseLocalDateTime(s) {
  // Accepts "2026-09-12 14:00" (local time of this computer) or an ISO string.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
const fmt = (d) => d.toLocaleString(undefined, {
  weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const randomSlug = () => crypto.randomBytes(8).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 10);

const existing = (await db.doc('config/event').get()).data() || {};
const existingPriv = (await db.doc('config/private').get()).data() || {};
const theme = existing.theme || {};
const colors = theme.colors || {};

console.log(`\nWedding camera — event setup for project "${projectId}"${isEmulator ? ' (EMULATOR)' : ''}`);
console.log('Press Enter to accept a [default]. Dates/times are in THIS computer\'s time zone.\n');

const coupleNames = await ask('Couple names (e.g. Alex & Sam)', {
  def: existing.coupleNames, validate: (v) => (v.length >= 1 && v.length <= 200 ? null : '1–200 characters'),
});
const eventDateText = await ask('Date as shown to guests (e.g. Saturday, 12 September 2026)', {
  def: existing.eventDateText, validate: (v) => (v.length >= 1 && v.length <= 200 ? null : '1–200 characters'),
});
const startAt = parseLocalDateTime(await ask('Camera opens (YYYY-MM-DD HH:MM, ~2h before ceremony)', {
  def: existing.startAt ? existing.startAt.toDate().toISOString().slice(0, 16).replace('T', ' ') : undefined,
  validate: (v) => (parseLocalDateTime(v) ? null : 'Use the form 2026-09-12 14:00'),
}));
const endAt = parseLocalDateTime(await ask('Camera closes (YYYY-MM-DD HH:MM, ~noon the day after)', {
  def: existing.endAt ? existing.endAt.toDate().toISOString().slice(0, 16).replace('T', ' ') : undefined,
  validate: (v) => {
    const d = parseLocalDateTime(v);
    if (!d) return 'Use the form 2026-09-13 12:00';
    return d > startAt ? null : 'Must be after the opening time';
  },
}));
const slug = await ask('Secret link slug (letters/digits; becomes the QR URL)', {
  def: existing.slug || randomSlug(),
  validate: (v) => (/^[A-Za-z0-9]{6,32}$/.test(v) ? null : '6–32 letters/digits, no spaces or symbols'),
});
const defaultSnaps = Number(await ask('Snaps per guest phone', {
  def: existing.defaultSnaps ?? 10, validate: (v) => (/^\d+$/.test(v) && +v >= 1 && +v <= 100 ? null : 'Whole number 1–100'),
}));
const eventCap = Number(await ask('Event-wide photo cap (safety limit)', {
  def: existingPriv.eventCap ?? 2500, validate: (v) => (/^\d+$/.test(v) && +v >= 10 ? null : 'Whole number ≥ 10'),
}));
const welcomeText = await ask('Welcome text', {
  def: theme.welcomeText || 'Grab the camera and catch the moments we’ll miss!',
  validate: (v) => (v.length <= 500 ? null : 'Max 500 characters'),
});
const consentText = await ask('Consent line (shown before the first photo)', {
  def: theme.consentText || 'Photos you take will be shared with the couple and may appear in the wedding gallery.',
  validate: (v) => (v.length >= 10 && v.length <= 500 ? null : '10–500 characters — guests must see a consent notice'),
});
const monogramText = await ask('Monogram (e.g. A♥S)', {
  def: theme.monogramText || '', validate: (v) => (v.length <= 16 ? null : 'Max 16 characters'),
});
const dateStamp = (await ask('Burn a 90s orange date stamp into developed photos? (yes/no)', {
  def: existing.dateStamp === false ? 'no' : 'yes',
  validate: (v) => (/^(yes|no)$/i.test(v) ? null : 'yes or no'),
})).toLowerCase() === 'yes';
const font = await ask(`Font (${FONTS.join(' / ')})`, {
  def: theme.font || 'system', validate: (v) => (FONTS.includes(v) ? null : `One of: ${FONTS.join(', ')}`),
});
const hexAsk = (label, def) => ask(label, { def, validate: (v) => (HEX.test(v) ? null : 'Hex colour like #e8b04b') });
const bg = await hexAsk('Background colour', colors.bg || '#141210');
const accent = await hexAsk('Accent colour', colors.accent || '#e8b04b');
const text = await hexAsk('Text colour', colors.text || '#f5efe6');

let pin;
let galleryPinSalt = existingPriv.galleryPinSalt;
let galleryPinHash = existingPriv.galleryPinHash;
const pinAnswer = await ask(existingPriv.galleryPinHash
  ? 'Gallery PIN (4–6 digits; press Enter to keep the current one)'
  : 'Gallery PIN (4–6 digits)', {
  def: existingPriv.galleryPinHash ? '' : undefined,
  validate: (v) => (v === '' && existingPriv.galleryPinHash) || /^\d{4,6}$/.test(v) ? null : '4–6 digits',
});
if (pinAnswer !== '') {
  pin = pinAnswer;
  galleryPinSalt = crypto.randomBytes(8).toString('hex');
  galleryPinHash = crypto.createHash('sha256').update(galleryPinSalt + pin).digest('hex');
}
const deleteBy = parseLocalDateTime(await ask('Delete everything by (YYYY-MM-DD HH:MM, ~3 months after)', {
  def: existingPriv.deleteBy
    ? existingPriv.deleteBy.toDate().toISOString().slice(0, 16).replace('T', ' ')
    : new Date(endAt.getTime() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
  validate: (v) => (parseLocalDateTime(v) ? null : 'Use the form 2026-12-13 12:00'),
}));

console.log('\nAbout to write:');
console.log(`  Couple:      ${coupleNames} — ${eventDateText}`);
console.log(`  Window:      ${fmt(startAt)}  →  ${fmt(endAt)}  (+7 days upload grace)`);
console.log(`  Slug:        ${slug}`);
console.log(`  Snaps/phone: ${defaultSnaps}   Event cap: ${eventCap}`);
console.log(`  Theme:       ${font}, ${bg} / ${accent} / ${text}, monogram "${monogramText}"`);
console.log(`  Date stamp:  ${dateStamp ? 'on' : 'off'}`);
console.log(`  Gallery PIN: ${pin ? pin : '(unchanged)'}   Delete by: ${fmt(deleteBy)}`);
const ok = await ask('Write these to Firestore? (yes/no)', { validate: (v) => (/^(yes|no)$/i.test(v) ? null : 'yes or no') });
if (ok.toLowerCase() !== 'yes') { console.log('Cancelled — nothing written.'); rl.close(); process.exit(0); }

await db.doc('config/event').set({
  slug, coupleNames, eventDateText,
  startAt: Timestamp.fromDate(startAt), endAt: Timestamp.fromDate(endAt),
  paused: existing.paused === true, defaultSnaps,
  galleryReleased: existing.galleryReleased === true,
  dateStamp,
  theme: { welcomeText, consentText, font, monogramText, heroImagePath: theme.heroImagePath ?? null,
    colors: { bg, accent, text } },
});
await db.doc('config/private').set({
  eventCap, galleryPinSalt, galleryPinHash, deleteBy: Timestamp.fromDate(deleteBy),
});
const counter = await db.doc('counters/event').get();
if (!counter.exists) await db.doc('counters/event').set({ photoCount: 0 });

rl.close();
const host = isEmulator ? 'http://localhost:5173' : `https://${projectId}.web.app`;
console.log('\n✓ Event configuration written.');
console.log(`  Guest / QR link:  ${host}/e/${slug}/`);
console.log(`  Admin:            ${host}/admin/`);
console.log(`  Gallery:          ${host}/gallery/${slug}/   PIN: ${pin ? pin : '(unchanged)'}`);
console.log('\nNext: create the admin login (scripts/set-admin.js), then run scripts/smoke-test.js.');
process.exit(0);
