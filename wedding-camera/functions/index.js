/**
 * Cloud Functions — authoritative acceptance pipeline + gallery PIN + ZIP export.
 * Contracts: docs/CONTRACTS.md §5. Workstream ③ owns hardening + tests.
 *
 * Trust model: the client controls only (a) the object path it writes to (rules-gated
 * to `uploads/{own uid}/{uuid}`), (b) the bytes, and (c) the `capturedAt` custom
 * metadata. Everything that costs a snap or grants access is decided here.
 */
const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { getAuth } = require('firebase-admin/auth');
const crypto = require('node:crypto');

initializeApp();
const db = getFirestore();

/**
 * Deployment region for every function. The storage trigger MUST run in the same
 * region as the Storage bucket (Google rejects cross-region storage triggers), so this
 * must equal the bucket's location chosen in the Firebase console. The client mirrors
 * it via VITE_FB_FUNCTIONS_REGION / FUNCTIONS_REGION in app/src/lib/firebase.js.
 */
const REGION = 'asia-southeast1';

const MAX_BYTES = 8 * 1024 * 1024;
/** Config timestamps may be mistyped in the console; never crash on them. */
const isTs = (v) => !!v && typeof v.toMillis === 'function';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UPLOAD_PATH = new RegExp(`^uploads/([^/]+)/(${UUID})$`);
/** Last-ditch uuid recovery from a malformed path, so the client still gets a result. */
const TRAILING_UUID = new RegExp(`(${UUID})$`);
/** A client-claimed capture time older than this (or in the future) is not believed. */
const CAPTURED_AT_SLACK_MS = 48 * 60 * 60 * 1000;
const HEAD_BYTES = 64 * 1024;
const EXTENDED_HEAD_BYTES = 1024 * 1024;
/**
 * Grace period after `config/event.endAt` during which an upload from an ALREADY
 * EXISTING device is still accepted (CONTRACTS §5, PRD GUEST-004/UPLOAD-007).
 *
 * Joining and uploading are deliberately split: `firestore.rules` refuses to create a
 * new `devices/{uid}` doc outside `[startAt, endAt]` (that is where the leaked-QR abuse
 * control now lives), so a device that exists at all was admitted while the event was
 * open. A phone that lost signal at the reception and only reconnects days later must
 * still be able to deliver its queued film — destroying those objects is the single
 * worst failure this system can have. Deliberately a code constant, not a config field:
 * no deployment/runbook change, nothing for an admin to mis-set under pressure.
 */
const UPLOAD_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Reconciliation only considers objects at least this old, so it never races the
 * storage trigger for a photo that has simply not been processed yet.
 */
const RECONCILE_MIN_AGE_MS = 5 * 60 * 1000;
/** Marker on errors thrown to make the Eventarc/Storage trigger retry (see §5). */
const DEFERRED_TAG = 'upload-deferred';

