/**
 * audit/{autoId} (ADMIN-008), counters/event, pinAttempts/{uid} and the catch-all deny.
 * CONTRACTS §2.
 */
import { test, before, after, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, getDocs, collection, serverTimestamp,
} from 'firebase/firestore';
import { makeEnv, seedConfig, uid, uuid } from './helpers.mjs';

let env;
before(async () => { env = await makeEnv('aud'); await seedConfig(env); });
after(async () => { await env.cleanup(); });

const asGuest = (u = uid('g')) => env.authenticatedContext(u).firestore();
const asGallery = () => env.authenticatedContext(uid('v'), { gallery: true }).firestore();
const adminUid = () => uid('admin');
const asAdminWith = (u) => env.authenticatedContext(u, { admin: true }).firestore();

describe('audit', () => {
  test('admin may create a record naming itself as actor', async () => {
    const me = adminUid();
    const db = asAdminWith(me);
    for (const action of ['hide', 'unhide', 'rotate', 'caption', 'pause', 'resume',
      'grant', 'release', 'export']) {
      await assertSucceeds(addDoc(collection(db, 'audit'),
        { action, target: uuid(), actorUid: me, at: serverTimestamp() }));
    }
    // target is nullable per the contract (pause/resume/release have no target).
    await assertSucceeds(addDoc(collection(db, 'audit'),
      { action: 'pause', target: null, actorUid: me, at: serverTimestamp() }));
    await assertSucceeds(addDoc(collection(db, 'audit'),
      { action: 'release', actorUid: me, at: serverTimestamp() }));
  });

  // GALLERY-007: captioning is a moderation action, so it is audited like hide/rotate.
  test("'caption' is an auditable admin action, still admin-only", async () => {
    const me = adminUid();
    await assertSucceeds(addDoc(collection(asAdminWith(me), 'audit'),
      { action: 'caption', target: uuid(), actorUid: me, at: serverTimestamp() }));
    const g = uid('g');
    await assertFails(addDoc(collection(asGuest(g), 'audit'),
      { action: 'caption', target: uuid(), actorUid: g, at: serverTimestamp() }));
    const v = uid('v');
    await assertFails(addDoc(collection(asGallery(), 'audit'),
      { action: 'caption', target: uuid(), actorUid: v, at: serverTimestamp() }));
  });

  test('guests and gallery viewers cannot write audit records', async () => {
    const g = uid('g');
    await assertFails(addDoc(collection(asGuest(g), 'audit'),
      { action: 'release', target: null, actorUid: g, at: serverTimestamp() }));
    const v = uid('v');
    await assertFails(addDoc(collection(asGallery(), 'audit'),
      { action: 'export', target: null, actorUid: v, at: serverTimestamp() }));
    await assertFails(addDoc(collection(env.unauthenticatedContext().firestore(), 'audit'),
      { action: 'pause', target: null, actorUid: 'nobody', at: serverTimestamp() }));
  });

  test('admin cannot forge another actorUid', async () => {
    const me = adminUid();
    await assertFails(addDoc(collection(asAdminWith(me), 'audit'),
      { action: 'hide', target: uuid(), actorUid: uid('someoneelse'), at: serverTimestamp() }));
  });

  test('unknown actions, stray fields and bad timestamps are rejected', async () => {
    const me = adminUid();
    const db = asAdminWith(me);
    const base = { target: null, actorUid: me, at: serverTimestamp() };
    await assertFails(addDoc(collection(db, 'audit'), { ...base, action: 'delete_everything' }));
    await assertFails(addDoc(collection(db, 'audit'), { ...base, action: 'HIDE' }));
    await assertFails(addDoc(collection(db, 'audit'), { ...base, action: 'hide', note: 'extra' }));
    await assertFails(addDoc(collection(db, 'audit'), { ...base, action: 'hide', at: 'now' }));
    await assertFails(addDoc(collection(db, 'audit'), { action: 'hide', actorUid: me }));
    await assertFails(addDoc(collection(db, 'audit'),
      { action: 'hide', target: 42, actorUid: me, at: serverTimestamp() }));
  });

  test('audit records are append-only and admin-readable only', async () => {
    const me = adminUid();
    const db = asAdminWith(me);
    const ref = await addDoc(collection(db, 'audit'),
      { action: 'grant', target: uid('device'), actorUid: me, at: serverTimestamp() });
    await assertFails(updateDoc(doc(db, 'audit', ref.id), { action: 'export' }));
    await assertFails(deleteDoc(doc(db, 'audit', ref.id)));
    await assertSucceeds(getDocs(collection(db, 'audit')));
    await assertFails(getDoc(doc(asGuest(), 'audit', ref.id)));
    await assertFails(getDocs(collection(asGuest(), 'audit')));
  });
});

describe('counters/event', () => {
  test('admin may read, no client may write (function-owned)', async () => {
    await assertSucceeds(getDoc(doc(asAdminWith(adminUid()), 'counters', 'event')));
    await assertFails(getDoc(doc(asGuest(), 'counters', 'event')));
    await assertFails(getDoc(doc(asGallery(), 'counters', 'event')));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'counters', 'event')));
    // The hidden event cap must not be reachable or resettable from a client (D3).
    await assertFails(setDoc(doc(asAdminWith(adminUid()), 'counters', 'event'), { photoCount: 0 }));
    await assertFails(updateDoc(doc(asAdminWith(adminUid()), 'counters', 'event'), { photoCount: 0 }));
    await assertFails(setDoc(doc(asGuest(), 'counters', 'event'), { photoCount: 0 }));
  });
});

describe('pinAttempts', () => {
  test('no client may read or write the rate-limit ledger (GALLERY-002)', async () => {
    const v = uid('v');
    const gallery = asGallery();
    await assertFails(getDoc(doc(gallery, 'pinAttempts', v)));
    await assertFails(setDoc(doc(gallery, 'pinAttempts', v), { count: 0 }));
    await assertFails(deleteDoc(doc(gallery, 'pinAttempts', v)));
    const admin = asAdminWith(adminUid());
    await assertFails(getDoc(doc(admin, 'pinAttempts', v)));
    await assertFails(setDoc(doc(admin, 'pinAttempts', v), { count: 0 }));
    await assertFails(setDoc(doc(asGuest(v), 'pinAttempts', v), { count: 0 }));
  });
});

describe('catch-all', () => {
  test('undeclared collections are closed to everyone', async () => {
    for (const db of [asGuest(), asGallery(), asAdminWith(adminUid())]) {
      await assertFails(getDoc(doc(db, 'whatever', 'x')));
      await assertFails(setDoc(doc(db, 'whatever', 'x'), { a: 1 }));
      await assertFails(getDocs(collection(db, 'whatever')));
      await assertFails(setDoc(doc(db, 'devices', uid('d'), 'sub', 'x'), { a: 1 }));
    }
  });
});
