/**
 * PoC pipeline verification (run against the local emulator suite + seed fixture).
 * Exercises the full guest path with the real Web SDK, plus adversarial cases:
 *
 *   1. guest signs in anonymously, creates device (10 snaps)
 *   2. uploads a real JPEG → finalize accepts → results ok → quota 9, photoCount 1
 *   3. duplicate re-PUT of same UUID → storage write-once rejects
 *   4. forged quota write from client → permission-denied
 *   5. forged photos/ doc create from client → permission-denied
 *   6. non-JPEG bytes (fake contentType) → rejected 'invalid', object deleted, quota unchanged
 *   7. pause → upload DEFERRED (no verdict, object retained, quota unchanged)
 *      → unpause → admin reconcileNow sweep → accepted, exactly one snap consumed
 *   8. quota exhausted → upload rejected 'quota'
 *   9. guest cannot read config/private
 *
 * Usage: node tests/poc/pipeline.mjs   (emulators must be running + seeded)
 */
import { initializeApp } from 'firebase/app';
import {
  getAuth, connectAuthEmulator, signInAnonymously, signInWithEmailAndPassword,
} from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc,
  serverTimestamp, onSnapshot,
} from 'firebase/firestore';
import { getStorage, connectStorageEmulator, ref, uploadBytes } from 'firebase/storage';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';

// Admin SDK (assertions + state manipulation), same process.
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const { initializeApp: adminInit } = await import('firebase-admin/app');
const { getFirestore: adminFirestore } = await import('firebase-admin/firestore');
const { getStorage: adminStorage } = await import('firebase-admin/storage');
const { getAuth: adminAuth } = await import('firebase-admin/auth');
const adminApp = adminInit({ projectId: 'demo-wedding', storageBucket: 'demo-wedding.appspot.com' });
const adb = adminFirestore(adminApp);
const abucket = adminStorage(adminApp).bucket();
const aauth = adminAuth(adminApp);

const app = initializeApp({
  apiKey: 'demo-key', projectId: 'demo-wedding',
  storageBucket: 'demo-wedding.appspot.com', appId: 'demo-app',
});
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
connectFirestoreEmulator(db, '127.0.0.1', 8080);
connectStorageEmulator(storage, '127.0.0.1', 9199);

// 1x1 white JPEG (valid magic bytes + SOF header).
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64');

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name} ${extra}`); }
}

function waitForResult(uuid, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { unsub(); reject(new Error(`timeout waiting for results/${uuid}`)); }, timeoutMs);
    const unsub = onSnapshot(doc(db, 'results', uuid), (snap) => {
      if (snap.exists()) { clearTimeout(t); unsub(); resolve(snap.data()); }
    });
  });
}

async function uploadAs(uid, uuid, bytes) {
  return uploadBytes(ref(storage, `uploads/${uid}/${uuid}`), bytes, {
    contentType: 'image/jpeg',
    customMetadata: { capturedAt: String(Date.now()) },
  });
}

/**
 * Calls an admin-only callable through the real Web SDK with a real ID token, using a
 * throwaway admin user minted in the auth emulator (same approach as
 * tests/rules/functions.test.mjs). Its own app instance so the guest session above is
 * untouched.
 */
async function adminCall(name, data) {
  const email = `poc-admin-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const user = await aauth.createUser({ email, password: 'pw123456' });
  await aauth.setCustomUserClaims(user.uid, { admin: true });
  const adminClientApp = initializeApp({
    apiKey: 'demo-key', projectId: 'demo-wedding',
    storageBucket: 'demo-wedding.appspot.com', appId: 'demo-app',
  }, `poc-admin-${crypto.randomUUID()}`);
  const aClientAuth = getAuth(adminClientApp);
  connectAuthEmulator(aClientAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
  await signInWithEmailAndPassword(aClientAuth, email, 'pw123456');
  const fns = getFunctions(adminClientApp, 'asia-southeast1');
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  const res = await httpsCallable(fns, name)(data);
  return res.data;
}

console.log('— PoC pipeline verification —');

// 1. Anonymous sign-in + device creation
const cred = await signInAnonymously(auth);
const uid = cred.user.uid;
await setDoc(doc(db, 'devices', uid), {
  nickname: 'PoC Tester',
  snapsRemaining: 10,
  snapsGranted: 0,
  createdAt: serverTimestamp(),
  lastSeenAt: serverTimestamp(),
  consentShownAt: serverTimestamp(),
});
check('anonymous device created with 10 snaps', true);

