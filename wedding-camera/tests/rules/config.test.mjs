/** config/event + config/private — CONTRACTS §2, PRD D13/D19. */
import { test, before, after, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { makeEnv, seedConfig, eventConfig, uid } from './helpers.mjs';

let env;
before(async () => { env = await makeEnv('cfg'); await seedConfig(env); });
after(async () => { await env.cleanup(); });

const asGuest = () => env.authenticatedContext(uid('g')).firestore();
const asGallery = () => env.authenticatedContext(uid('v'), { gallery: true }).firestore();
const asAdmin = () => env.authenticatedContext(uid('admin'), { admin: true }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

describe('config/event', () => {
  test('any signed-in user may read it', async () => {
    await assertSucceeds(getDoc(doc(asGuest(), 'config', 'event')));
    await assertSucceeds(getDoc(doc(asGallery(), 'config', 'event')));
    await assertSucceeds(getDoc(doc(asAdmin(), 'config', 'event')));
  });

  test('unauthenticated read is denied', async () => {
    await assertFails(getDoc(doc(anon(), 'config', 'event')));
  });

  test('guest cannot write it (pause/release forgery)', async () => {
    const db = asGuest();
    await assertFails(updateDoc(doc(db, 'config', 'event'), { paused: true }));
    await assertFails(updateDoc(doc(db, 'config', 'event'), { galleryReleased: true }));
    await assertFails(updateDoc(doc(db, 'config', 'event'), { defaultSnaps: 500 }));
  });

  test('gallery viewer cannot write it', async () => {
    await assertFails(updateDoc(doc(asGallery(), 'config', 'event'), { galleryReleased: false }));
  });

  test('admin may pause/resume and release (ADMIN-004, ADMIN-007)', async () => {
    const db = asAdmin();
    await assertSucceeds(updateDoc(doc(db, 'config', 'event'), { paused: true }));
    await assertSucceeds(updateDoc(doc(db, 'config', 'event'), { paused: false }));
    await assertSucceeds(updateDoc(doc(db, 'config', 'event'), { galleryReleased: true }));
    await assertSucceeds(updateDoc(doc(db, 'config', 'event'), { galleryReleased: false }));
  });

  test('admin may edit display copy and a valid theme', async () => {
    const db = asAdmin();
    await assertSucceeds(updateDoc(doc(db, 'config', 'event'), { coupleNames: 'Alex & Sam' }));
    await assertSucceeds(updateDoc(doc(db, 'config', 'event'), {
      theme: eventConfig().theme,
    }));
  });

  test('admin cannot repoint the slug or inflate defaultSnaps', async () => {
    const db = asAdmin();
    await assertFails(updateDoc(doc(db, 'config', 'event'), { slug: 'otherslug99' }));
    await assertFails(updateDoc(doc(db, 'config', 'event'), { defaultSnaps: 5000 }));
  });

  test('admin cannot break field types', async () => {
    const db = asAdmin();
    await assertFails(updateDoc(doc(db, 'config', 'event'), { paused: 'yes' }));
    await assertFails(updateDoc(doc(db, 'config', 'event'), { galleryReleased: 1 }));
    await assertFails(updateDoc(doc(db, 'config', 'event'), { startAt: 'tomorrow' }));
  });

  test('admin theme writes are structured-only (D19)', async () => {
    const db = asAdmin();
    const bad = (patch) => updateDoc(doc(db, 'config', 'event'),
      { theme: { ...eventConfig().theme, ...patch } });
    // Colours land in CSS custom properties → must be plain hex, never CSS payloads.
    await assertFails(bad({ colors: { bg: 'red; background:url(//evil)', accent: '#fff', text: '#000' } }));
    await assertFails(bad({ colors: { bg: '#141210', accent: '#e8b04b', text: 'inherit' } }));
    // Font comes from the frozen safe list only.
    await assertFails(bad({ font: 'Comic Sans, cursive' }));
    await assertFails(bad({ font: '' }));
    // Hero image must live under theme/.
    await assertFails(bad({ heroImagePath: 'exports/secret.zip' }));
    await assertSucceeds(bad({ heroImagePath: 'theme/hero.jpg' }));
    await assertSucceeds(bad({ font: 'rounded' }));
    await assertSucceeds(bad({}));
  });

  test('nobody may create or delete config/event', async () => {
    await assertFails(deleteDoc(doc(asAdmin(), 'config', 'event')));
    await assertFails(setDoc(doc(asAdmin(), 'config', 'newdoc'), { x: 1 }));
  });
});

describe('config/private', () => {
  test('no client may read it — not guests, not gallery viewers, not admin', async () => {
    await assertFails(getDoc(doc(asGuest(), 'config', 'private')));
    await assertFails(getDoc(doc(asGallery(), 'config', 'private')));
    await assertFails(getDoc(doc(asAdmin(), 'config', 'private')));
    await assertFails(getDoc(doc(anon(), 'config', 'private')));
  });

  test('no client may write it', async () => {
    await assertFails(updateDoc(doc(asAdmin(), 'config', 'private'), { eventCap: 999999 }));
    await assertFails(setDoc(doc(asGuest(), 'config', 'private'), { eventCap: 1 }));
  });
});