/** JPEG magic bytes: FF D8 FF */
function isJpeg(buf) {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** SOF markers carry the frame dimensions; C4/C8/CC are DHT/JPG/DAC, not SOF. */
function isSofMarker(m) {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

/**
 * Minimal JPEG dimension parse (any SOFn marker); returns {width,height}, or nulls when
 * the header is truncated/unparseable. Null dimensions are acceptable per CONTRACTS §2 —
 * they must never block acceptance of an otherwise valid photo.
 */
function jpegDimensions(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    // Standalone markers (no length field): padding FF, TEM, RSTn, SOI, EOI.
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    if (isSofMarker(marker)) {
      if (i + 9 >= buf.length) break;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      if (width > 0 && height > 0) return { width, height };
      break;
    }
    // Scan data starts here — dimensions would have appeared before it.
    if (marker === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) break;
    i += 2 + len;
  }
  return { width: null, height: null };
}

/** Downloads a byte range, returning null instead of throwing. */
async function readHead(file, end) {
  const [buf] = await file.download({ start: 0, end }).catch((err) => {
    logger.warn('head download failed', { name: file.name, err: String(err) });
    return [null];
  });
  return buf;
}

async function writeResult(uuid, deviceUid, ok, reason) {
  await db.doc(`results/${uuid}`).set({
    deviceUid: deviceUid || 'unknown',
    ok,
    reason: reason || null,
    at: Timestamp.now(),
  });
}

/** Clamp a client-claimed capture time into a believable window ending at `now`. */
function resolveCapturedAt(metadata, now) {
  const raw = metadata && metadata.capturedAt;
  const claimed = Number(raw);
  if (!raw || !Number.isFinite(claimed) || claimed <= 0) return now;
  const nowMs = now.toMillis();
  const clamped = Math.min(Math.max(claimed, nowMs - CAPTURED_AT_SLACK_MS), nowMs);
  return Timestamp.fromMillis(clamped);
}

function projectId() {
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
  if (process.env.GCP_PROJECT) return process.env.GCP_PROJECT;
  try {
    return JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId || null;
  } catch {
    return null;
  }
}

/**
 * Emulator-only guard. In production this trigger is scoped to the project's default
 * bucket, but the shared Storage emulator fans every bucket's events out to us —
 * including the throwaway buckets the rules suites use. Acting on those would delete
 * another suite's fixtures (and look for its device docs in the wrong project).
 */
function isForeignBucket(bucket) {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') return false;
  const pid = projectId();
  if (!pid || !bucket) return false;
  // Own buckets: `<project>.appspot.com`, `<project>.firebasestorage.app`, and the bare
  // `<project>` that @firebase/rules-unit-testing uses for its default bucket.
  return bucket !== pid && !bucket.startsWith(`${pid}.`);
}

/** A deferral is NOT a failure: the bytes stay in the bucket and we try again later. */
function deferredError(uuid, reason) {
  const err = new Error(`upload deferred (${reason}) for ${uuid}`);
  err[DEFERRED_TAG] = true;
  err.deferReason = reason;
  return err;
}

/**
 * The authoritative acceptance pipeline, shared by the storage trigger and by
 * reconciliation (CONTRACTS §5). Never throws for an expected outcome; resolves to
 *
 *   { status: 'ignored' }                     not an uploads/ object
 *   { status: 'duplicate', uuid }             already has a verdict
 *   { status: 'accepted', uuid, uid }         photo + result written, snap consumed
 *   { status: 'rejected', uuid, uid, reason } object deleted, results{ok:false} written
 *   { status: 'deferred', uuid, uid, reason } NOTHING written, object RETAINED
 *
 * A 'deferred' outcome is the pause path (GAP 1): the object is left untouched and no
 * results doc is written, so the client keeps waiting instead of losing the photo. The
 * caller decides how to retry — the trigger throws (Eventarc redelivers with backoff),
 * reconciliation simply picks the object up on a later sweep.
 */
async function processUpload({ bucketName, filePath, size, metadata }) {
  // Anything outside the uploads/ contract is ignored
  // (theme/ and exports/ objects also trigger the storage handler).
  if (!filePath || !filePath.startsWith('uploads/')) return { status: 'ignored' };

  const bucket = getStorage().bucket(bucketName);
  const file = bucket.file(filePath);
  const m = UPLOAD_PATH.exec(filePath);

  // CONTRACTS §5.1: malformed path → delete the object, and still report 'invalid'
  // when a uuid can be recovered, so the client stops waiting on results/{uuid}.
  if (!m) {
    await file.delete().catch(() => {});
    const recovered = TRAILING_UUID.exec(filePath);
    if (recovered) {
      const uuid = recovered[1];
      const [photoSnap, resultSnap] = await Promise.all([
        db.doc(`photos/${uuid}`).get(),
        db.doc(`results/${uuid}`).get(),
      ]);
      if (!photoSnap.exists && !resultSnap.exists) {
        const segs = filePath.split('/');
        await writeResult(uuid, segs.length > 2 ? segs[1] : 'unknown', false, 'invalid');
      }
    }
    logger.warn('rejected malformed upload path', { filePath });
    return { status: 'rejected', uuid: null, uid: null, reason: 'invalid' };
  }
  const [, uid, uuid] = m;

  // Fast idempotency check outside the transaction (duplicate storage events,
  // and reconciliation racing the trigger for the same object).
  const existing = await db.doc(`results/${uuid}`).get();
  if (existing.exists) return { status: 'duplicate', uuid, uid };

  // Content validation before touching quota.
  let rejectReason = null;
  let dims = { width: null, height: null };
  const byteSize = Number(size || 0);
  if (!Number.isFinite(byteSize) || byteSize <= 0 || byteSize > MAX_BYTES) {
    rejectReason = 'invalid';
  } else {
    const head = await readHead(file, HEAD_BYTES - 1);
    if (!head || !isJpeg(head)) {
      rejectReason = 'invalid';
    } else {
      dims = jpegDimensions(head);
      // Big EXIF-free JPEGs put SOF early, but be forgiving of odd encoders: one
      // wider read, then give up and store nulls rather than reject a valid photo.
      if (dims.width === null && byteSize > head.length) {
        const more = await readHead(file, Math.min(byteSize, EXTENDED_HEAD_BYTES) - 1);
        if (more) dims = jpegDimensions(more);
      }
    }
  }

  if (rejectReason) {
    await file.delete().catch(() => {});
    await writeResult(uuid, uid, false, rejectReason);
    logger.info('upload rejected', { uuid, uid, reason: rejectReason, size: byteSize });
    return { status: 'rejected', uuid, uid, reason: rejectReason };
  }

  // Transactional acceptance: window/pause/cap/quota + atomic decrement.
  const outcome = await db.runTransaction(async (tx) => {
    const photoRef = db.doc(`photos/${uuid}`);
    const resultRef = db.doc(`results/${uuid}`);
    const deviceRef = db.doc(`devices/${uid}`);
    const [photoSnap, resultSnap, cfgSnap, privSnap, counterSnap, deviceSnap] = await Promise.all([
      tx.get(photoRef),
      tx.get(resultRef),
      tx.get(db.doc('config/event')),
      tx.get(db.doc('config/private')),
      tx.get(db.doc('counters/event')),
      tx.get(deviceRef),
    ]);

    if (photoSnap.exists || resultSnap.exists) return { ok: true, duplicate: true };
    if (!cfgSnap.exists) return { ok: false, reason: 'invalid' };

    const cfg = cfgSnap.data();
    const priv = privSnap.exists ? privSnap.data() : {};
    const photoCount = counterSnap.exists ? Number(counterSnap.data().photoCount) || 0 : 0;
    const now = Timestamp.now();

    // Order per CONTRACTS §5.4: window → paused → cap → device → quota.
    //
    // Before startAt is still a hard reject: `firestore.rules` cannot have admitted a
    // device yet, so nothing legitimate can be in flight.
    if (isTs(cfg.startAt) && now.toMillis() < cfg.startAt.toMillis()) return { ok: false, reason: 'window' };
    // After endAt the device is already admitted — its film is real, it is just late.
    // Accept until endAt + UPLOAD_GRACE_MS; only past that is deleting the bytes
    // defensible (the event is long over and the object store is being wound down).
    if (isTs(cfg.endAt) && now.toMillis() > cfg.endAt.toMillis() + UPLOAD_GRACE_MS) {
      return { ok: false, reason: 'window' };
    }
    // GAP 1: pause DEFERS, it never rejects. No results doc, no delete — the client
    // keeps waiting and the object is re-processed after the admin resumes.
    if (cfg.paused === true) return { ok: false, defer: true, reason: 'paused' };
    if (priv.eventCap && photoCount >= priv.eventCap) return { ok: false, reason: 'cap' };
    if (!deviceSnap.exists) return { ok: false, reason: 'invalid' };

    const device = deviceSnap.data();
    if (!(Number(device.snapsRemaining) > 0)) return { ok: false, reason: 'quota' };

    tx.update(deviceRef, { snapsRemaining: FieldValue.increment(-1) });
    tx.set(db.doc('counters/event'), { photoCount: FieldValue.increment(1) }, { merge: true });
    tx.set(photoRef, {
      deviceUid: uid,
      nickname: typeof device.nickname === 'string' ? device.nickname.slice(0, 30) : '',
      storagePath: filePath,
      byteSize,
      width: dims.width,
      height: dims.height,
      capturedAt: resolveCapturedAt(metadata, now),
      receivedAt: now,
      status: 'visible',
      rotation: 0,
    });
    tx.set(resultRef, { deviceUid: uid, ok: true, reason: null, at: now });
    return { ok: true };
  });

  if (outcome.duplicate) return { status: 'duplicate', uuid, uid };
  if (outcome.defer) {
    // Nothing was written and nothing was deleted: the photo is safe in the bucket.
    logger.info('upload deferred', { uuid, uid, reason: outcome.reason, size: byteSize });
    return { status: 'deferred', uuid, uid, reason: outcome.reason };
  }
  if (!outcome.ok) {
    await file.delete().catch(() => {});
    await writeResult(uuid, uid, false, outcome.reason);
    logger.info('upload rejected', { uuid, uid, reason: outcome.reason, size: byteSize });
    return { status: 'rejected', uuid, uid, reason: outcome.reason };
  }
  logger.info('upload accepted', { uuid, uid, size: byteSize, width: dims.width, height: dims.height });
  return { status: 'accepted', uuid, uid };
}

/**
 * Storage trigger. `retry: true` is what turns a deferral into a real retry in
 * production: Eventarc redelivers the finalize event with exponential backoff (up to
 * 24h) whenever the handler throws. Retries are bounded and the emulator does not retry
 * at all, so `reconcileUploads` below is the durable safety net, not an optimisation.
 */
exports.onUploadFinalize = onObjectFinalized(
  { region: REGION, memory: '512MiB', retry: true },
  async (event) => {
    if (isForeignBucket(event.data.bucket)) {
      logger.debug('ignoring foreign emulator bucket', { bucket: event.data.bucket });
      return;
    }
    const outcome = await processUpload({
      bucketName: event.data.bucket,
      filePath: event.data.name,
      size: event.data.size,
      metadata: event.data.metadata,
    });
    // Throwing is the ONLY way to ask Eventarc to redeliver. Safe to throw: a deferral
    // wrote nothing, so the retry re-runs the whole pipeline from scratch.
    if (outcome && outcome.status === 'deferred') {
      throw deferredError(outcome.uuid, outcome.reason);
    }
  }
);

/**
 * GAP 3 — reconciliation sweep. Walks stored upload objects and re-runs the pipeline
 * for any that still have no verdict: a finalize crash, a retry budget that ran out, or
 * an object deferred while the event was paused. Idempotent by construction — the
 * results/{uuid} check inside processUpload (and again inside its transaction) means a
 * sweep racing the trigger can only ever produce one photo and one decrement.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.minAgeMs]  ignore objects younger than this (default 5 min),
 *                                   so we never race the trigger on a fresh upload.
 * @param {string}  [opts.prefix]    restrict the sweep to a sub-path of `uploads/`.
 */
async function sweepUploads({ minAgeMs = RECONCILE_MIN_AGE_MS, prefix = 'uploads/' } = {}) {
  const bucket = getStorage().bucket();
  const cutoff = Date.now() - Math.max(0, Number(minAgeMs) || 0);
  const [files] = await bucket.getFiles({ prefix });
  const stats = { scanned: 0, accepted: 0, rejected: 0, deferred: 0 };

  // Age filter first, so a settled bucket costs listing only.
  const candidates = files.filter((file) => {
    if (!file.name || !file.name.startsWith('uploads/')) return false;
    const meta = file.metadata || {};
    const created = Date.parse(meta.timeCreated || meta.updated || '');
    // Too fresh: the storage trigger is probably still working on it.
    return !(Number.isFinite(created) && created > cutoff);
  });

  // Most objects in a healthy bucket are already settled. Weed them out with batched
  // getAll reads (a few round trips) instead of one sequential read per object — the
  // scheduled sweep has to finish inside its timeout even with a full event's photos.
  const BATCH = 300;
  const unsettled = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH);
    const parsed = slice.map((file) => UPLOAD_PATH.exec(file.name));
    const refs = parsed.filter(Boolean).map((p) => db.doc(`results/${p[2]}`));
    const snaps = refs.length ? await db.getAll(...refs) : [];
    let seen = 0;
    slice.forEach((file, idx) => {
      // A malformed path has no uuid to look up — hand it straight to the pipeline,
      // which deletes it and reports 'invalid' exactly as the trigger would.
      if (!parsed[idx]) { unsettled.push(file); return; }
      const snap = snaps[seen];
      seen += 1;
      if (!snap.exists) unsettled.push(file);
    });
  }

  for (const file of unsettled) {
    const meta = file.metadata || {};
    stats.scanned += 1;
    try {
      const outcome = await processUpload({
        bucketName: bucket.name,
        filePath: file.name,
        size: meta.size,
        metadata: meta.metadata,
      });
      if (outcome.status === 'accepted') stats.accepted += 1;
      else if (outcome.status === 'rejected') stats.rejected += 1;
      else if (outcome.status === 'deferred') stats.deferred += 1;
    } catch (err) {
      // One poisoned object must never stop the sweep: the rest of the film matters.
      logger.error('reconcile failed for object', { filePath: file.name, err: String(err) });
    }
  }
  logger.info('reconcile sweep complete', { ...stats, prefix, total: files.length });
  return stats;
}

