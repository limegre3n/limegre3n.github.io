/**
 * photos/{uuid} — CONTRACTS §2. Guests NEVER read photos (PRD D7/A4); gallery viewers
 * see only visible photos after release (D8, ADMIN-003); only admin may moderate.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, getDocs, query, collection, where, orderBy,
  deleteField,
} from 'firebase/firestore';
import { makeEnv, seedConfig, patchConfig, seedPhoto, uid, uuid } from './helpers.mjs';

let env;
let ownerUid;
let visibleId;
let hiddenId;

before(async () => {
  env = await makeEnv('pho');
  await seedConfig(env, { galleryReleased: false });
  ownerUid = uid('g');
  visibleId = await seedPhoto(env, { deviceUid: ownerUid, status: 'visible' });
  hiddenId = await seedPhoto(env, { deviceUid: ownerUid, status: 'hidden' });
});
after(async () => { await env.cleanup(); });

const asGuest = (u = uid('g')) => env.authenticatedContext(u).firestore();
const asGallery = (u = uid('v')) => env.authenticatedContext(u, { gallery: true }).firestore();
const asAdmin = () => env.authenticatedContext(uid('admin'), { admin: true }).firestore();

describe('photos: read', () => {
  test('the guest who took the photo still cannot read it (D7)', async () => {
    const db = asGuest(ownerUid);
    await assertFails(getDoc(doc(db, 'photos', visibleId)));
    await assertFails(getDocs(collection(db, 'photos')));
    await assertFails(getDocs(query(collection(db, 'photos'), where('status', '==', 'visible'))));
  });

  test('unauthenticated read is denied', async () => {
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'photos', visibleId)));
  });

  test('admin reads and lists everything, hidden included (ADMIN-002)', async () => {
    const db = asAdmin();
    await assertSucceeds(getDoc(doc(db, 'photos', visibleId)));
    await assertSucceeds(getDoc(doc(db, 'photos', hiddenId)));
    await assertSucceeds(getDocs(collection(db, 'photos')));
  });

  test('gallery claim is not enough before release (GALLERY-001)', async () => {
    const db = asGallery();
    await assertFails(getDoc(doc(db, 'photos', visibleId)));
    await assertFails(getDocs(query(collection(db, 'photos'), where('status', '==', 'visible'))));
  });

  test('after release a gallery viewer sees visible photos but never hidden ones', async () => {
    await patchConfig(env, { galleryReleased: true });
    try {
      const db = asGallery();
      await assertSucceeds(getDoc(doc(db, 'photos', visibleId)));
      await assertSucceeds(getDocs(query(collection(db, 'photos'), where('status', '==', 'visible'))));
      // PRD acceptance 10: a hidden photo never appears in the released gallery.
      await assertFails(getDoc(doc(db, 'photos', hiddenId)));
      await assertFails(getDocs(collection(db, 'photos')));
      await assertFails(getDocs(query(collection(db, 'photos'), where('status', '==', 'hidden'))));
      // A plain guest (no gallery claim) is still locked out after release.
      await assertFails(getDoc(doc(asGuest(), 'photos', visibleId)));
    } finally {
      await patchConfig(env, { galleryReleased: false });
    }
  });
});

describe('photos: write', () => {
  test('clients cannot create or delete photo docs', async () => {
    const guest = asGuest(ownerUid);
    await assertFails(setDoc(doc(guest, 'photos', uuid()), { deviceUid: ownerUid, status: 'visible' }));
    await assertFails(deleteDoc(doc(guest, 'photos', visibleId)));
    const admin = asAdmin();
    await assertFails(setDoc(doc(admin, 'photos', uuid()), { deviceUid: ownerUid, status: 'visible' }));
    await assertFails(deleteDoc(doc(admin, 'photos', visibleId)));
  });

  test('admin may flip status and rotation (ADMIN-003)', async () => {
    const db = asAdmin();
    const id = await seedPhoto(env, { deviceUid: ownerUid });
    await assertSucceeds(updateDoc(doc(db, 'photos', id), { status: 'hidden' }));
    await assertSucceeds(updateDoc(doc(db, 'photos', id), { status: 'visible' }));
    await assertSucceeds(updateDoc(doc(db, 'photos', id), { rotation: 90 }));
    await assertSucceeds(updateDoc(doc(db, 'photos', id), { status: 'hidden', rotation: 270 }));
  });

  test('admin cannot write any other field, nor invalid enum values', async () => {
    const db = asAdmin();
    const id = await seedPhoto(env, { deviceUid: ownerUid });
    await assertFails(updateDoc(doc(db, 'photos', id), { nickname: 'Rewritten' }));
    await assertFails(updateDoc(doc(db, 'photos', id), { deviceUid: uid('someone') }));
    await assertFails(updateDoc(doc(db, 'photos', id), { storagePath: 'uploads/x/y' }));
    await assertFails(updateDoc(doc(db, 'photos', id), { byteSize: 1 }));
    await assertFails(updateDoc(doc(db, 'photos', id), { status: 'deleted' }));
    await assertFails(updateDoc(doc(db, 'photos', id), { rotation: 45 }));
    await assertFails(updateDoc(doc(db, 'photos', id), { status: 'hidden', nickname: 'x' }));
  });

  test('guests and gallery viewers cannot moderate', async () => {
    await assertFails(updateDoc(doc(asGuest(ownerUid), 'photos', visibleId), { status: 'hidden' }));
    await assertFails(updateDoc(doc(asGallery(), 'photos', visibleId), { status: 'hidden' }));
    await patchConfig(env, { galleryReleased: true });
    try {
      await assertFails(updateDoc(doc(asGallery(), 'photos', visibleId), { status: 'hidden' }));
    } finally {
      await patchConfig(env, { galleryReleased: false });
    }
  });
});

// GALLERY-007 — the couple's captions. `caption` joins status/rotation as the only
// client-writable fields on a photo, and only for an admin.
describe('photos: captions (GALLERY-007)', () => {
  test('admin may set, re-set, empty and clear a caption', async () => {
    const db = asAdmin();
    const id = await seedPhoto(env, { deviceUid: ownerUid });
    await assertSucceeds(updateDoc(doc(db, 'photos', id), { caption: 'First dance' }));
    await assertSucceeds(updateDoc(doc(db, 'photos', id), { caption: 'The first dance' }));
    // '' is the contract's "no caption"; so is removing the key entirely.
    await assertSucceeds(updateDoc(doc(db, 'photos', id), { caption: '' }));
    await assertSucceeds(updateDoc(doc(db, 'photos', id), { caption: 'x'.repeat(200) }));
    await assertSucceeds(updateDoc(doc(db, 'photos', id), { caption: deleteField() }));
  });

  test('caption may be combined with the other moderation fields', async () => {
    const db = asAdmin();
    const id = await seedPhoto(env, { deviceUid: ownerUid });
    await assertSucceeds(updateDoc(doc(db, 'photos', id),
      { caption: 'Cake', status: 'hidden', rotation: 90 }));
  });

  test('over-long or non-string captions are rejected', async () => {
    const db = asAdmin();
    const id = await seedPhoto(env, { deviceUid: ownerUid });
    await assertFails(updateDoc(doc(db, 'photos', id), { caption: 'x'.repeat(201) }));
    await assertFails(updateDoc(doc(db, 'photos', id), { caption: 42 }));
    await assertFails(updateDoc(doc(db, 'photos', id), { caption: null }));
    await assertFails(updateDoc(doc(db, 'photos', id), { caption: ['a'] }));
    await assertFails(updateDoc(doc(db, 'photos', id), { caption: { text: 'a' } }));
  });

  test('caption does not smuggle in a disallowed field or a bad enum', async () => {
    const db = asAdmin();
    const id = await seedPhoto(env, { deviceUid: ownerUid });
    await assertFails(updateDoc(doc(db, 'photos', id), { caption: 'ok', nickname: 'Rewritten' }));
    await assertFails(updateDoc(doc(db, 'photos', id), { caption: 'ok', deviceUid: uid('someone') }));
    await assertFails(updateDoc(doc(db, 'photos', id), { caption: 'ok', status: 'deleted' }));
    await assertFails(updateDoc(doc(db, 'photos', id), { caption: 'ok', rotation: 45 }));
  });

  test('guests and gallery viewers cannot caption, released or not', async () => {
    await assertFails(updateDoc(doc(asGuest(ownerUid), 'photos', visibleId), { caption: 'mine' }));
    await assertFails(updateDoc(doc(asGallery(), 'photos', visibleId), { caption: 'mine' }));
    await patchConfig(env, { galleryReleased: true });
    try {
      await assertFails(updateDoc(doc(asGallery(), 'photos', visibleId), { caption: 'mine' }));
      await assertFails(updateDoc(doc(asGuest(ownerUid), 'photos', visibleId), { caption: 'mine' }));
    } finally {
      await patchConfig(env, { galleryReleased: false });
    }
  });
});

// GALLERY-008 "Your film" — a gallery viewer lists the photos THEY took. The rule is
// unchanged (gallery claim + released + status visible); what this pins down is that the
// deviceUid/status/receivedAt query shape the client sends is actually accepted, and that
// dropping the status filter is refused by the rules engine rather than silently widened.
describe('photos: your film query (GALLERY-008)', () => {
  const myFilm = (db, u) => query(
    collection(db, 'photos'),
    where('deviceUid', '==', u),
    where('status', '==', 'visible'),
    orderBy('receivedAt', 'asc'),
  );

  test('gallery viewer may list their own visible photos after release', async () => {
    const me = uid('v');
    await seedPhoto(env, { deviceUid: me, status: 'visible' });
    await seedPhoto(env, { deviceUid: me, status: 'hidden' });
    await patchConfig(env, { galleryReleased: true });
    try {
      const snap = await assertSucceeds(getDocs(myFilm(asGallery(me), me)));
      // Only the visible one comes back — the hidden photo is filtered, not denied.
      assert.equal(snap.size, 1);
    } finally {
      await patchConfig(env, { galleryReleased: false });
    }
  });

  test('the same query is denied without the gallery claim, and before release', async () => {
    const me = uid('g');
    await seedPhoto(env, { deviceUid: me, status: 'visible' });
    // Signed in, owns the film, but never entered the PIN (D7/A4).
    await patchConfig(env, { galleryReleased: true });
    try {
      await assertFails(getDocs(myFilm(asGuest(me), me)));
      await assertFails(getDocs(myFilm(env.unauthenticatedContext().firestore(), me)));
    } finally {
      await patchConfig(env, { galleryReleased: false });
    }
    // Gallery claim alone is not enough while the gallery is locked (GALLERY-001).
    await assertFails(getDocs(myFilm(asGallery(me), me)));
  });

  test('dropping the status filter is refused even for the viewer\'s own photos', async () => {
    const me = uid('v');
    await seedPhoto(env, { deviceUid: me, status: 'visible' });
    await patchConfig(env, { galleryReleased: true });
    try {
      const db = asGallery(me);
      await assertFails(getDocs(query(
        collection(db, 'photos'),
        where('deviceUid', '==', me),
        orderBy('receivedAt', 'asc'),
      )));
      // ...and a viewer cannot fish for someone else's hidden film either.
      await assertFails(getDocs(query(
        collection(db, 'photos'),
        where('deviceUid', '==', me),
        where('status', '==', 'hidden'),
        orderBy('receivedAt', 'asc'),
      )));
    } finally {
      await patchConfig(env, { galleryReleased: false });
    }
  });
});