// 2. Happy path upload
const counterBefore = (await adb.doc('counters/event').get()).data()?.photoCount ?? 0;
const uuid1 = crypto.randomUUID();
await uploadAs(uid, uuid1, TINY_JPEG);
const res1 = await waitForResult(uuid1);
check('finalize accepted the JPEG', res1.ok === true, JSON.stringify(res1));
let dev = (await getDoc(doc(db, 'devices', uid))).data();
check('quota decremented to 9', dev.snapsRemaining === 9, `got ${dev.snapsRemaining}`);
const photo = await adb.doc(`photos/${uuid1}`).get();
check('photos doc created, visible, attributed', photo.exists
  && photo.data().status === 'visible' && photo.data().nickname === 'PoC Tester');
const counter = await adb.doc('counters/event').get();
check('event counter incremented', counter.data().photoCount === counterBefore + 1,
  `got ${counter.data().photoCount}, expected ${counterBefore + 1}`);

// 3. Duplicate re-PUT of the same UUID → write-once rejection
let dupErr = null;
try { await uploadAs(uid, uuid1, TINY_JPEG); } catch (e) { dupErr = e; }
check('write-once blocks duplicate PUT', dupErr?.code === 'storage/unauthorized', String(dupErr?.code));
dev = (await getDoc(doc(db, 'devices', uid))).data();
check('quota unchanged after duplicate attempt', dev.snapsRemaining === 9);

// 4. Forged quota write from client
let forgeErr = null;
try { await updateDoc(doc(db, 'devices', uid), { snapsRemaining: 100 }); } catch (e) { forgeErr = e; }
check('client cannot forge quota', forgeErr?.code === 'permission-denied', String(forgeErr?.code));

// 5. Forged photos doc from client
let photoForgeErr = null;
try {
  await setDoc(doc(db, 'photos', crypto.randomUUID()), { deviceUid: uid, status: 'visible' });
} catch (e) { photoForgeErr = e; }
check('client cannot create photos docs', photoForgeErr?.code === 'permission-denied', String(photoForgeErr?.code));

// 6. Non-JPEG content behind a JPEG contentType → magic-byte rejection
const uuid2 = crypto.randomUUID();
await uploadAs(uid, uuid2, Buffer.from('<html>not an image</html>'));
const res2 = await waitForResult(uuid2);
check('magic-byte check rejects fake image', res2.ok === false && res2.reason === 'invalid', JSON.stringify(res2));
dev = (await getDoc(doc(db, 'devices', uid))).data();
check('quota unchanged after invalid upload', dev.snapsRemaining === 9);
const [dupExists] = await abucket.file(`uploads/${uid}/${uuid2}`).exists();
check('invalid object deleted from storage', dupExists === false);

// 7. Pause DEFERS (never destroys) an in-flight photo, and reconciliation delivers it.
await adb.doc('config/event').update({ paused: true });
const uuid3 = crypto.randomUUID();
await uploadAs(uid, uuid3, TINY_JPEG);
await new Promise((r) => setTimeout(r, 8000));
check('paused upload gets NO verdict yet (deferred, not rejected)',
  (await adb.doc(`results/${uuid3}`).get()).exists === false);
check('paused upload keeps its object in the bucket',
  (await abucket.file(`uploads/${uid}/${uuid3}`).exists())[0] === true);
dev = (await getDoc(doc(db, 'devices', uid))).data();
check('quota unchanged while deferred', dev.snapsRemaining === 9);

await adb.doc('config/event').update({ paused: false });
const sweep = await adminCall('reconcileNow', { minAgeMs: 0, prefix: `uploads/${uid}/` });
check('reconcileNow accepts the deferred photo once unpaused', sweep.accepted === 1, JSON.stringify(sweep));
const res3 = await waitForResult(uuid3);
check('deferred photo is accepted after reconciliation', res3.ok === true, JSON.stringify(res3));
check('photo doc written for the once-paused upload',
  (await adb.doc(`photos/${uuid3}`).get()).exists === true);
dev = (await getDoc(doc(db, 'devices', uid))).data();
check('exactly one snap consumed by the reconciled photo', dev.snapsRemaining === 8, `got ${dev.snapsRemaining}`);

// 8. Quota exhaustion
await adb.doc(`devices/${uid}`).update({ snapsRemaining: 0 });
const uuid4 = crypto.randomUUID();
await uploadAs(uid, uuid4, TINY_JPEG);
const res4 = await waitForResult(uuid4);
check('exhausted quota rejects upload', res4.ok === false && res4.reason === 'quota', JSON.stringify(res4));

// 9. Guest cannot read config/private
let privErr = null;
try { await getDoc(doc(db, 'config', 'private')); } catch (e) { privErr = e; }
check('config/private unreadable by guests', privErr?.code === 'permission-denied', String(privErr?.code));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