/**
 * Scheduled safety net (CONTRACTS §5). Every 15 minutes, anything stranded for more
 * than 5 minutes gets another run through the pipeline. Deferred (paused) objects are
 * simply deferred again until the admin resumes, then accepted.
 */
exports.reconcileUploads = onSchedule(
  { region: REGION, schedule: 'every 15 minutes', memory: '512MiB', timeoutSeconds: 540 },
  async () => { await sweepUploads(); }
);

/**
 * Admin-triggered version of the same sweep — the emergency "send everything now"
 * button, and the only way tests can exercise reconciliation (the emulator never fires
 * schedules). `minAgeMs` / `prefix` are call-scoped knobs, NOT configuration: they let
 * an admin (or a test) target a sweep without touching `config/event`.
 */
exports.reconcileNow = onCall(
  { region: REGION, memory: '512MiB', timeoutSeconds: 540 },
  async (request) => {
    if (!request.auth || request.auth.token.admin !== true) {
      throw new HttpsError('permission-denied', 'Admin only.');
    }
    const data = request.data && typeof request.data === 'object' ? request.data : {};
    const minAgeMs = Number.isFinite(Number(data.minAgeMs))
      ? Math.max(0, Number(data.minAgeMs)) : RECONCILE_MIN_AGE_MS;
    const prefix = typeof data.prefix === 'string' && data.prefix.startsWith('uploads/')
      ? data.prefix : 'uploads/';
    const stats = await sweepUploads({ minAgeMs, prefix });
    logger.info('reconcileNow', { actorUid: request.auth.uid, ...stats });
    return stats;
  }
);

