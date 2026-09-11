/**
 * Persistent upload queue (workstream ② — contract: docs/CONTRACTS.md §6).
 * Every capture lands in IndexedDB BEFORE any upload attempt (UPLOAD-001).
 * States per item: queued → uploading → awaitingResult → confirmed | rejected.
 *
 * Public API consumed by workstream ① (CONTRACTS §11):
 *   queue.init()                        → Promise (idempotent; safe to call repeatedly)
 *   queue.enqueue(blob, capturedAt)     → Promise<uuid>
 *   queue.pendingCount                  → number of not-yet-settled items
 *   queue.persistent                    → true = IndexedDB-backed, false = memory-only
 *   queue.addEventListener('change', …) / queue.on('change', …) → unsubscribe fn
 *   'change' detail: { pending, confirmedDelta?, rejection?, error? }
 */
import { ref, uploadBytes } from 'firebase/storage';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { storage, db, auth } from '../lib/firebase.js';

const DB_NAME = 'wedding-camera';
const STORE = 'queue';
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const AUTH_WAIT_MS = 1_000;
const RESULT_POLL_MS = 10_000;
const RESULT_GIVE_UP_MS = 120_000;
/** Item states that mean "no longer pending"; settling is one-way. */
const TERMINAL = new Set(['confirmed', 'rejected', 'dropped']);

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
    req.onblocked = () => reject(new Error('indexeddb-blocked'));
  });
}

function idb(dbHandle, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = dbHandle.transaction(STORE, mode);
    } catch (err) { reject(err); return; }
    let out;
    try {
      out = fn(tx.objectStore(STORE));
    } catch (err) { reject(err); return; }
    tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('idb-abort'));
  });
}

function isUsableBlob(blob) {
  return !!blob && typeof blob.size === 'number' && blob.size > 0
    && typeof blob.arrayBuffer === 'function';
}

class UploadQueue extends EventTarget {
  constructor() {
    super();
    this.items = new Map();    // uuid -> {uuid, capturedAt, attemptCount, state}
    this.blobs = new Map();    // uuid -> Blob (mirror of the persisted record)
    this.timers = new Map();   // uuid -> retry setTimeout id
    this.watchers = new Map(); // uuid -> onSnapshot unsubscribe
    this.polls = new Map();    // uuid -> result-poll setInterval id
    this.giveUps = new Map();  // uuid -> give-up setTimeout id
    this.dbHandle = null;
    /** null = not probed yet, true = IndexedDB-backed, false = memory-only (ephemeral). */
    this.persistent = null;
    /** Raw best-effort signal from navigator.storage.persist() — diagnostics only. */
    this.storagePersisted = null;
    this.initPromise = null;
    this.listenersBound = false;
    this.wrapped = new WeakMap(); // handler -> Map(type -> wrapped listener), for on()/off()
  }

  get pendingCount() {
    return [...this.items.values()].filter((i) => !TERMINAL.has(i.state)).length;
  }

  /**
   * Convenience subscribe used by workstream ① (CONTRACTS §11):
   * `queue.on('change', ({pending, confirmedDelta, rejection}) => …)`.
   * Returns an unsubscribe function. `addEventListener` keeps working unchanged.
   */
  on(type, handler, options) {
    const wrapped = (event) => handler(event.detail ?? {}, event);
    let byType = this.wrapped.get(handler);
    if (!byType) { byType = new Map(); this.wrapped.set(handler, byType); }
    byType.set(type, wrapped);
    this.addEventListener(type, wrapped, options);
    return () => this.removeEventListener(type, wrapped, options);
  }

  off(type, handler, options) {
    const wrapped = this.wrapped.get(handler)?.get(type);
    this.removeEventListener(type, wrapped || handler, options);
  }

  emitChange(extra = {}) {
    this.dispatchEvent(new CustomEvent('change', {
      detail: { pending: this.pendingCount, ...extra },
    }));
  }

