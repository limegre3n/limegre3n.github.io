/**
 * Persistent upload queue (workstream ② — contract: docs/CONTRACTS.md §6).
 * Every capture lands in IndexedDB BEFORE any upload attempt (UPLOAD-001).
 * States per item: queued → uploading → awaitingResult → confirmed | rejected.
 */
import { ref, uploadBytes } from 'firebase/storage';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { storage, db, auth } from '../lib/firebase.js';

const DB_NAME = 'wedding-camera';
const STORE = 'queue';
const MAX_BACKOFF_MS = 60_000;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'uuid' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(dbHandle, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = dbHandle.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

class UploadQueue extends EventTarget {
  constructor() {
    super();
    this.items = new Map(); // uuid -> {uuid, capturedAt, attemptCount, state}
    this.blobs = new Map(); // uuid -> Blob (also persisted in IDB)
    this.timers = new Map();
    this.watchers = new Map();
    this.dbHandle = null;
    this.persistent = null; // null=unknown, false=ephemeral (private browsing)
  }

  get pendingCount() {
    return [...this.items.values()].filter((i) => i.state !== 'confirmed').length;
  }

  emitChange(extra = {}) {
    this.dispatchEvent(new CustomEvent('change', {
      detail: { pending: this.pendingCount, ...extra },
    }));
  }

  async init() {
    try {
      this.dbHandle = await openDb();
      if (navigator.storage?.persist) {
        this.persistent = await navigator.storage.persist().catch(() => null);
      }
      const all = await new Promise((resolve, reject) => {
        const tx = this.dbHandle.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      for (const rec of all) {
        this.items.set(rec.uuid, {
          uuid: rec.uuid, capturedAt: rec.capturedAt,
          attemptCount: rec.attemptCount || 0, state: 'queued',
        });
        this.blobs.set(rec.uuid, rec.blob);
      }
    } catch (e) {
      // IndexedDB unavailable (rare / lockdown mode): memory-only queue.
      this.dbHandle = null;
      this.persistent = false;
    }
    globalThis.addEventListener('online', () => this.pumpAll(true));
    window.addEventListener('beforeunload', (e) => {
      if (this.pendingCount > 0) { e.preventDefault(); e.returnValue = ''; }
    });
    if (this.items.size) this.pumpAll();
    this.emitChange();
  }

  async enqueue(blob, capturedAt = Date.now()) {
    const uuid = crypto.randomUUID();
    const rec = { uuid, blob, capturedAt, attemptCount: 0 };
    this.items.set(uuid, { uuid, capturedAt, attemptCount: 0, state: 'queued' });
    this.blobs.set(uuid, blob);
    if (this.dbHandle) {
      await idb(this.dbHandle, 'readwrite', (s) => s.put(rec)).catch(() => {});
    }
    this.emitChange();
    this.pump(uuid);
    return uuid;
  }

  async remove(uuid) {
    this.items.delete(uuid);
    this.blobs.delete(uuid);
    clearTimeout(this.timers.get(uuid));
    this.timers.delete(uuid);
    const unsub = this.watchers.get(uuid);
    if (unsub) { unsub(); this.watchers.delete(uuid); }
    if (this.dbHandle) {
      await idb(this.dbHandle, 'readwrite', (s) => s.delete(uuid)).catch(() => {});
    }
  }

  pumpAll(immediate = false) {
    for (const item of this.items.values()) {
      if (item.state === 'queued') {
        if (immediate) { clearTimeout(this.timers.get(item.uuid)); this.timers.delete(item.uuid); }
        this.pump(item.uuid);
      }
    }
  }

  async pump(uuid) {
    const item = this.items.get(uuid);
    if (!item || item.state !== 'queued' || this.timers.has(uuid)) return;
    if (!auth.currentUser) { this.retryLater(uuid); return; }

    item.state = 'uploading';
    this.emitChange();
    try {
      // A prior attempt may have uploaded successfully without us seeing the result
      // (page reload, connection drop after PUT). Check for an existing verdict first.
      const existing = await getDoc(doc(db, 'results', uuid));
      if (existing.exists()) { this.settle(uuid, existing.data()); return; }

      const objectRef = ref(storage, `uploads/${auth.currentUser.uid}/${uuid}`);
      try {
        await uploadBytes(objectRef, this.blobs.get(uuid), {
          contentType: 'image/jpeg',
          customMetadata: { capturedAt: String(item.capturedAt) },
        });
      } catch (err) {
        // Write-once rule rejects re-PUT of an already-stored object: that means the
        // earlier attempt landed — fall through and wait for the finalize verdict.
        if (err?.code !== 'storage/unauthorized') throw err;
        const verdict = await getDoc(doc(db, 'results', uuid));
        if (!verdict.exists()) throw err; // genuinely unauthorized → retry/backoff
      }
      this.awaitResult(uuid);
    } catch (err) {
      item.state = 'queued';
      item.attemptCount += 1;
      if (this.dbHandle) {
        const blob = this.blobs.get(uuid);
        idb(this.dbHandle, 'readwrite', (s) => s.put({
          uuid, blob, capturedAt: item.capturedAt, attemptCount: item.attemptCount,
        })).catch(() => {});
      }
      this.retryLater(uuid);
      this.emitChange({ error: String(err?.code || err) });
    }
  }

  retryLater(uuid) {
    const item = this.items.get(uuid);
    if (!item) return;
    const backoff = Math.min(2000 * 2 ** item.attemptCount, MAX_BACKOFF_MS);
    const jitter = Math.random() * 1000;
    const t = setTimeout(() => { this.timers.delete(uuid); this.pump(uuid); }, backoff + jitter);
    this.timers.set(uuid, t);
  }

  awaitResult(uuid) {
    const item = this.items.get(uuid);
    if (!item) return;
    item.state = 'awaitingResult';
    this.emitChange();

    const resultRef = doc(db, 'results', uuid);
    const unsub = onSnapshot(resultRef, (snap) => {
      if (snap.exists()) this.settle(uuid, snap.data());
    }, () => { /* snapshot errors fall back to polling */ });
    this.watchers.set(uuid, unsub);

    // Poll fallback (CONTRACTS §6.4) in case realtime is blocked.
    const poll = setInterval(async () => {
      if (!this.items.has(uuid)) { clearInterval(poll); return; }
      const snap = await getDoc(resultRef).catch(() => null);
      if (snap?.exists()) { clearInterval(poll); this.settle(uuid, snap.data()); }
    }, 10_000);
    // Give up waiting after 2 minutes and retry the whole item (idempotent).
    setTimeout(() => {
      clearInterval(poll);
      const cur = this.items.get(uuid);
      if (cur && cur.state === 'awaitingResult') {
        const w = this.watchers.get(uuid);
        if (w) { w(); this.watchers.delete(uuid); }
        cur.state = 'queued';
        cur.attemptCount += 1;
        this.retryLater(uuid);
      }
    }, 120_000);
  }

  async settle(uuid, result) {
    const item = this.items.get(uuid);
    if (!item || item.state === 'confirmed') return;
    item.state = 'confirmed';
    await this.remove(uuid);
    if (result.ok) {
      this.emitChange({ confirmedDelta: 1 });
    } else {
      this.emitChange({ rejection: result.reason || 'invalid' });
    }
  }
}

export const queue = new UploadQueue();
