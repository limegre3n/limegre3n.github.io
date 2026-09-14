/**
 * Storage rules — CONTRACTS §3, UPLOAD-007, PRIVACY-005.
 * uploads/{uid}/{uuid} is write-once, own-uid-only, image/jpeg, ≤8MB, and readable
 * only by admin or a released-gallery viewer whose photo doc is still 'visible'.
 */
import { test, before, after, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  ref, uploadBytes, getBytes, getMetadata, deleteObject, listAll,
} from 'firebase/storage';
import {
  makeEnv, seedConfig, patchConfig, seedPhoto, seedObject, storageRulesUnavailable,
  uid, uuid, TINY_JPEG,
} from './helpers.mjs';

let env;
let unavailable = null;
before(async () => {
  env = await makeEnv('sto');
  await seedConfig(env, { galleryReleased: false });
  unavailable = await storageRulesUnavailable(env);
});
after(async () => { await env.cleanup(); });

/** Every case below needs a loaded ruleset; skip loudly rather than fail red. */
const guard = (t) => (unavailable ? (t.skip(unavailable), true) : false);

const asGuest = (u) => env.authenticatedContext(u).storage();
const asGallery = () => env.authenticatedContext(uid('v'), { gallery: true }).storage();
const asAdmin = () => env.authenticatedContext(uid('admin'), { admin: true }).storage();
const jpeg = { contentType: 'image/jpeg' };

describe('uploads: write', () => {
  test('owner may write its own uuid-named JPEG exactly once', async (t) => {
    if (guard(t)) return;
    const u = uid('g');
    const id = uuid();
    await assertSucceeds(uploadBytes(ref(asGuest(u), `uploads/${u}/${id}`), TINY_JPEG, jpeg));
    // Write-once: the retry of an already-stored uuid must be refused (UPLOAD-003).
    await assertFails(uploadBytes(ref(asGuest(u), `uploads/${u}/${id}`), TINY_JPEG, jpeg));
  });

  test('an object may never be deleted or overwritten by its owner', async (t) => {
    if (guard(t)) return;
    const u = uid('g');
    const id = uuid();
    await seedObject(env, `uploads/${u}/${id}`);
    await assertFails(deleteObject(ref(asGuest(u), `uploads/${u}/${id}`)));
    await assertFails(uploadBytes(ref(asGuest(u), `uploads/${u}/${id}`), TINY_JPEG, jpeg));
  });

  test('a guest cannot write under another uid’s prefix', async (t) => {
    if (guard(t)) return;
    const me = uid('g');
    const victim = uid('victim');
    await assertFails(uploadBytes(ref(asGuest(me), `uploads/${victim}/${uuid()}`), TINY_JPEG, jpeg));
  });

  test('unauthenticated write is denied', async (t) => {
    if (guard(t)) return;
    const u = uid('g');
    await assertFails(uploadBytes(
      ref(env.unauthenticatedContext().storage(), `uploads/${u}/${uuid()}`), TINY_JPEG, jpeg));
  });

  test('contentType must be exactly image/jpeg', async (t) => {
    if (guard(t)) return;
    const u = uid('g');
    for (const contentType of ['image/png', 'text/html', 'application/octet-stream', 'image/jpeg; charset=x']) {
      await assertFails(uploadBytes(ref(asGuest(u), `uploads/${u}/${uuid()}`), TINY_JPEG, { contentType }));
    }
    // No contentType at all → the SDK sends application/octet-stream.
    await assertFails(uploadBytes(ref(asGuest(u), `uploads/${u}/${uuid()}`), TINY_JPEG));
  });

  test('the object name must be a bare lowercase uuid', async (t) => {
    if (guard(t)) return;
    const u = uid('g');
    const id = uuid();
    for (const name of [`${id}.jpg`, 'photo', id.toUpperCase(), id.slice(0, 30), `${id}-extra`]) {
      await assertFails(uploadBytes(ref(asGuest(u), `uploads/${u}/${name}`), TINY_JPEG, jpeg));
    }
    // Deeper paths fall through to the catch-all deny.
    await assertFails(uploadBytes(ref(asGuest(u), `uploads/${u}/nested/${id}`), TINY_JPEG, jpeg));
    await assertFails(uploadBytes(ref(asGuest(u), `uploads/${id}`), TINY_JPEG, jpeg));
  });

  test('empty and oversize uploads are refused (UPLOAD-007: 8MB hard cap)', async (t) => {
    if (guard(t)) return;
    const u = uid('g');
    await assertFails(uploadBytes(ref(asGuest(u), `uploads/${u}/${uuid()}`), new Uint8Array(0), jpeg));
    const tooBig = new Uint8Array(8 * 1024 * 1024 + 1);
    tooBig.set(TINY_JPEG.subarray(0, 3), 0);
    await assertFails(uploadBytes(ref(asGuest(u), `uploads/${u}/${uuid()}`), tooBig, jpeg));
    // Exactly at the cap is allowed by the pre-filter (the function still validates).
    const atCap = new Uint8Array(8 * 1024 * 1024);
    atCap.set(TINY_JPEG.subarray(0, 3), 0);
    await assertSucceeds(uploadBytes(ref(asGuest(u), `uploads/${u}/${uuid()}`), atCap, jpeg));
  });
});

