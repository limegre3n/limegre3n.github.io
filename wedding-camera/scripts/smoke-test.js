/**
 * Production smoke test — exercises the LIVE backend exactly like a guest's phone does,
 * using only the public web config from app/.env.production (no service account needed).
 *
 *   node scripts/smoke-test.js
 *
 * It signs in anonymously, registers a device named "Smoke Test", uploads a tiny JPEG,
 * waits for the finalize function's verdict, and confirms the quota was decremented.
 * Afterwards, hide the "Smoke Test" photo in the admin page (it never reaches the
 * gallery unless released while visible). Requires the event window to be OPEN
 * (startAt <= now <= endAt) — run it during the wedding-day rehearsal or temporarily
 * widen the window while testing.
 */
import { readFileSync, existsSync } from 'node:fs';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { getStorage, ref, uploadBytes } from 'firebase/storage';

const envPath = new URL('../app/.env.production', import.meta.url);
if (!existsSync(envPath)) { console.error('app/.env.production not found — complete DEPLOYMENT.md Step 4 first.'); process.exit(1); }
const env = Object.fromEntries(readFileSync(envPath, 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const app = initializeApp({
  apiKey: env.VITE_FB_API_KEY, authDomain: env.VITE_FB_AUTH_DOMAIN, projectId: env.VITE_FB_PROJECT_ID,
  storageBucket: env.VITE_FB_STORAGE_BUCKET, appId: env.VITE_FB_APP_ID,
});
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64');

let failed = 0;
const step = (name, ok, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !extra ? '' : ` — ${extra}`}`); if (!ok) failed += 1; };

console.log(`Smoke test against ${env.VITE_FB_PROJECT_ID} (https://${env.VITE_FB_PROJECT_ID}.web.app)\n`);
try {
  const cfgSnap = await (async () => {
    const cred = await signInAnonymously(auth);
    step('anonymous sign-in works (Authentication → Anonymous is enabled)', !!cred.user.uid);
    return getDoc(doc(db, 'config', 'event'));
  })();
  step('config/event exists and is readable', cfgSnap.exists(), 'run scripts/setup-event.js');
  if (!cfgSnap.exists()) process.exit(1);
  const cfg = cfgSnap.data();
  const now = Date.now();
  const open = now >= cfg.startAt.toMillis() && now <= cfg.endAt.toMillis();
  step(`event window is open now (${cfg.startAt.toDate().toLocaleString()} → ${cfg.endAt.toDate().toLocaleString()})`, open,
    'devices can only register inside the window — widen it temporarily to test');
  step('uploads are not paused', cfg.paused !== true, 'resume in the admin page');
  if (!open) process.exit(1);

  const uid = auth.currentUser.uid;
  await setDoc(doc(db, 'devices', uid), {
    nickname: 'Smoke Test', snapsRemaining: cfg.defaultSnaps, snapsGranted: 0,
    createdAt: serverTimestamp(), lastSeenAt: serverTimestamp(), consentShownAt: serverTimestamp(),
  });
  step(`device registered with ${cfg.defaultSnaps} snaps (Firestore rules deployed)`, true);

  const uuid = crypto.randomUUID();
  const verdict = new Promise((resolve, reject) => {
    const t = setTimeout(() => { unsub(); reject(new Error('no verdict after 90s')); }, 90_000);
    const unsub = onSnapshot(doc(db, 'results', uuid), (s) => { if (s.exists()) { clearTimeout(t); unsub(); resolve(s.data()); } }, reject);
  });
  await uploadBytes(ref(storage, `uploads/${uid}/${uuid}`), TINY_JPEG,
    { contentType: 'image/jpeg', customMetadata: { capturedAt: String(Date.now()) } });
  step('photo uploaded to Storage (Storage rules deployed, bucket reachable)', true);
  console.log('  … waiting for the finalize function (onUploadFinalize) verdict');
  const result = await verdict;
  step('finalize function accepted the photo', result.ok === true, `reason: ${result.reason}`);
  const dev = (await getDoc(doc(db, 'devices', uid))).data();
  step('one snap consumed (quota is authoritative server-side)', dev.snapsRemaining === cfg.defaultSnaps - 1,
    `snapsRemaining=${dev.snapsRemaining}`);
} catch (e) {
  failed += 1;
  console.error(`  ✗ ${e.code || ''} ${e.message}`);
  if (/permission/i.test(e.message)) console.error('    → rules may not be deployed, or the event window is closed.');
  if (/no verdict/i.test(e.message)) console.error('    → check Functions → Logs for onUploadFinalize; is counters/event present?');
}

console.log(failed ? `\n${failed} problem(s) found.` : '\n✓ Backend pipeline is live. Now hide the "Smoke Test" photo in the admin page.');
process.exit(failed ? 1 : 0);