const PIN_WINDOW_MS = 15 * 60 * 1000;
const PIN_MAX_FAILS = 5;

/** Constant-time hex-digest comparison. */
function digestEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

exports.verifyGalleryPin = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const uid = request.auth.uid;

  // Input hardening: only a 4–6 digit *string* is even considered. Non-strings,
  // objects/arrays and oversized payloads are refused without touching Firestore,
  // so garbage input can neither cost a lookup nor consume an attempt.
  const raw = request.data && typeof request.data === 'object' ? request.data.pin : undefined;
  const pin = typeof raw === 'string' ? raw.trim() : '';
  if (pin.length > 6 || !/^\d{4,6}$/.test(pin)) return { ok: false };

  const [cfgSnap, privSnap] = await Promise.all([
    db.doc('config/event').get(),
    db.doc('config/private').get(),
  ]);
  if (!cfgSnap.exists || !privSnap.exists) return { ok: false };
  // Gate on release BEFORE spending an attempt: while the gallery is locked every
  // answer is `{ok:false}` regardless of the pin, so there is nothing to brute force
  // and no reason to burn a legitimate viewer's 5 tries (GALLERY-001).
  if (cfgSnap.data().galleryReleased !== true) return { ok: false };

  const attemptsRef = db.doc(`pinAttempts/${uid}`);
  const gate = await db.runTransaction(async (tx) => {
    const snap = await tx.get(attemptsRef);
    const now = Date.now();
    const data = snap.exists ? snap.data() : { count: 0, windowStart: now };
    const windowStart = data.windowStart && data.windowStart.toMillis
      ? data.windowStart.toMillis() : (Number(data.windowStart) || now);
    const inWindow = now - windowStart < PIN_WINDOW_MS;
    const count = inWindow ? Number(data.count) || 0 : 0;
    if (inWindow && count >= PIN_MAX_FAILS) {
      return { blocked: true, retryAfterSec: Math.ceil((windowStart + PIN_WINDOW_MS - now) / 1000) };
    }
    // Reserve the attempt up front: a crash between here and the claim write counts
    // as a failure rather than a free guess.
    tx.set(attemptsRef, {
      count: count + 1,
      windowStart: Timestamp.fromMillis(inWindow ? windowStart : now),
    });
    return { blocked: false };
  });
  if (gate.blocked) {
    logger.warn('gallery pin rate limited', { uid, retryAfterSec: gate.retryAfterSec });
    return { ok: false, retryAfterSec: gate.retryAfterSec };
  }

  const { galleryPinHash, galleryPinSalt } = privSnap.data();
  if (typeof galleryPinHash !== 'string' || typeof galleryPinSalt !== 'string') {
    logger.error('gallery pin misconfigured: missing hash/salt');
    return { ok: false };
  }
  const hash = crypto.createHash('sha256').update(galleryPinSalt + pin).digest('hex');
  if (!digestEquals(hash, galleryPinHash)) return { ok: false };

  const auth = getAuth();
  try {
    const user = await auth.getUser(uid);
    await auth.setCustomUserClaims(uid, { ...(user.customClaims || {}), gallery: true });
  } catch (err) {
    logger.error('failed to set gallery claim', { uid, err: String(err) });
    throw new HttpsError('internal', 'Could not unlock the gallery. Please try again.');
  }
  // Success clears the rate-limit counter (PRD GALLERY-002: 5 *fails* per 15 min).
  await attemptsRef.delete().catch(() => {});
  logger.info('gallery unlocked', { uid });
  return { ok: true };
});

