/** devices/{uid} — CONTRACTS §2. Guest owns its doc; quota is never client-writable. */
import { test, before, after, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, getDocs, collection } from 'firebase/firestore';
import { makeEnv, seedConfig, seedDevice, devicePayload, uid, DEFAULT_SNAPS } from './helpers.mjs';

let env;
before(async () => { env = await makeEnv('dev'); await seedConfig(env); });
after(async () => { await env.cleanup(); });

const asGuest = (u) => env.authenticatedContext(u).firestore();
const asAdmin = () => env.authenticatedContext(uid('admin'), { admin: true }).firestore();

describe('devices: create', () => {
  test('guest creates its own doc with the default snap allowance', async () => {
    const u = uid('g');
    await assertSucceeds(setDoc(doc(asGuest(u), 'devices', u), devicePayload()));
  });

  test('guest cannot create a doc for another uid', async () => {
    const u = uid('g');
    await assertFails(setDoc(doc(asGuest(u), 'devices', uid('victim')), devicePayload()));
  });

  test('unauthenticated create is denied', async () => {
    const u = uid('g');
    await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), 'devices', u), devicePayload()));
  });

  test('snapsRemaining must equal config/event.defaultSnaps', async () => {
    for (const snaps of [DEFAULT_SNAPS + 1, DEFAULT_SNAPS - 1, 0, 999, '10']) {
      const u = uid('g');
      await assertFails(setDoc(doc(asGuest(u), 'devices', u), devicePayload({ snapsRemaining: snaps })));
    }
  });

  test('snapsGranted must start at 0', async () => {
    const u = uid('g');
    await assertFails(setDoc(doc(asGuest(u), 'devices', u), devicePayload({ snapsGranted: 5 })));
  });

  test('nickname length 0 and 31 are rejected, 1 and 30 accepted', async () => {
    const empty = uid('g');
    await assertFails(setDoc(doc(asGuest(empty), 'devices', empty), devicePayload({ nickname: '' })));
    const long = uid('g');
    await assertFails(setDoc(doc(asGuest(long), 'devices', long), devicePayload({ nickname: 'x'.repeat(31) })));

    const one = uid('g');
    await assertSucceeds(setDoc(doc(asGuest(one), 'devices', one), devicePayload({ nickname: 'x' })));
    const thirty = uid('g');
    await assertSucceeds(setDoc(doc(asGuest(thirty), 'devices', thirty), devicePayload({ nickname: 'x'.repeat(30) })));
  });

  test('non-string nickname is rejected', async () => {
    const u = uid('g');
    await assertFails(setDoc(doc(asGuest(u), 'devices', u), devicePayload({ nickname: 12345 })));
  });

  test('extra or missing fields are rejected', async () => {
    const extra = uid('g');
    await assertFails(setDoc(doc(asGuest(extra), 'devices', extra),
      devicePayload({ isAdmin: true })));
    const missing = uid('g');
    await assertFails(setDoc(doc(asGuest(missing), 'devices', missing),
      { nickname: 'No timestamps', snapsRemaining: DEFAULT_SNAPS, snapsGranted: 0 }));
  });

  test('non-timestamp createdAt is rejected', async () => {
    const u = uid('g');
    await assertFails(setDoc(doc(asGuest(u), 'devices', u), devicePayload({ createdAt: 'yesterday' })));
  });
});

describe('devices: read', () => {
  test('owner gets its own doc; other guests cannot; admin can', async () => {
    const owner = uid('g');
    await seedDevice(env, owner);
    await assertSucceeds(getDoc(doc(asGuest(owner), 'devices', owner)));
    await assertFails(getDoc(doc(asGuest(uid('other')), 'devices', owner)));
    await assertSucceeds(getDoc(doc(asAdmin(), 'devices', owner)));
  });

  test('only admin may list devices (ADMIN-005 device picker)', async () => {
    await assertFails(getDocs(collection(asGuest(uid('g')), 'devices')));
    await assertSucceeds(getDocs(collection(asAdmin(), 'devices')));
  });
});

describe('devices: update', () => {
  test('owner may update lastSeenAt', async () => {
    const owner = uid('g');
    await seedDevice(env, owner);
    await assertSucceeds(updateDoc(doc(asGuest(owner), 'devices', owner), { lastSeenAt: new Date() }));
  });

  test('owner cannot write a non-timestamp lastSeenAt', async () => {
    const owner = uid('g');
    await seedDevice(env, owner);
    await assertFails(updateDoc(doc(asGuest(owner), 'devices', owner), { lastSeenAt: 'now' }));
  });

  test('owner cannot touch snapsRemaining, snapsGranted or nickname', async () => {
    const owner = uid('g');
    await seedDevice(env, owner);
    const db = asGuest(owner);
    await assertFails(updateDoc(doc(db, 'devices', owner), { snapsRemaining: 100 }));
    await assertFails(updateDoc(doc(db, 'devices', owner), { snapsGranted: 5 }));
    await assertFails(updateDoc(doc(db, 'devices', owner), { nickname: 'Renamed' }));
    await assertFails(updateDoc(doc(db, 'devices', owner),
      { lastSeenAt: new Date(), snapsRemaining: 100 }));
  });

  test('another guest cannot update someone else’s device', async () => {
    const owner = uid('g');
    await seedDevice(env, owner);
    await assertFails(updateDoc(doc(asGuest(uid('other')), 'devices', owner), { lastSeenAt: new Date() }));
  });

  test('admin grant may change snapsRemaining + snapsGranted only (ADMIN-005)', async () => {
    const owner = uid('g');
    await seedDevice(env, owner);
    const db = asAdmin();
    await assertSucceeds(updateDoc(doc(db, 'devices', owner),
      { snapsRemaining: DEFAULT_SNAPS + 5, snapsGranted: 5 }));
    await assertFails(updateDoc(doc(db, 'devices', owner), { nickname: 'Admin rename' }));
    await assertFails(updateDoc(doc(db, 'devices', owner), { lastSeenAt: new Date() }));
  });

  test('admin cannot make snaps negative or claw back a grant', async () => {
    const owner = uid('g');
    await seedDevice(env, owner, { snapsGranted: 5, snapsRemaining: 5 });
    const db = asAdmin();
    await assertFails(updateDoc(doc(db, 'devices', owner), { snapsRemaining: -1 }));
    await assertFails(updateDoc(doc(db, 'devices', owner), { snapsGranted: 0 }));
    await assertFails(updateDoc(doc(db, 'devices', owner), { snapsRemaining: 'lots' }));
  });
});

describe('devices: delete', () => {
  test('nobody may delete a device doc', async () => {
    const owner = uid('g');
    await seedDevice(env, owner);
    await assertFails(deleteDoc(doc(asGuest(owner), 'devices', owner)));
    await assertFails(deleteDoc(doc(asAdmin(), 'devices', owner)));
  });
});