describe('uploads: read', () => {
  test('the uploading guest can never read its own object back (D7)', async (t) => {
    if (guard(t)) return;
    const u = uid('g');
    const id = uuid();
    await seedObject(env, `uploads/${u}/${id}`);
    await assertFails(getBytes(ref(asGuest(u), `uploads/${u}/${id}`)));
    await assertFails(getMetadata(ref(asGuest(u), `uploads/${u}/${id}`)));
    await assertFails(listAll(ref(asGuest(u), `uploads/${u}`)));
  });

  test('admin may read any upload', async (t) => {
    if (guard(t)) return;
    const u = uid('g');
    const id = uuid();
    await seedObject(env, `uploads/${u}/${id}`);
    await assertSucceeds(getBytes(ref(asAdmin(), `uploads/${u}/${id}`)));
  });

  test('gallery viewer is denied while the gallery is locked', async (t) => {
    if (guard(t)) return;
    // The released/visible half of this rule needs the cross-service firestore.get,
    // which the emulator always resolves against its single configured project — see
    // storage-gallery.test.mjs for those cases.
    const u = uid('g');
    const id = uuid();
    await seedObject(env, `uploads/${u}/${id}`);
    await seedPhoto(env, { deviceUid: u, id, status: 'visible' });
    await patchConfig(env, { galleryReleased: false });
    await assertFails(getBytes(ref(asGallery(), `uploads/${u}/${id}`)));
  });
});

describe('theme + exports', () => {
  test('theme assets: readable when signed in, writable by admin only', async (t) => {
    if (guard(t)) return;
    await seedObject(env, 'theme/hero.jpg');
    await assertSucceeds(getBytes(ref(asGuest(uid('g')), 'theme/hero.jpg')));
    await assertSucceeds(getBytes(ref(asGallery(), 'theme/hero.jpg')));
    await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), 'theme/hero.jpg')));
    await assertFails(uploadBytes(ref(asGuest(uid('g')), 'theme/evil.jpg'), TINY_JPEG, jpeg));
    await assertSucceeds(uploadBytes(ref(asAdmin(), 'theme/hero2.jpg'), TINY_JPEG, jpeg));
    await assertFails(uploadBytes(ref(asAdmin(), 'theme/script.js'), TINY_JPEG,
      { contentType: 'text/javascript' }));
  });

  test('exports are admin-read-only and never client-written', async (t) => {
    if (guard(t)) return;
    await seedObject(env, 'exports/abc.zip', TINY_JPEG, 'application/zip');
    await assertSucceeds(getBytes(ref(asAdmin(), 'exports/abc.zip')));
    await assertFails(getBytes(ref(asGuest(uid('g')), 'exports/abc.zip')));
    await assertFails(getBytes(ref(asGallery(), 'exports/abc.zip')));
    await assertFails(uploadBytes(ref(asAdmin(), 'exports/forged.zip'), TINY_JPEG,
      { contentType: 'application/zip' }));
  });

  test('undeclared paths are closed to everyone', async (t) => {
    if (guard(t)) return;
    for (const storage of [asGuest(uid('g')), asGallery(), asAdmin()]) {
      await assertFails(uploadBytes(ref(storage, 'random/file'), TINY_JPEG, jpeg));
      await assertFails(getBytes(ref(storage, 'random/file')));
      await assertFails(listAll(ref(storage, '/')));
    }
  });
});