/**
 * Signed URL for a finished export. The Storage emulator has no signing credentials,
 * so we fall back to the emulator's media endpoint (see report: emulator-only path);
 * production always returns a real 24h V4 signed URL.
 */
async function exportUrl(bucket, file) {
  try {
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 24 * 60 * 60 * 1000,
    });
    return { url, signed: true };
  } catch (err) {
    const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.STORAGE_EMULATOR_HOST;
    logger.warn('getSignedUrl unavailable, falling back', { err: String(err), emulator: !!host });
    if (host) {
      const base = host.startsWith('http') ? host : `http://${host}`;
      return {
        url: `${base}/v0/b/${bucket.name}/o/${encodeURIComponent(file.name)}?alt=media`,
        signed: false,
      };
    }
    throw new HttpsError('internal', 'Could not create a download link for the export.');
  }
}

/** Filename stem for ZIP downloads: the couple's names, ASCII-safe, e.g. "Xin-Xin-and-Jia-Yi". */
async function zipBaseName() {
  const snap = await db.doc('config/event').get().catch(() => null);
  const names = snap && snap.exists ? String(snap.data().coupleNames || '') : '';
  const stem = names.replace(/&/g, ' and ').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (stem || 'wedding').slice(0, 60);
}

/**
 * Shared ZIP builder for both export callables. Streams every supplied `photos` doc's
 * original object into `exports/{exportId}.zip` and resolves once the object is closed.
 *
 * @param {Array}  photoDocs  Firestore QueryDocumentSnapshots of `photos/{uuid}`.
 * @param {string} exportId   uuid naming the output object.
 * @returns {Promise<{zipFile: object, count: number, missing: string[]}>}
 */
