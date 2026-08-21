/**
 * Browser-side test harness for the upload queue (workstream ②).
 *
 * Loaded IN THE PAGE through Vite's `/@fs/` prefix so that bare specifiers
 * ('firebase/auth') resolve to the exact same optimized-dep URLs the app uses —
 * that keeps a single Firebase SDK instance shared with `/src/lib/firebase.js`.
 *
 * It deliberately touches NO guest UI: the queue module is exercised directly,
 * so workstream ①'s DOM can change freely without breaking these tests.
 */
import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '/src/lib/firebase.js';
import { queue } from '/src/guest/queue.js';

const h = {
  queue,
  auth,
  events: [],
  onlineEvents: 0,
  offlineEvents: 0,
  errors: [],
};
window.__h = h;

// Attach before init() so no 'change' event can be missed.
queue.addEventListener('change', (e) => { h.events.push(e.detail); });
globalThis.addEventListener('online', () => { h.onlineEvents += 1; });
globalThis.addEventListener('offline', () => { h.offlineEvents += 1; });
globalThis.addEventListener('error', (e) => { h.errors.push(String(e.message)); });
globalThis.addEventListener('unhandledrejection', (e) => {
  h.errors.push(`unhandledrejection: ${String(e.reason?.message || e.reason)}`);
});

h.waitAuth = (timeoutMs = 15000) => new Promise((resolve, reject) => {
  if (auth.currentUser) { resolve(auth.currentUser.uid); return; }
  const t = setTimeout(() => { stop(); reject(new Error('auth-restore-timeout')); }, timeoutMs);
  const stop = onAuthStateChanged(auth, (u) => {
    if (u) { clearTimeout(t); stop(); resolve(u.uid); }
  });
});

/** Fresh anonymous device per test (CONTRACTS §2 devices/{uid} shape). */
h.signIn = async (nickname = 'E2E Tester') => {
  const cred = await signInAnonymously(auth);
  const uid = cred.user.uid;
  const cfg = (await getDoc(doc(db, 'config', 'event'))).data();
  await setDoc(doc(db, 'devices', uid), {
    nickname,
    snapsRemaining: cfg.defaultSnaps,
    snapsGranted: 0,
    createdAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
    consentShownAt: serverTimestamp(),
  });
  return { uid, defaultSnaps: cfg.defaultSnaps };
};

h.initQueue = () => queue.init().then(() => ({
  pending: queue.pendingCount,
  persistent: queue.persistent,
}));

/** Real canvas-encoded JPEG (valid FF D8 FF magic bytes for the finalize check). */
h.makeJpeg = (size = 64, seed = Math.random()) => {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#c8a15a';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = `hsl(${Math.floor(seed * 360)}, 60%, 30%)`;
  ctx.fillRect(4, 4, size / 2, size / 2);
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.8);
  });
};

h.shoot = async (n = 1) => {
  const uuids = [];
  for (let i = 0; i < n; i += 1) {
    const blob = await h.makeJpeg(64, (i + 1) / (n + 1));
    uuids.push(await queue.enqueue(blob, Date.now()));
  }
  return uuids;
};

h.pending = () => queue.pendingCount;
h.states = () => [...queue.items.values()].map((i) => ({ uuid: i.uuid, state: i.state, attempts: i.attemptCount }));

/** Direct read of the persisted queue store, bypassing the module. */
h.idbRecords = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('wedding-camera', 1);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains('queue')) req.result.createObjectStore('queue', { keyPath: 'uuid' });
  };
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const dbh = req.result;
    const get = dbh.transaction('queue', 'readonly').objectStore('queue').getAll();
    get.onsuccess = () => resolve((get.result || []).map((r) => ({
      uuid: r.uuid,
      hasBlob: !!r.blob && typeof r.blob.size === 'number' && r.blob.size > 0,
      attemptCount: r.attemptCount,
      state: r.state,
    })));
    get.onerror = () => reject(get.error);
  };
});

/** Writes a corrupted record (payload lost) to exercise the graceful-drop path. */
h.seedBlobLossRecord = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('wedding-camera', 1);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains('queue')) req.result.createObjectStore('queue', { keyPath: 'uuid' });
  };
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const uuid = crypto.randomUUID();
    const tx = req.result.transaction('queue', 'readwrite');
    tx.objectStore('queue').put({ uuid, blob: null, capturedAt: Date.now(), attemptCount: 0, state: 'queued' });
    tx.oncomplete = () => resolve(uuid);
    tx.onerror = () => reject(tx.error);
  };
});

h.ready = true;
window.dispatchEvent(new Event('__harness-ready'));
