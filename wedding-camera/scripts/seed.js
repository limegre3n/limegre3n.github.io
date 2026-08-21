/**
 * Seed the Firestore EMULATOR with the canonical test fixture (CONTRACTS §10).
 * Usage: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed.js
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import crypto from 'node:crypto';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to run: FIRESTORE_EMULATOR_HOST is not set (emulator-only script).');
  process.exit(1);
}

initializeApp({ projectId: 'demo-wedding' });
const db = getFirestore();

const PIN = '2468';
const SALT = 'test-salt';

const now = Date.now();
await db.doc('config/event').set({
  slug: 'testslug123',
  coupleNames: 'Alex & Sam',
  eventDateText: 'Saturday, 12 September 2026',
  startAt: Timestamp.fromMillis(now - 60 * 60 * 1000),        // opened an hour ago
  endAt: Timestamp.fromMillis(now + 24 * 60 * 60 * 1000),     // closes in 24h
  paused: false,
  defaultSnaps: 10,
  galleryReleased: false,
  theme: {
    welcomeText: 'Grab the camera and catch the moments we’ll miss!',
    consentText: 'Photos you take will be shared with the couple and may appear in the wedding gallery.',
    colors: { bg: '#141210', accent: '#e8b04b', text: '#f5efe6' },
    font: 'system',
    monogramText: 'A♥S',
    heroImagePath: null,
  },
});
await db.doc('config/private').set({
  eventCap: 2500,
  galleryPinSalt: SALT,
  galleryPinHash: crypto.createHash('sha256').update(SALT + PIN).digest('hex'),
  deleteBy: Timestamp.fromMillis(now + 120 * 24 * 60 * 60 * 1000),
});
await db.doc('counters/event').set({ photoCount: 0 });
console.log('Seeded demo-wedding: slug=testslug123 pin=%s', PIN);
process.exit(0);