async function buildZipFromPhotos(photoDocs, exportId, downloadName = 'photos.zip') {
  const archiver = require('archiver');
  const bucket = getStorage().bucket();
  const zipFile = bucket.file(`exports/${exportId}.zip`);
  // Content-Disposition rides along on the signed URL, so the browser saves a
  // human-readable name instead of the random export id.
  const zipStream = zipFile.createWriteStream({
    contentType: 'application/zip',
    metadata: { contentDisposition: `attachment; filename="${downloadName}"` },
  });
  const archive = archiver('zip', { zlib: { level: 0 } }); // JPEGs don't recompress
  const done = new Promise((resolve, reject) => {
    zipStream.on('finish', resolve);
    zipStream.on('error', reject);
    archive.on('error', reject);
  });
  // A single vanished object must not sink the whole export (ADMIN-006).
  archive.on('warning', (err) => logger.warn('archive warning', { err: String(err) }));
  archive.pipe(zipStream);

  // Existence is probed in parallel batches first: a photos doc whose object has
  // vanished would otherwise error the archive stream and sink the whole export.
  const missing = [];
  const entries = [];
  const BATCH = 25;
  for (let i = 0; i < photoDocs.length; i += BATCH) {
    const slice = photoDocs.slice(i, i + BATCH);
    const checked = await Promise.all(slice.map(async (doc) => {
      const p = doc.data();
      if (!p.storagePath || typeof p.storagePath !== 'string') return null;
      const source = bucket.file(p.storagePath);
      const [exists] = await source.exists().catch(() => [false]);
      return exists ? { doc, p, source } : null;
    }));
    checked.forEach((e, idx) => (e ? entries.push(e) : missing.push(slice[idx].id)));
  }

  const seen = new Set();
  let count = 0;
  for (const { doc, p, source } of entries) {
    const when = (p.capturedAt || p.receivedAt || Timestamp.now()).toDate();
    const stamp = when.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const nick = String(p.nickname || 'guest').replace(/[^\w\- ]/g, '').slice(0, 20).trim() || 'guest';
    let name = `${stamp}_${nick}_${doc.id.slice(0, 8)}.jpg`;
    for (let n = 2; seen.has(name); n += 1) {
      name = `${stamp}_${nick}_${doc.id.slice(0, 8)}-${n}.jpg`;
    }
    seen.add(name);
    archive.append(source.createReadStream(), { name });
    count += 1;
  }
  await archive.finalize();
  await done;

  if (missing.length) logger.warn('export skipped photos with no object', { missing });
  return { zipFile, count, missing };
}

exports.exportZip = onCall(
  { region: REGION, memory: '1GiB', timeoutSeconds: 540 },
  async (request) => {
    if (!request.auth || request.auth.token.admin !== true) {
      throw new HttpsError('permission-denied', 'Admin only.');
    }
    const includeHidden = !!(request.data && request.data.includeHidden === true);

    // No orderBy: a status+orderBy query would need a composite index, and the ZIP
    // entry names already carry the timestamp (ADMIN-006).
    let query = db.collection('photos');
    if (!includeHidden) query = query.where('status', '==', 'visible');
    const photos = await query.get();

    const bucket = getStorage().bucket();
    const exportId = crypto.randomUUID();
    const { zipFile, count } = await buildZipFromPhotos(
      photos.docs, exportId, `${await zipBaseName()}-${includeHidden ? 'all' : 'visible'}.zip`);

    const { url, signed } = await exportUrl(bucket, zipFile);
    await db.collection('audit').add({
      action: 'export',
      target: exportId,
      actorUid: request.auth.uid,
      at: Timestamp.now(),
    });
    logger.info('export complete', { exportId, count, includeHidden, signed });
    return { url, count };
  }
);