  /** Idempotent: repeated calls (or ① re-entering a state) reuse the first boot. */
  init() {
    if (!this.initPromise) this.initPromise = this.#boot();
    return this.initPromise;
  }

  async #boot() {
    try {
      this.dbHandle = await openDb();
      this.persistent = true;
      // Best-effort durability hint. A `false` here is NORMAL in plain browsing
      // (no user engagement yet) and must never be read as "private mode".
      if (navigator.storage?.persist) {
        this.storagePersisted = await navigator.storage.persist().catch(() => null);
      }
      await this.#restore();
    } catch (err) {
      // IndexedDB unavailable (lockdown mode / blocked storage): memory-only queue.
      // Photos then only survive while the page stays open (UPLOAD-006 notice).
      this.dbHandle = null;
      this.persistent = false;
      console.warn('[queue] IndexedDB unavailable, running memory-only:', err?.message || err);
    }
    this.#bindGlobalListeners();
    this.emitChange();
    if (this.items.size) this.pumpAll(true);
    return this;
  }

  async #restore() {
    const all = await idb(this.dbHandle, 'readonly', (s) => s.getAll()) || [];
    for (const rec of all) {
      if (!rec || typeof rec.uuid !== 'string') continue;
      // Blob loss edge: a record whose payload did not survive is unrecoverable —
      // drop it quietly rather than retrying an undefined body forever.
      if (!isUsableBlob(rec.blob)) {
        console.warn('[queue] dropping persisted item with unreadable blob', rec.uuid);
        await idb(this.dbHandle, 'readwrite', (s) => s.delete(rec.uuid)).catch(() => {});
        continue;
      }
      this.items.set(rec.uuid, {
        uuid: rec.uuid,
        capturedAt: rec.capturedAt || Date.now(),
        attemptCount: Number(rec.attemptCount) || 0,
        // Survives the reload so a write-once refusal after a restart is still read as
        // "already stored, waiting for a verdict" rather than as an upload failure.
        uploaded: rec.uploaded === true,
        // In-flight states never survive a reload: resume as 'queued'. Re-upload is
        // safe because pump() checks results/{uuid} first and Storage is write-once.
        state: 'queued',
      });
      this.blobs.set(rec.uuid, rec.blob);
    }
  }

  #bindGlobalListeners() {
    if (this.listenersBound) return;
    this.listenersBound = true;
    // UPLOAD-002: `online` triggers an immediate retry (skips pending backoff).
    globalThis.addEventListener?.('online', () => this.pumpAll(true));
    // UPLOAD-005: warn when leaving with a non-empty queue.
    globalThis.addEventListener?.('beforeunload', (e) => {
      if (this.pendingCount > 0) { e.preventDefault(); e.returnValue = ''; }
    });
    // Anonymous sign-in may complete after boot; pump as soon as we have a uid.
    auth.onAuthStateChanged?.((user) => { if (user) this.pumpAll(true); });
  }

  async enqueue(blob, capturedAt = Date.now()) {
    if (!isUsableBlob(blob)) throw new TypeError('enqueue requires a non-empty Blob');
    const uuid = crypto.randomUUID();
    this.items.set(uuid, { uuid, capturedAt, attemptCount: 0, uploaded: false, state: 'queued' });
    this.blobs.set(uuid, blob);
    // UPLOAD-001: persisted before any network attempt.
    await this.#persist(uuid);
    this.emitChange();
    this.pump(uuid);
    return uuid;
  }

  /** Writes the full record (blob + metadata) for `uuid`. Never throws. */
  async #persist(uuid) {
    if (!this.dbHandle) return;
    const item = this.items.get(uuid);
    const blob = this.blobs.get(uuid);
    if (!item || !isUsableBlob(blob)) return;
    await idb(this.dbHandle, 'readwrite', (s) => s.put({
      uuid,
      blob,
      capturedAt: item.capturedAt,
      attemptCount: item.attemptCount,
      uploaded: item.uploaded === true,
      // Persisted resume state is always 'queued' (see #restore).
      state: 'queued',
    })).catch((err) => {
      console.warn('[queue] persist failed for', uuid, err?.name || err);
    });
  }

  #clearWatchers(uuid) {
    const unsub = this.watchers.get(uuid);
    if (unsub) { this.watchers.delete(uuid); try { unsub(); } catch { /* noop */ } }
    const poll = this.polls.get(uuid);
    if (poll !== undefined) { clearInterval(poll); this.polls.delete(uuid); }
    const giveUp = this.giveUps.get(uuid);
    if (giveUp !== undefined) { clearTimeout(giveUp); this.giveUps.delete(uuid); }
  }

  #clearTimer(uuid) {
    const t = this.timers.get(uuid);
    if (t !== undefined) { clearTimeout(t); this.timers.delete(uuid); }
  }

  /** Forgets an item entirely (memory + IndexedDB + all pending timers/watchers). */
  async remove(uuid) {
    this.items.delete(uuid);
    this.blobs.delete(uuid);
    this.#clearTimer(uuid);
    this.#clearWatchers(uuid);
    if (this.dbHandle) {
      await idb(this.dbHandle, 'readwrite', (s) => s.delete(uuid)).catch(() => {});
    }
  }

  pumpAll(immediate = false) {
    for (const item of [...this.items.values()]) {
      if (item.state !== 'queued') continue;
      if (immediate) this.#clearTimer(item.uuid);
      this.pump(item.uuid);
    }
  }

  async pump(uuid) {
    const item = this.items.get(uuid);
    if (!item || item.state !== 'queued' || this.timers.has(uuid)) return;
    if (!auth.currentUser) { this.retryLater(uuid, AUTH_WAIT_MS); return; }

    const blob = this.blobs.get(uuid);
    if (!isUsableBlob(blob)) { await this.#drop(uuid, 'blob-lost'); return; }

    item.state = 'uploading';
    this.emitChange();
    try {
      // A prior attempt may have uploaded successfully without us seeing the result
      // (page reload, connection drop after PUT). Check for an existing verdict first.
      const existing = await getDoc(doc(db, 'results', uuid));
      if (existing.exists()) { await this.settle(uuid, existing.data()); return; }

      const objectRef = ref(storage, `uploads/${auth.currentUser.uid}/${uuid}`);
      try {
        await uploadBytes(objectRef, blob, {
          contentType: 'image/jpeg',
          customMetadata: { capturedAt: String(item.capturedAt) },
        });
      } catch (err) {
        // Write-once rule rejects re-PUT of an already-stored object: that means the
        // earlier attempt landed — fall through and wait for the finalize verdict.
        if (err?.code !== 'storage/unauthorized') throw err;
        const verdict = await getDoc(doc(db, 'results', uuid));
        if (verdict.exists()) { await this.settle(uuid, verdict.data()); return; }
        // No verdict YET, and we know from `uploaded` that our own PUT already landed:
        // this is a re-PUT of bytes that are safely in the bucket. The server DEFERS
        // (never rejects) uploads made while the event is paused — it writes no result
        // and keeps the object — so a verdict can legitimately be a long way off. Go
        // back to watching instead of counting this as a failure: an item is never
        // given up on without a verdict. awaitResult() re-emits 'change' so the UI
        // keeps showing "N sending…", and its give-up timer re-pumps us later.
        if (item.uploaded) { this.awaitResult(uuid); return; }
        throw err; // genuinely unauthorized (never stored by us) → retry/backoff
      }
      // The bytes are in the bucket now; remember it so a later re-PUT refusal is read
      // as "waiting for a verdict" rather than as an error (see the catch above).
      item.uploaded = true;
      await this.#persist(uuid);
      this.awaitResult(uuid);
    } catch (err) {
      await this.#failAttempt(uuid, err);
    }
  }

  /** Failed attempt → back to 'queued' with persisted attemptCount + backoff. */
  async #failAttempt(uuid, err, code) {
    const item = this.items.get(uuid);
    if (!item || TERMINAL.has(item.state)) return;
    this.#clearWatchers(uuid);
    item.state = 'queued';
    item.attemptCount += 1;
    await this.#persist(uuid);
    this.retryLater(uuid);
    this.emitChange({ error: code || String(err?.code || err?.message || err) });
  }

  /** Unrecoverable local failure (lost blob): give up without consuming a snap. */
  async #drop(uuid, reason) {
    const item = this.items.get(uuid);
    if (!item) return;
    item.state = 'dropped';
    await this.remove(uuid);
    this.emitChange({ error: reason });
  }

  /** UPLOAD-002: min(2^attempt * 2s, 60s) + jitter. */
  retryLater(uuid, fixedDelayMs) {
    const item = this.items.get(uuid);
    if (!item || TERMINAL.has(item.state)) return;
    this.#clearTimer(uuid);
    const backoff = fixedDelayMs !== undefined
      ? fixedDelayMs
      : Math.min(BASE_BACKOFF_MS * 2 ** item.attemptCount, MAX_BACKOFF_MS);
    const jitter = Math.random() * 1000;
    const t = setTimeout(() => {
      this.timers.delete(uuid);
      this.pump(uuid);
    }, backoff + jitter);
    this.timers.set(uuid, t);
  }

  /** CONTRACTS §6.4: realtime verdict + 10s poll fallback + bounded give-up. */
  awaitResult(uuid) {
    const item = this.items.get(uuid);
    if (!item || TERMINAL.has(item.state)) return;
    this.#clearWatchers(uuid); // never stack two watcher sets on one uuid
    item.state = 'awaitingResult';
    this.emitChange();

    const resultRef = doc(db, 'results', uuid);
    const unsub = onSnapshot(resultRef, (snap) => {
      if (snap.exists()) this.settle(uuid, snap.data());
    }, () => { /* snapshot errors fall back to polling */ });
    this.watchers.set(uuid, unsub);

    const poll = setInterval(async () => {
      const cur = this.items.get(uuid);
      if (!cur || cur.state !== 'awaitingResult') { this.#clearWatchers(uuid); return; }
      const snap = await getDoc(resultRef).catch(() => null);
      if (snap?.exists()) this.settle(uuid, snap.data());
    }, RESULT_POLL_MS);
    this.polls.set(uuid, poll);

    // Give up waiting after 2 minutes and retry the whole item (idempotent server-side).
    const giveUp = setTimeout(() => {
      this.giveUps.delete(uuid);
      const cur = this.items.get(uuid);
      if (!cur || cur.state !== 'awaitingResult') { this.#clearWatchers(uuid); return; }
      this.#failAttempt(uuid, null, 'result-timeout');
    }, RESULT_GIVE_UP_MS);
    this.giveUps.set(uuid, giveUp);
  }

  /**
   * Applies a server verdict. Idempotent: onSnapshot, the 10s poll and the
   * reload/pre-upload getDoc can all deliver the same result — the synchronous
   * terminal-state check before any await makes duplicate calls no-ops.
   */
  async settle(uuid, result) {
    const item = this.items.get(uuid);
    if (!item || TERMINAL.has(item.state)) return;
    const ok = result?.ok === true;
    item.state = ok ? 'confirmed' : 'rejected';
    this.#clearWatchers(uuid);
    this.#clearTimer(uuid);
    await this.remove(uuid);
    // UPLOAD-004: a rejection never consumes a snap; ① restores the optimistic counter.
    if (ok) this.emitChange({ confirmedDelta: 1 });
    else this.emitChange({ rejection: result?.reason || 'invalid' });
  }
}

export const queue = new UploadQueue();
