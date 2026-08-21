/**
 * uploads/{uid}/{uuid} READ rule, gallery half — CONTRACTS §3, GALLERY-003, PRD acc. 10.
 *
 * Why this suite is special: the rule crosses services
 * (`firestore.get(config/event)` + `firestore.get(photos/{uuid})`), and the Storage
 * emulator always resolves those gets against its single configured project
 * (`demo-wedding`) regardless of which bucket is being read. So unlike every other
 * rules suite this one runs ON `demo-wedding` and therefore:
 *   * flips `config/event.galleryReleased` for a few hundred ms and ALWAYS restores it
 *     under the shared-config mutex, and restores it in a finally block;
 *   * uses a unique device uid + photo uuid so nothing collides;
 *   * seeds its own photo doc + object instead of spending a snap through the upload
 *     pipeline, and leaves them behind (harmless: unique ids, no counters touched).
 */
import { test, before, after } from 'node:test';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { randomUUID } from 'node:crypto';
import { ref, uploadBytes, getBytes } from 'firebase/storage';
import { TINY_JPEG, storageRulesUnavailable, withSharedConfig, EMU } from './helpers.mjs';

process.env.FIRESTORE_EMULATOR_HOST = `${EMU.host}:${EMU.firestorePort}`;
process.env.FIREBASE_STORAGE_EMULATOR_HOST = `${EMU.host}:${EMU.storagePort}`;

let env;
let adb;
let deviceUid;
let photoId;
let unavailable = null;

before(async () => {
  const { initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  adb = getFirestore(initializeApp({ projectId: EMU.projectId }, `rules-gallery-${randomUUID()}`));

  // No rules pushed: the emulators already serve the repo rules for this project
  // (Firestore hot-reloads firestore.rules; Storage keeps one global ruleset).
  env = await initializeTestEnvironment({
    projectId: EMU.projectId,
    storage: { host: EMU.host, port: EMU.storagePort },
  });

  unavailable = await storageRulesUnavailable(env);
  if (unavailable) return;

  // Fixture is seeded directly rather than pushed through onUploadFinalize: the emulator
  // does not dispatch storage triggers for the bucket @firebase/rules-unit-testing uses,
  // and this suite is about the READ rule, not the pipeline (that is covered by
  // functions.test.mjs and tests/poc/pipeline.mjs). Never throw from here — this file is
  // imported alongside every other suite by tests/rules/index.js, and a failing root
  // `before` hook cancels ALL of them.
  try {
    deviceUid = `rulesgal-${randomUUID().slice(0, 8)}`;
    photoId = randomUUID();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), `uploads/${deviceUid}/${photoId}`),
        TINY_JPEG, { contentType: 'image/jpeg' });
    });
    await adb.doc(`photos/${photoId}`).set({
      deviceUid,
      nickname: 'Rules Gallery',
      storagePath: `uploads/${deviceUid}/${photoId}`,
      byteSize: TINY_JPEG.length,
      width: 1,
      height: 1,
      capturedAt: new Date(),
      receivedAt: new Date(),
      status: 'visible',
      rotation: 0,
    });
  } catch (err) {
    unavailable = `fixture setup failed: ${err && err.message}`;
  }
});

after(async () => {
  await env.cleanup();
});

const asGallery = () => env.authenticatedContext(`rulesviewer-${randomUUID().slice(0, 8)}`,
  { gallery: true }).storage();
const asGuest = () => env.authenticatedContext(`rulesguest-${randomUUID().slice(0, 8)}`).storage();

test('gallery read: locked → denied; released → visible only; hidden/orphan → denied', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const path = `uploads/${deviceUid}/${photoId}`;

  await withSharedConfig(async () => {
    const original = (await adb.doc('config/event').get()).data().galleryReleased;

    // GALLERY-001: before release, even a PIN-verified viewer gets nothing.
    await adb.doc('config/event').update({ galleryReleased: false });
    await assertFails(getBytes(ref(asGallery(), path)));

    await adb.doc('config/event').update({ galleryReleased: true });
    try {
      // GALLERY-003: released + status visible → readable at stored quality.
      await assertSucceeds(getBytes(ref(asGallery(), path)));

      // PRD acceptance 10: hiding a photo revokes storage access immediately.
      await adb.doc(`photos/${photoId}`).update({ status: 'hidden' });
      await assertFails(getBytes(ref(asGallery(), path)));
      await adb.doc(`photos/${photoId}`).update({ status: 'visible' });

      // No photos doc at all (rejected/never-finalized upload) → unreachable.
      await assertFails(getBytes(ref(asGallery(), `uploads/${deviceUid}/${randomUUID()}`)));

      // The gallery claim is required: plain guests and anonymous callers stay out.
      await assertFails(getBytes(ref(asGuest(), path)));
      await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), path)));
    } finally {
      await adb.doc('config/event').update({ galleryReleased: original });
    }
  });
});
