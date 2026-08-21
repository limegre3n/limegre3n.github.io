/**
 * photos/{uuid} — CONTRACTS §2. Guests NEVER read photos (PRD D7/A4); gallery viewers
 * see only visible photos after release (D8, ADMIN-003); only admin may moderate.
 */
import { test, before, after, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, getDocs, query, collection, where,
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
const asGallery = () => env.authenticatedContext(uid('v'), { gallery: true }).firestore();
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
