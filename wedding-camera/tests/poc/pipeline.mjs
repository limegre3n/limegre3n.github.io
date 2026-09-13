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
 *  10. film development: a filtered upload gets a developed/{uuid} copy, the date
 *      stamp alone is enough to develop a 'clean' shot, dateStamp off + clean means
 *      no developed copy at all, an unknown stock id degrades to 'clean', and
 *      redevelopAll is admin-only
 *  11. gallery "Download all" (exportGalleryZip): claim gate, release gate,
 *      visible-only ZIP, developed bytes in the archive, the shared server-side cache
 *      on a second call, and the build lock that collapses a cold-cache burst into one
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

async function uploadAs(uid, uuid, bytes, extraMetadata = {}) {
  return uploadBytes(ref(storage, `uploads/${uid}/${uuid}`), bytes, {
    contentType: 'image/jpeg',
    customMetadata: { capturedAt: String(Date.now()), ...extraMetadata },
  });
}

/**
 * Polls `photos/{uuid}` (Admin SDK) until `predicate` holds. Development runs AFTER the
 * results doc is written, so `waitForResult` returning is not proof the developed copy
 * is on disk yet.
 */
async function waitForPhoto(uuid, predicate, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const snap = await adb.doc(`photos/${uuid}`).get();
    last = snap.exists ? snap.data() : null;
    if (last && predicate(last)) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
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

/** A plain anonymous caller (no admin, no gallery claim) for permission checks. */
async function anonCaller() {
  const clientApp = initializeApp({
    apiKey: 'demo-key', projectId: 'demo-wedding',
    storageBucket: 'demo-wedding.appspot.com', appId: 'demo-app',
  }, `poc-anon-${crypto.randomUUID()}`);
  const cAuth = getAuth(clientApp);
  connectAuthEmulator(cAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
  await signInAnonymously(cAuth);
  const fns = getFunctions(clientApp, 'asia-southeast1');
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  return { call: (name, data) => httpsCallable(fns, name)(data).then((r) => r.data) };
}
const stranger0 = await anonCaller();

// 10. Film development (CONTRACTS §11). The originals are never touched; a second
//     object at developed/{uuid} carries the stock look and the optional date stamp.

const cfgBefore = (await adb.doc('config/event').get()).data();
const dateStampBefore = cfgBefore.dateStamp;
// Fresh film: step 8 emptied this device on purpose.
await adb.doc(`devices/${uid}`).update({ snapsRemaining: 10 });
await adb.doc('config/event').update({ dateStamp: true });

// (a) a filtered upload is developed with the stock baked in.
const uuidGolden = crypto.randomUUID();
await uploadAs(uid, uuidGolden, TINY_JPEG, { filter: 'golden', tzOffsetMinutes: '480' });
const resGolden = await waitForResult(uuidGolden);
check('filtered upload is accepted', resGolden.ok === true, JSON.stringify(resGolden));
const goldenPhoto = await waitForPhoto(uuidGolden, (p) => p.developPending === false);
check('photos doc records the chosen film stock',
  goldenPhoto?.filter === 'golden' && goldenPhoto?.tzOffsetMinutes === 480,
  JSON.stringify({ filter: goldenPhoto?.filter, tz: goldenPhoto?.tzOffsetMinutes }));
check('photos doc points at developed/{uuid}',
  goldenPhoto?.developedPath === `developed/${uuidGolden}`
  && goldenPhoto?.developedAt != null && goldenPhoto?.developPending === false,
  JSON.stringify({ path: goldenPhoto?.developedPath, pending: goldenPhoto?.developPending }));

const developedFile = abucket.file(`developed/${uuidGolden}`);
const [developedExists] = await developedFile.exists();
check('developed object exists in storage', developedExists === true);
let developedBytes = null;
if (developedExists) {
  [developedBytes] = await developedFile.download();
}
check('developed object is a real JPEG',
  developedBytes?.[0] === 0xff && developedBytes?.[1] === 0xd8,
  `head ${developedBytes?.subarray(0, 3)}`);
const [originalBytes] = await abucket.file(`uploads/${uid}/${uuidGolden}`).download();
check('developed copy differs from the original, which is untouched',
  developedBytes != null && !developedBytes.equals(originalBytes)
  && originalBytes.equals(TINY_JPEG),
  `developed ${developedBytes?.length}B vs original ${originalBytes.length}B`);

// (b) dateStamp alone is reason enough to develop a 'clean' shot.
const uuidStampOnly = crypto.randomUUID();
await uploadAs(uid, uuidStampOnly, TINY_JPEG, { filter: 'clean' });
await waitForResult(uuidStampOnly);
const stampPhoto = await waitForPhoto(uuidStampOnly, (p) => p.developPending === false);
check('clean stock still develops while the date stamp is on',
  stampPhoto?.filter === 'clean' && stampPhoto?.developedPath === `developed/${uuidStampOnly}`,
  JSON.stringify({ filter: stampPhoto?.filter, path: stampPhoto?.developedPath }));
check('the stamp-only developed object is stored',
  (await abucket.file(`developed/${uuidStampOnly}`).exists())[0] === true);

// (c) nothing to do: clean stock, stamp off → no developed copy at all.
await adb.doc('config/event').update({ dateStamp: false });
const uuidNoDev = crypto.randomUUID();
await uploadAs(uid, uuidNoDev, TINY_JPEG, { filter: 'clean' });
await waitForResult(uuidNoDev);
const plainPhoto = await waitForPhoto(uuidNoDev, (p) => p.status === 'visible');
check('clean stock + stamp off is never developed',
  plainPhoto?.developedPath === null && plainPhoto?.developPending === false
  && plainPhoto?.developedAt === null,
  JSON.stringify({ path: plainPhoto?.developedPath, pending: plainPhoto?.developPending }));
check('no developed object is written for an undeveloped photo',
  (await abucket.file(`developed/${uuidNoDev}`).exists())[0] === false);

// (d) an unknown stock id is not a rejection — it degrades to 'clean'.
const uuidBogus = crypto.randomUUID();
await uploadAs(uid, uuidBogus, TINY_JPEG, { filter: 'kodachrome-64-deluxe' });
const resBogus = await waitForResult(uuidBogus);
check('an unknown film stock still accepts the photo', resBogus.ok === true, JSON.stringify(resBogus));
const bogusPhoto = await waitForPhoto(uuidBogus, (p) => p.status === 'visible');
check('an unknown film stock is stored as clean',
  bogusPhoto?.filter === 'clean' && bogusPhoto?.developedPath === null,
  JSON.stringify({ filter: bogusPhoto?.filter, path: bogusPhoto?.developedPath }));

// (e) redevelopAll — admin only, re-develops against the CURRENT config.
await adb.doc('config/event').update({ dateStamp: true });
let redevDeniedErr = null;
try { await stranger0.call('redevelopAll', {}); } catch (e) { redevDeniedErr = e; }
check('redevelopAll denies a non-admin caller',
  redevDeniedErr?.code === 'functions/permission-denied', String(redevDeniedErr?.code));

// Page through the whole roll the way the admin UI does: startAfter = lastUuid while
// `remaining` is true (the shared emulator may hold well over one page of photos).
let redev = await adminCall('redevelopAll', { limit: 25 });
check('redevelopAll processes a page of photos',
  redev.processed > 0 && typeof redev.remaining === 'boolean'
  && (redev.lastUuid === null || typeof redev.lastUuid === 'string'),
  JSON.stringify(redev));
for (let pages = 1; redev.remaining && redev.lastUuid && pages < 40; pages += 1) {
  redev = await adminCall('redevelopAll', { limit: 25, startAfter: redev.lastUuid });
}
check('redevelopAll paging reaches the end of the roll', redev.remaining === false, JSON.stringify(redev));
const redevAudit = await adb.collection('audit').where('action', '==', 'redevelop').get();
check('redevelopAll writes exactly one audit record per call', redevAudit.size >= 1,
  `${redevAudit.size} redevelop audit records`);
// The photo that needed no developed copy gains one now that the stamp is back on.
const restamped = await waitForPhoto(uuidNoDev, (p) => typeof p.developedPath === 'string');
check('redevelopAll develops a photo that now needs the date stamp',
  restamped?.developedPath === `developed/${uuidNoDev}`,
  JSON.stringify({ path: restamped?.developedPath }));

// 11. Gallery "Download all pictures" — exportGalleryZip (claim gate, release gate,
//     visible-only contents, developed bytes, and the shared server-side cache).

/** A throwaway anonymous identity, optionally carrying the `gallery` claim. */
async function galleryClient(withClaim) {
  const clientApp = initializeApp({
    apiKey: 'demo-key', projectId: 'demo-wedding',
    storageBucket: 'demo-wedding.appspot.com', appId: 'demo-app',
  }, `poc-gal-${crypto.randomUUID()}`);
  const cAuth = getAuth(clientApp);
  connectAuthEmulator(cAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const cred = await signInAnonymously(cAuth);
  if (withClaim) {
    await aauth.setCustomUserClaims(cred.user.uid, { gallery: true });
    await cAuth.currentUser.getIdToken(true); // force a token carrying the claim
  }
  const fns = getFunctions(clientApp, 'asia-southeast1');
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  return {
    uid: cred.user.uid,
    call: (name, data) => httpsCallable(fns, name)(data).then((r) => r.data),
  };
}

/**
 * Fetches the export. In the emulator `exportUrl()` falls back to the unsigned media
 * endpoint, which is rules-evaluated (exports/ is admin-read-only) — the emulator's
 * `Bearer owner` token stands in for the signature. Production returns a real V4
 * signed URL that needs no header at all.
 *
 * NEVER fetch this URL without an Authorization header: the Storage emulator's rules
 * evaluator dereferences request.auth and CRASHES the whole emulator on an anonymous
 * GET of an exports/ object.
 */
async function fetchExport(url) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer owner' } });
  if (!res.ok) return { status: res.status, head: null, bytes: 0 };
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, head: buf.subarray(0, 2), bytes: buf.length, buf };
}

// (a) no gallery claim → permission-denied, no URL handed out.
const stranger = await galleryClient(false);
let galDeniedErr = null;
try { await stranger.call('exportGalleryZip', {}); } catch (e) { galDeniedErr = e; }
check('exportGalleryZip denies a viewer without the gallery claim',
  galDeniedErr?.code === 'functions/permission-denied', String(galDeniedErr?.code));

// (b) gallery claim but the gallery is locked → failed-precondition.
const viewer = await galleryClient(true);
const releasedBefore = (await adb.doc('config/event').get()).data().galleryReleased;
await adb.doc('config/event').update({ galleryReleased: false });
let galLockedErr = null;
try { await viewer.call('exportGalleryZip', {}); } catch (e) { galLockedErr = e; }
check('exportGalleryZip refuses while the gallery is not released',
  galLockedErr?.code === 'functions/failed-precondition', String(galLockedErr?.code));

// (c) released → a fresh build with exactly the visible photos.
await adb.doc('config/event').update({ galleryReleased: true });
// Drop any cache left by an earlier run so this really exercises the build path.
await adb.doc('config/galleryExport').delete().catch(() => {});

const visibleSnap = await adb.collection('photos').where('status', '==', 'visible').get();
// Orphaned docs (an object another suite cleaned up) are skipped by the builder, so the
// expectation is computed the same way rather than from the doc count alone.
const presentFlags = await Promise.all(visibleSnap.docs.map(async (d) => {
  const sp = d.data().storagePath;
  if (typeof sp !== 'string' || !sp) return false;
  const [exists] = await abucket.file(sp).exists().catch(() => [false]);
  return exists;
}));
const expectedCount = presentFlags.filter(Boolean).length;
const hiddenSnap = await adb.collection('photos').where('status', '==', 'hidden').get();

const firstExport = await viewer.call('exportGalleryZip', {});
check('gallery export returns a download url',
  typeof firstExport.url === 'string' && firstExport.url.length > 0, String(firstExport.url));
check('gallery export count equals the visible photos',
  firstExport.count === expectedCount,
  `got ${firstExport.count}, expected ${expectedCount} (${visibleSnap.size} visible, ${hiddenSnap.size} hidden)`);

const download = await fetchExport(firstExport.url);
check('gallery export url serves a real ZIP (PK magic bytes)',
  download.status === 200 && download.head?.[0] === 0x50 && download.head?.[1] === 0x4b,
  `status ${download.status}, head ${download.head}`);

// (f) The archive carries the DEVELOPED copy wherever one exists. Entries are stored
//     uncompressed (zlib level 0 — JPEGs do not recompress), so the developed bytes
//     appear verbatim inside the ZIP and can simply be searched for.
check('the gallery archive packs the developed copy, not the original',
  developedBytes != null && download.buf != null && download.buf.includes(developedBytes),
  `zip ${download.bytes}B, developed ${developedBytes?.length}B`);

const cacheDoc = await adb.doc('config/galleryExport').get();
const cachedPath = cacheDoc.data()?.path;
const cachedAt = cacheDoc.data()?.createdAt?.toMillis();
check('gallery export records its cache metadata server-side',
  typeof cachedPath === 'string' && cachedPath.startsWith('exports/')
  && cacheDoc.data().count === expectedCount && typeof cacheDoc.data().signature === 'string',
  JSON.stringify(cacheDoc.data() || null));

// (d) a second call (different viewer) is served from the cache — same object, no rebuild.
const viewer2 = await galleryClient(true);
const secondExport = await viewer2.call('exportGalleryZip', {});
const cacheAfter = await adb.doc('config/galleryExport').get();
check('a second gallery export reuses the cached archive (no rebuild)',
  cacheAfter.data()?.createdAt?.toMillis() === cachedAt && cacheAfter.data()?.path === cachedPath,
  `path ${cacheAfter.data()?.path} vs ${cachedPath}`);
check('the cached response points at the same object and count',
  secondExport.count === firstExport.count
  && decodeURIComponent(secondExport.url).includes(cachedPath),
  `count ${secondExport.count}, url ${secondExport.url}`);

/** exports/{exportId}.zip → exportId, which is what the audit record targets. */
const exportIdOf = (path) => String(path || '').replace(/^exports\//, '').replace(/\.zip$/, '');

// Keyed to the archive that was actually built, not to a caller: under the build lock a
// caller served by someone else's build correctly writes no audit of its own.
const galAudit = await adb.collection('audit')
  .where('action', '==', 'gallery-export').where('target', '==', exportIdOf(cachedPath)).get();
check('the archive that was built has exactly one audit record',
  galAudit.size === 1 && typeof galAudit.docs[0]?.data().actorUid === 'string',
  `got ${galAudit.size} for ${exportIdOf(cachedPath)}`);

// (e) a cold-cache burst collapses into ONE build (the thundering-herd lock).
await adb.doc('config/galleryExport').delete().catch(() => {});
const racerA = await galleryClient(true);
const racerB = await galleryClient(true);
const [raceA, raceB] = await Promise.all([
  racerA.call('exportGalleryZip', {}),
  racerB.call('exportGalleryZip', {}),
]);
check('both concurrent gallery exports succeed',
  typeof raceA.url === 'string' && raceA.url.length > 0
  && typeof raceB.url === 'string' && raceB.url.length > 0);
check('both concurrent gallery exports report the same count',
  raceA.count === raceB.count && raceA.count === expectedCount,
  `${raceA.count} vs ${raceB.count}, expected ${expectedCount}`);
const racePath = (await adb.doc('config/galleryExport').get()).data()?.path;
check('both concurrent callers are handed the same archive object',
  typeof racePath === 'string'
  && decodeURIComponent(raceA.url).includes(racePath)
  && decodeURIComponent(raceB.url).includes(racePath),
  `path ${racePath}`);
// One archive, therefore exactly one build, therefore exactly one audit record —
// whichever caller won the lock. Keyed to the archive so a parallel workstream calling
// the same function cannot perturb the count.
const raceAudits = await adb.collection('audit')
  .where('action', '==', 'gallery-export').where('target', '==', exportIdOf(racePath)).get();
check('a concurrent burst on a cold cache builds exactly once',
  raceAudits.size === 1, `${raceAudits.size} audit records for ${exportIdOf(racePath)}`);

// Restore the shared flags for every other suite (CONTRACTS §11 default: dateStamp on).
await adb.doc('config/event').update({
  galleryReleased: releasedBefore,
  dateStamp: dateStampBefore === undefined ? true : dateStampBefore,
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