/**
 * Gallery "Download all pictures" (CONTRACTS §5).
 *
 * Guests who unlocked the PIN get the SAME archive, not one build each: dozens of
 * people tapping the button at once would otherwise re-stream the whole event's film
 * dozens of times. `config/galleryExport` therefore caches one build server-side,
 * keyed by a signature over the visible photo ids, and the signed URL is re-minted per
 * caller (signing is cheap, so no URL is ever persisted). A per-uid hourly cap bounds
 * what one caller can make us rebuild when the signature legitimately changes.
 *
 * Hidden photos are never included and there is no includeHidden switch — a gallery
 * viewer must not be able to reach a photo the couple moderated away.
 */
const GALLERY_EXPORT_DOC = 'config/galleryExport';
/** A cached archive is reused for this long; shorter than the 24h signed-URL life. */
const GALLERY_EXPORT_TTL_MS = 20 * 60 * 60 * 1000;
/** Fresh (non-cached) builds one uid may trigger per window. Cache hits are free. */
const GALLERY_EXPORT_MAX_BUILDS = 3;
const GALLERY_EXPORT_WINDOW_MS = 60 * 60 * 1000;
/**
 * Build lock. Without it a cold cache is a thundering herd: the couple posts the link,
 * fifty phones tap "Download all" inside a minute and every one of them re-streams the
 * whole event. One caller claims the lock and builds; the rest poll and are handed the
 * same archive. Long enough to cover a big event's build, short enough that a crashed
 * builder does not wedge the button for the evening.
 */
const GALLERY_EXPORT_LOCK_MS = 8 * 60 * 1000;
const GALLERY_EXPORT_POLL_MS = 3 * 1000;
/**
 * A superseded archive younger than this is left in the bucket: a guest may be halfway
 * through downloading it on a URL that is still valid for hours. Stale objects are
 * cheap and the shutdown checklist (README) wipes the bucket wholesale anyway.
 */
const GALLERY_EXPORT_KEEP_MS = 60 * 60 * 1000;

/** sha256 over the sorted visible photo uuids — changes whenever the set changes. */
function galleryExportSignature(photoDocs) {
  const ids = photoDocs.map((d) => d.id).sort();
  return crypto.createHash('sha256').update(ids.join(',')).digest('hex');
}

