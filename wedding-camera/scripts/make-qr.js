/**
 * Generate the printable QR code for the guest link.
 *   node scripts/make-qr.js            (reads the slug from config/event via app/.env.production)
 *   node scripts/make-qr.js <slug>     (explicit slug)
 * Writes wedding-qr.png (1200×1200, high error correction — survives small prints and
 * dim light) and wedding-qr.svg (for designers/printers) into the wedding-camera folder.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import QRCode from 'qrcode';

const envPath = new URL('../app/.env.production', import.meta.url);
if (!existsSync(envPath)) { console.error('app/.env.production not found — complete DEPLOYMENT.md Step 4 first.'); process.exit(1); }
const env = Object.fromEntries(readFileSync(envPath, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

let slug = process.argv[2];
if (!slug) {
  const { initializeApp } = await import('firebase/app');
  const { getAuth, signInAnonymously } = await import('firebase/auth');
  const { getFirestore, doc, getDoc } = await import('firebase/firestore');
  const app = initializeApp({
    apiKey: env.VITE_FB_API_KEY, authDomain: env.VITE_FB_AUTH_DOMAIN, projectId: env.VITE_FB_PROJECT_ID,
    storageBucket: env.VITE_FB_STORAGE_BUCKET, appId: env.VITE_FB_APP_ID,
  });
  await signInAnonymously(getAuth(app));
  const snap = await getDoc(doc(getFirestore(app), 'config', 'event'));
  if (!snap.exists()) { console.error('config/event not found — run scripts/setup-event.js first, or pass the slug.'); process.exit(1); }
  slug = snap.data().slug;
}
if (!/^[A-Za-z0-9]{6,32}$/.test(slug)) { console.error(`Suspicious slug "${slug}" — expected 6–32 letters/digits.`); process.exit(1); }

const url = `https://${env.VITE_FB_PROJECT_ID}.web.app/e/${slug}/`;
const opts = { errorCorrectionLevel: 'H', margin: 2 };
await QRCode.toFile(new URL('../wedding-qr.png', import.meta.url).pathname, url, { ...opts, width: 1200 });
writeFileSync(new URL('../wedding-qr.svg', import.meta.url), await QRCode.toString(url, { ...opts, type: 'svg' }));
console.log(`✓ wedding-qr.png and wedding-qr.svg written for\n  ${url}\nPrint ≥ 4×4 cm and test-scan from paper with an iPhone and an Android before printing the batch.`);
process.exit(0);
