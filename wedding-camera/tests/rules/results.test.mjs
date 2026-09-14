/**
 * results/{uuid} — CONTRACTS §2/§6. The client's only confirmation signal: it must be
 * gettable BEFORE the doc exists (the uploader subscribes first), owner-scoped once it
 * does, never listable, never client-writable.
 */
import { test, before, after, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, getDocs, collection, onSnapshot,
} from 'firebase/firestore';
import { makeEnv, seedConfig, seedResult, uid, uuid } from './helpers.mjs';

let env;
let ownerUid;
let ownedId;

before(async () => {
  env = await makeEnv('res');
  await seedConfig(env);
  ownerUid = uid('g');
  ownedId = await seedResult(env, { deviceUid: ownerUid, ok: true });
});
after(async () => { await env.cleanup(); });

const asGuest = (u = uid('g')) => env.authenticatedContext(u).firestore();
const asAdmin = () => env.authenticatedContext(uid('admin'), { admin: true }).firestore();

/** onSnapshot equivalent of getDoc, since that is what queue.js actually uses. */
function snapshotOnce(ref) {
  return new Promise((resolve, reject) => {
    const unsub = onSnapshot(ref, (snap) => { unsub(); resolve(snap); }, (err) => { unsub(); reject(err); });
  });
}

describe('results: read', () => {
  test('owner may get its own result', async () => {
    await assertSucceeds(getDoc(doc(asGuest(ownerUid), 'results', ownedId)));
  });

  test('owner may subscribe to a result that does not exist yet (UPLOAD protocol §6.4)', async () => {
    const pending = uuid();
    const db = asGuest(ownerUid);
    await assertSucceeds(getDoc(doc(db, 'results', pending)));
    const snap = await assertSucceeds(snapshotOnce(doc(db, 'results', pending)));
    if (snap.exists()) throw new Error('expected a non-existent doc');
  });

  test('another device cannot read someone else’s result', async () => {
    await assertFails(getDoc(doc(asGuest(uid('other')), 'results', ownedId)));
  });

  test('unauthenticated read is denied even for missing docs', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'results', ownedId)));
    await assertFails(getDoc(doc(db, 'results', uuid())));
  });

  test('admin may read any result', async () => {
    await assertSucceeds(getDoc(doc(asAdmin(), 'results', ownedId)));
  });

  test('nobody may list results', async () => {
    await assertFails(getDocs(collection(asGuest(ownerUid), 'results')));
    await assertFails(getDocs(collection(asAdmin(), 'results')));
  });
});

describe('results: write', () => {
  test('clients cannot forge, edit or delete results', async () => {
    const db = asGuest(ownerUid);
    await assertFails(setDoc(doc(db, 'results', uuid()),
      { deviceUid: ownerUid, ok: true, reason: null, at: new Date() }));
    await assertFails(updateDoc(doc(db, 'results', ownedId), { ok: false }));
    await assertFails(deleteDoc(doc(db, 'results', ownedId)));
  });

  test('not even admin may write results', async () => {
    const db = asAdmin();
    await assertFails(setDoc(doc(db, 'results', uuid()), { deviceUid: ownerUid, ok: true }));
    await assertFails(updateDoc(doc(db, 'results', ownedId), { ok: false }));
    await assertFails(deleteDoc(doc(db, 'results', ownedId)));
  });
});