exports.exportGalleryZip = onCall(
  { region: REGION, memory: '1GiB', timeoutSeconds: 540 },
  async (request) => {
    const token = (request.auth && request.auth.token) || {};
    if (!request.auth || !(token.gallery === true || token.admin === true)) {
      throw new HttpsError('permission-denied', 'Gallery access required.');
    }
    const uid = request.auth.uid;

    // The claim alone is not enough: a viewer who unlocked before the couple re-locked
    // the gallery must not keep a working download button.
    const cfgSnap = await db.doc('config/event').get();
    if (!cfgSnap.exists || cfgSnap.data().galleryReleased !== true) {
      throw new HttpsError('failed-precondition', 'The gallery is not open yet.');
    }

    // Visible only — never hidden, and no caller-supplied switch that could change it.
    const photos = await db.collection('photos').where('status', '==', 'visible').get();
    const signature = galleryExportSignature(photos.docs);

    const bucket = getStorage().bucket();
    const cacheRef = db.doc(GALLERY_EXPORT_DOC);

    /**
     * Serve the cached archive iff it is finished, matches this signature, is young
     * enough and its object is still there. Returns null when a build is needed.
     */
    async function serveCache(doc) {
      if (!doc || doc.building === true) return null;
      if (doc.signature !== signature || typeof doc.path !== 'string') return null;
      if (!isTs(doc.createdAt) || Date.now() - doc.createdAt.toMillis() >= GALLERY_EXPORT_TTL_MS) return null;
      const file = bucket.file(doc.path);
      const [stillThere] = await file.exists().catch(() => [false]);
      if (!stillThere) {
        logger.warn('cached gallery export object vanished, rebuilding', { path: doc.path });
        return null;
      }
      const { url, signed } = await exportUrl(bucket, file);
      return { url, count: Number(doc.count) || 0, signed, path: doc.path };
    }

    const cached = await cacheRef.get().catch(() => null);
    const cache = cached && cached.exists ? cached.data() : null;
    const hit = await serveCache(cache);
    if (hit) {
      logger.info('gallery export served from cache', {
        uid, path: hit.path, count: hit.count, signed: hit.signed,
      });
      return { url: hit.url, count: hit.count };
    }

    // Claim the build lock, or wait for whoever holds it. Waiting costs no rate-limit
    // attempt: a guest who merely arrived second has not asked us to do any work.
    const waitUntil = Date.now() + GALLERY_EXPORT_LOCK_MS;
    for (;;) {
      const claim = await db.runTransaction(async (tx) => {
        const snap = await tx.get(cacheRef);
        const d = snap.exists ? snap.data() : {};
        const since = isTs(d.buildingSince) ? d.buildingSince.toMillis() : 0;
        const held = d.building === true
          && d.buildingSignature === signature
          && Date.now() - since < GALLERY_EXPORT_LOCK_MS;
        if (held && Date.now() < waitUntil) return { wait: true };
        // merge: the previous archive's path/count/createdAt stay readable, so anyone
        // whose signature still matches it keeps getting a cache hit mid-rebuild.
        tx.set(cacheRef, {
          building: true,
          buildingSince: Timestamp.now(),
          buildingSignature: signature,
        }, { merge: true });
        return { wait: false };
      });
      if (!claim.wait) break;

      await new Promise((r) => setTimeout(r, GALLERY_EXPORT_POLL_MS));
      const snap = await cacheRef.get().catch(() => null);
      const ready = await serveCache(snap && snap.exists ? snap.data() : null);
      if (ready) {
        logger.info('gallery export served from a concurrent build', {
          uid, path: ready.path, count: ready.count, signed: ready.signed,
        });
        return { url: ready.url, count: ready.count };
      }
    }

    let built = false;
    try {
      // Only a FRESH build costs an attempt — cache hits and waiters returned above.
      const gate = await db.runTransaction(async (tx) => {
        const ref = db.doc(`galleryExportAttempts/${uid}`);
        const snap = await tx.get(ref);
        const now = Date.now();
        const data = snap.exists ? snap.data() : {};
        const windowStart = isTs(data.windowStart) ? data.windowStart.toMillis() : 0;
        const inWindow = now - windowStart < GALLERY_EXPORT_WINDOW_MS;
        const count = inWindow ? Number(data.count) || 0 : 0;
        if (inWindow && count >= GALLERY_EXPORT_MAX_BUILDS) return { blocked: true };
        tx.set(ref, {
          count: count + 1,
          windowStart: Timestamp.fromMillis(inWindow ? windowStart : now),
        });
        return { blocked: false };
      });
      if (gate.blocked) {
        logger.warn('gallery export rate limited', { uid });
        throw new HttpsError('resource-exhausted', 'Please wait a little before downloading again.');
      }

      const exportId = crypto.randomUUID();
      const { zipFile, count } = await buildZipFromPhotos(
        photos.docs, exportId, `${await zipBaseName()}-album.zip`);
      const { url, signed } = await exportUrl(bucket, zipFile);

      // Full overwrite (no merge): this also clears the lock fields.
      await cacheRef.set({
        signature,
        path: zipFile.name,
        count,
        createdAt: Timestamp.now(),
        building: false,
      });
      built = true;

      // Best effort, and never for a recent archive — someone may be mid-download on it.
      const previousPath = cache && typeof cache.path === 'string' ? cache.path : null;
      const previousAge = cache && isTs(cache.createdAt)
        ? Date.now() - cache.createdAt.toMillis() : Infinity;
      if (previousPath && previousPath !== zipFile.name && previousAge >= GALLERY_EXPORT_KEEP_MS) {
        await bucket.file(previousPath).delete()
          .catch((err) => logger.warn('could not delete superseded gallery export',
            { path: previousPath, err: String(err) }));
      }

      await db.collection('audit').add({
        action: 'gallery-export',
        target: exportId,
        actorUid: uid,
        at: Timestamp.now(),
      });
      logger.info('gallery export complete', { exportId, count, uid, signed });
      return { url, count };
    } finally {
      // A crash (or a rate-limit refusal after claiming) must not hold the lock for the
      // full 8 minutes — the next caller should be free to try immediately.
      if (!built) {
        await cacheRef.set({ building: false }, { merge: true })
          .catch((err) => logger.warn('could not release gallery export lock', { err: String(err) }));
      }
    }
  }
);
