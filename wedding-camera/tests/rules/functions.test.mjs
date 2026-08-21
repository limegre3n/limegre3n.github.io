/**
 * Cloud Functions behaviour — CONTRACTS §5, PRD GALLERY-002 / ADMIN-006 / UPLOAD-007.
 *
 * Runs against the RUNNING emulator suite on `demo-wedding` (that is the only project
 * the functions emulator serves). Callables are invoked through the real Web SDK
 * (`httpsCallable` + connectFunctionsEmulator) with real ID tokens from the auth
 * emulator, so the auth/claims path is exercised end to end.
 *
 * Shared-emulator etiquette:
 *   * unique uids/uuids per case; never clearFirestore/clearStorage;
 *   * `config/event` is mutated only for the release/window cases and ALWAYS restored
 *     in a finally block;
 *   * accepted photos are left in place (the shared counters/event legitimately counts
 *     them), exactly like tests/poc/pipeline.mjs.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp as initClient, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { TINY_JPEG, withSharedConfig, EMU } from './helpers.mjs';

process.env.FIRESTORE_EMULATOR_HOST = `${EMU.host}:${EMU.firestorePort}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `${EMU.host}:${EMU.authPort}`;
process.env.FIREBASE_STORAGE_EMULATOR_HOST = `${EMU.host}:${EMU.storagePort}`;

const PIN = '2468';           // scripts/seed.js fixture
const WRONG_PIN = '1111';
const clientApps = [];

let adb;
let aauth;
let abucket;

before(async () => {
  const { initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getAuth: adminAuth } = await import('firebase-admin/auth');
  const { getStorage } = await import('firebase-admin/storage');
  const app = initializeApp(
    { projectId: EMU.projectId, storageBucket: `${EMU.projectId}.appspot.com` },
    `fn-tests-${randomUUID()}`);
  adb = getFirestore(app);
  aauth = adminAuth(app);
  abucket = getStorage(app).bucket();
});

/** A fresh client app so every identity gets its own auth state. */
function newClient() {
  const app = initClient({
    apiKey: 'demo-key', projectId: EMU.projectId,
    storageBucket: `${EMU.projectId}.appspot.com`, appId: 'demo-app',
  }, `c-${randomUUID()}`);
  clientApps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${EMU.host}:${EMU.authPort}`, { disableWarnings: true });
  const fns = getFunctions(app, 'us-central1');
  connectFunctionsEmulator(fns, EMU.host, EMU.functionsPort);
  return {
    auth,
    call: (name, data) => httpsCallable(fns, name)(data).then((r) => r.data),
  };
}

async function anonClient() {
  const c = newClient();
  const cred = await signInAnonymously(c.auth);
  return { ...c, uid: cred.user.uid };
}

async function adminClient() {
  const email = `admin-${randomUUID().slice(0, 8)}@example.com`;
  const user = await aauth.createUser({ email, password: 'pw123456' });
  await aauth.setCustomUserClaims(user.uid, { admin: true });
  const c = newClient();
  await signInWithEmailAndPassword(c.auth, email, 'pw123456');
  return { ...c, uid: user.uid };
}

async function expectCode(promise, code) {
  try {
    await promise;
    assert.fail(`expected ${code}, but the call resolved`);
  } catch (err) {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
  }
}

const attempts = (uid) => adb.doc(`pinAttempts/${uid}`).get().then((s) => (s.exists ? s.data() : null));
const claims = (uid) => aauth.getUser(uid).then((u) => u.customClaims || {});

/** Release the shared gallery for the duration of fn, under the config mutex. */
function withRelease(fn) {
  return withSharedConfig(async () => {
    const previous = (await adb.doc('config/event').get()).data().galleryReleased;
    await adb.doc('config/event').update({ galleryReleased: true });
    try {
      return await fn();
    } finally {
      await adb.doc('config/event').update({ galleryReleased: previous });
    }
  });
}

describe('verifyGalleryPin', () => {
  test('requires authentication', async () => {
    const c = newClient(); // never signed in
    await expectCode(c.call('verifyGalleryPin', { pin: PIN }), 'functions/unauthenticated');
  });

  test('malformed input is refused without spending an attempt', async () => {
    const c = await anonClient();
    for (const data of [{}, { pin: '' }, { pin: '123' }, { pin: '1234567' }, { pin: 'abcd' },
      { pin: '12 34' }, { pin: 2468 }, { pin: null }, { pin: ['2', '4', '6', '8'] },
      { pin: { toString: 'x' } }, null, 'nonsense']) {
      const res = await c.call('verifyGalleryPin', data);
      assert.deepEqual(res, { ok: false }, `pin payload ${JSON.stringify(data)}`);
    }
    assert.equal(await attempts(c.uid), null, 'malformed pins must not consume the rate limit');
    assert.equal((await claims(c.uid)).gallery, undefined);
  });

  test('a correct pin grants nothing while the gallery is locked (GALLERY-001)', async () => {
    const c = await anonClient();
    await withSharedConfig(async () => {
      const released = (await adb.doc('config/event').get()).data().galleryReleased;
      assert.equal(released, false, 'fixture expects a locked gallery; someone left it released');
      assert.deepEqual(await c.call('verifyGalleryPin', { pin: PIN }), { ok: false });
      assert.equal((await claims(c.uid)).gallery, undefined, 'no gallery claim before release');
      assert.equal(await attempts(c.uid), null, 'a locked gallery must not burn attempts');
    });
  });

  test('correct pin after release sets the gallery claim and clears the counter', async () => {
    const c = await anonClient();
    await withRelease(async () => {
      // Two misses first, so we can prove success wipes the ledger.
      assert.deepEqual(await c.call('verifyGalleryPin', { pin: WRONG_PIN }), { ok: false });
      assert.deepEqual(await c.call('verifyGalleryPin', { pin: WRONG_PIN }), { ok: false });
      assert.equal((await attempts(c.uid)).count, 2);

      assert.deepEqual(await c.call('verifyGalleryPin', { pin: PIN }), { ok: true });
      assert.equal((await claims(c.uid)).gallery, true);
      assert.equal(await attempts(c.uid), null, 'a successful verify clears pinAttempts');
    });
  });

  test('exactly 5 failures per 15 min, then retryAfterSec (GALLERY-002)', async () => {
    const c = await anonClient();
    await withRelease(async () => {
      for (let i = 1; i <= 5; i += 1) {
        const res = await c.call('verifyGalleryPin', { pin: WRONG_PIN });
        assert.deepEqual(res, { ok: false }, `attempt ${i} must not be rate limited yet`);
        assert.equal((await attempts(c.uid)).count, i);
      }
      const blocked = await c.call('verifyGalleryPin', { pin: WRONG_PIN });
      assert.equal(blocked.ok, false);
      assert.ok(blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 15 * 60,
        `retryAfterSec should be within the window, got ${blocked.retryAfterSec}`);

      // The CORRECT pin is refused while blocked, and grants no claim.
      const stillBlocked = await c.call('verifyGalleryPin', { pin: PIN });
      assert.equal(stillBlocked.ok, false);
      assert.ok(stillBlocked.retryAfterSec > 0);
      assert.equal((await claims(c.uid)).gallery, undefined);
      // A blocked attempt must not extend the window (count stays at the cap).
      assert.equal((await attempts(c.uid)).count, 5);
    });
  });

  test('the rate limit is per identity, not global', async () => {
    const blockedUid = `pinblocked-${randomUUID().slice(0, 8)}`;
    await adb.doc(`pinAttempts/${blockedUid}`).set({ count: 5, windowStart: new Date() });
    const fresh = await anonClient();
    await withRelease(async () => {
      assert.deepEqual(await fresh.call('verifyGalleryPin', { pin: PIN }), { ok: true });
    });
    assert.equal((await adb.doc(`pinAttempts/${blockedUid}`).get()).data().count, 5);
  });
});

/**
 * Photos the export can actually include: the function skips docs whose storage object
 * has gone (other workstreams share this project and leave orphans behind), so the
 * expected count is computed the same way rather than from the doc count alone.
 */
async function exportableCount(status) {
  let q = adb.collection('photos');
  if (status) q = q.where('status', '==', status);
  const snap = await q.get();
  const checks = await Promise.all(snap.docs.map(async (d) => {
    const path = d.data().storagePath;
    if (typeof path !== 'string' || !path) return false;
    const [exists] = await abucket.file(path).exists().catch(() => [false]);
    return exists;
  }));
  return checks.filter(Boolean).length;
}

describe('exportZip', () => {
  test('non-admin callers are rejected (ADMIN-001)', async () => {
    const anon = await anonClient();
    await expectCode(anon.call('exportZip', {}), 'functions/permission-denied');
    await expectCode(anon.call('exportZip', { includeHidden: true }), 'functions/permission-denied');
    const unauth = newClient();
    await expectCode(unauth.call('exportZip', {}), 'functions/permission-denied');
  });

  test('a gallery claim is not admin', async () => {
    const c = await anonClient();
    await aauth.setCustomUserClaims(c.uid, { gallery: true });
    // Force a fresh token carrying the claim.
    await c.auth.currentUser.getIdToken(true);
    await expectCode(c.call('exportZip', {}), 'functions/permission-denied');
  });

  test('admin export returns a url + count and writes an audit record (ADMIN-006/008)', async () => {
    const admin = await adminClient();
    const visible = await exportableCount('visible');
    const res = await admin.call('exportZip', {});
    assert.equal(typeof res.url, 'string');
    assert.ok(res.url.length > 0, 'export must return a download url');
    assert.equal(typeof res.count, 'number');
    assert.equal(res.count, visible, 'count must match the exportable visible photos');

    const audit = await adb.collection('audit')
      .where('actorUid', '==', admin.uid).where('action', '==', 'export').get();
    assert.equal(audit.size, 1, 'exactly one export audit record for this admin');
    assert.equal(typeof audit.docs[0].data().target, 'string');

    // The ZIP itself exists in exports/ and is non-empty (an empty archive is 22 bytes).
    const exportId = audit.docs[0].data().target;
    const [meta] = await abucket.file(`exports/${exportId}.zip`).getMetadata();
    assert.ok(Number(meta.size) >= 22, `zip should exist, got size ${meta.size}`);
  });

  test('includeHidden covers every photo, hidden ones too', async () => {
    const admin = await adminClient();
    const all = await exportableCount(null);
    const visible = await exportableCount('visible');
    assert.ok(all >= visible);
    const res = await admin.call('exportZip', { includeHidden: true });
    assert.equal(res.count, all);
  });
});

describe('onUploadFinalize edge cases', () => {
  /** Waits for results/{uuid} to appear. */
  async function waitForResult(uuid, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snap = await adb.doc(`results/${uuid}`).get();
      if (snap.exists) return snap.data();
      if (Date.now() > deadline) throw new Error(`timed out waiting for results/${uuid}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Uploads via the Admin SDK so we can forge paths/sizes the client rules forbid. */
  async function putObject(path, bytes, metadata) {
    await abucket.file(path).save(Buffer.from(bytes), {
      contentType: 'image/jpeg',
      metadata: metadata ? { metadata } : undefined,
    });
  }

  const objectGone = async (path) => !(await abucket.file(path).exists())[0];

  test('malformed path under uploads/ → invalid result + object deleted (§5.1)', async () => {
    const deviceUid = `fnedge-${randomUUID().slice(0, 8)}`;
    const id = randomUUID();
    const path = `uploads/${deviceUid}/nested/${id}`;
    await putObject(path, TINY_JPEG);
    const res = await waitForResult(id);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'invalid');
    assert.equal(res.deviceUid, deviceUid, 'the uid segment is reported when recoverable');
    assert.ok(await objectGone(path), 'malformed objects must be deleted');
  });

  test('unrecoverable path → object deleted, no stray result doc', async () => {
    const deviceUid = `fnedge-${randomUUID().slice(0, 8)}`;
    const path = `uploads/${deviceUid}/not-a-uuid.jpg`;
    await putObject(path, TINY_JPEG);
    await new Promise((r) => setTimeout(r, 3000));
    assert.ok(await objectGone(path));
  });

  test('non-JPEG bytes → invalid (magic-byte check, UPLOAD-007)', async () => {
    const deviceUid = `fnedge-${randomUUID().slice(0, 8)}`;
    const id = randomUUID();
    await adb.doc(`devices/${deviceUid}`).set({
      nickname: 'Edge Case', snapsRemaining: 3, snapsGranted: 0,
      createdAt: new Date(), lastSeenAt: new Date(), consentShownAt: new Date(),
    });
    const path = `uploads/${deviceUid}/${id}`;
    await putObject(path, Buffer.from('<html>not an image</html>'));
    const res = await waitForResult(id);
    assert.equal(res.reason, 'invalid');
    assert.ok(await objectGone(path));
    assert.equal((await adb.doc(`devices/${deviceUid}`).get()).data().snapsRemaining, 3,
      'a rejected upload never costs a snap (A2/UPLOAD-004)');
  });

  test('oversize object → invalid without downloading the body', async () => {
    const deviceUid = `fnedge-${randomUUID().slice(0, 8)}`;
    const id = randomUUID();
    await adb.doc(`devices/${deviceUid}`).set({
      nickname: 'Oversize', snapsRemaining: 2, snapsGranted: 0,
      createdAt: new Date(), lastSeenAt: new Date(), consentShownAt: new Date(),
    });
    const big = Buffer.alloc(8 * 1024 * 1024 + 1);
    TINY_JPEG.forEach((b, i) => { big[i] = b; });
    const path = `uploads/${deviceUid}/${id}`;
    await putObject(path, big);
    const res = await waitForResult(id);
    assert.equal(res.reason, 'invalid');
    assert.ok(await objectGone(path));
    assert.equal((await adb.doc(`devices/${deviceUid}`).get()).data().snapsRemaining, 2);
  });

  test('no device doc → invalid (forged upload from an unknown identity)', async () => {
    const deviceUid = `fnghost-${randomUUID().slice(0, 8)}`;
    const id = randomUUID();
    const path = `uploads/${deviceUid}/${id}`;
    await putObject(path, TINY_JPEG);
    const res = await waitForResult(id);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'invalid');
    assert.ok(await objectGone(path));
  });

  test('accepted upload records dimensions and clamps a forged capturedAt', async () => {
    const deviceUid = `fnok-${randomUUID().slice(0, 8)}`;
    const id = randomUUID();
    await adb.doc(`devices/${deviceUid}`).set({
      nickname: 'Dimension Probe', snapsRemaining: 1, snapsGranted: 0,
      createdAt: new Date(), lastSeenAt: new Date(), consentShownAt: new Date(),
    });
    const future = Date.now() + 365 * 24 * 60 * 60 * 1000;
    await putObject(`uploads/${deviceUid}/${id}`, TINY_JPEG, { capturedAt: String(future) });
    const res = await waitForResult(id);
    assert.equal(res.ok, true, JSON.stringify(res));

    const photo = (await adb.doc(`photos/${id}`).get()).data();
    assert.equal(photo.width, 1, 'JPEG SOF parse gives the real width');
    assert.equal(photo.height, 1);
    assert.equal(photo.status, 'visible');
    assert.equal(photo.rotation, 0);
    assert.equal(photo.nickname, 'Dimension Probe');
    assert.ok(photo.capturedAt.toMillis() <= photo.receivedAt.toMillis(),
      'a client-claimed future capture time must be clamped to receivedAt');
    assert.equal((await adb.doc(`devices/${deviceUid}`).get()).data().snapsRemaining, 0,
      'exactly one snap consumed');
  });

  test('duplicate finalize event for one uuid stays idempotent (UPLOAD-003)', async () => {
    const deviceUid = `fndup-${randomUUID().slice(0, 8)}`;
    const id = randomUUID();
    await adb.doc(`devices/${deviceUid}`).set({
      nickname: 'Dup', snapsRemaining: 2, snapsGranted: 0,
      createdAt: new Date(), lastSeenAt: new Date(), consentShownAt: new Date(),
    });
    const path = `uploads/${deviceUid}/${id}`;
    await putObject(path, TINY_JPEG);
    assert.equal((await waitForResult(id)).ok, true);
    // A second finalize for the same uuid (re-save = another finalize event).
    await putObject(path, TINY_JPEG);
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal((await adb.doc(`devices/${deviceUid}`).get()).data().snapsRemaining, 1,
      'the duplicate event must not consume a second snap');
  });

  test('outside the event window → window (GUEST-004, acceptance 9)', async () => {
    const deviceUid = `fnwin-${randomUUID().slice(0, 8)}`;
    const id = randomUUID();
    await adb.doc(`devices/${deviceUid}`).set({
      nickname: 'Late Guest', snapsRemaining: 1, snapsGranted: 0,
      createdAt: new Date(), lastSeenAt: new Date(), consentShownAt: new Date(),
    });
    await withSharedConfig(async () => {
      const cfg = (await adb.doc('config/event').get()).data();
      await adb.doc('config/event').update({ endAt: new Date(Date.now() - 60 * 1000) });
      try {
        const path = `uploads/${deviceUid}/${id}`;
        await putObject(path, TINY_JPEG);
        const res = await waitForResult(id);
        assert.equal(res.reason, 'window');
        assert.ok(await objectGone(path));
        assert.equal((await adb.doc(`devices/${deviceUid}`).get()).data().snapsRemaining, 1);
      } finally {
        await adb.doc('config/event').update({ endAt: cfg.endAt });
      }
    });
  });
});

test('teardown: close client apps', async () => {
  await Promise.all(clientApps.map((a) => deleteApp(a).catch(() => {})));
});
