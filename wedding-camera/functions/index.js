/**
 * Cloud Functions — authoritative acceptance pipeline + gallery PIN + ZIP export.
 * Contracts: docs/CONTRACTS.md §5. Workstream ③ owns hardening + tests.
 */
const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { getAuth } = require('firebase-admin/auth');
const crypto = require('node:crypto');

initializeApp();
const db = getFirestore();

const UPLOAD_PATH = /^uploads\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** JPEG magic bytes: FF D8 FF */
function isJpeg(buf) {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** Minimal JPEG dimension parse (SOF0/1/2 markers); returns {width,height} or nulls. */
function jpegDimensions(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { width: null, height: null };
}

async function writeResult(uuid, deviceUid, ok, reason) {
  await db.doc(`results/${uuid}`).set({
    deviceUid: deviceUid || 'unknown',
    ok,
    reason: reason || null,
    at: Timestamp.now(),
  });
}

exports.onUploadFinalize = onObjectFinalized({ region: 'us-central1', memory: '512MiB' }, async (event) => {
  const filePath = event.data.name;
  const m = UPLOAD_PATH.exec(filePath);
  const bucket = getStorage().bucket(event.data.bucket);
  const file = bucket.file(filePath);

  // Anything outside the uploads/ contract that reaches here is ignored
  // (theme/ and exports/ objects also trigger this handler).
  if (!filePath.startsWith('uploads/')) return;
  if (!m) { await file.delete().catch(() => {}); return; }
  const [, uid, uuid] = m;

  // Fast idempotency check outside the transaction (duplicate storage events).
  const existing = await db.doc(`results/${uuid}`).get();
  if (existing.exists) return;

  // Content validation before touching quota.
  const size = Number(event.data.size || 0);
  let rejectReason = null;
  let dims = { width: null, height: null };
  if (size <= 0 || size > 8 * 1024 * 1024) {
    rejectReason = 'invalid';
  } else {
    const [head] = await file.download({ start: 0, end: 65535 }).catch(() => [null]);
    if (!head || !isJpeg(head)) rejectReason = 'invalid';
    else dims = jpegDimensions(head);
  }

  if (rejectReason) {
    await file.delete().catch(() => {});
    await writeResult(uuid, uid, false, rejectReason);
    return;
  }

  // Transactional acceptance: window/pause/cap/quota + atomic decrement.
  const outcome = await db.runTransaction(async (tx) => {
    const photoRef = db.doc(`photos/${uuid}`);
    const resultRef = db.doc(`results/${uuid}`);
    const [photoSnap, resultSnap, cfgSnap, privSnap, counterSnap, deviceSnap] = await Promise.all([
      tx.get(photoRef),
      tx.get(resultRef),
      tx.get(db.doc('config/event')),
      tx.get(db.doc('config/private')),
      tx.get(db.doc('counters/event')),
      tx.get(db.doc(`devices/${uid}`)),
    ]);

    if (photoSnap.exists || resultSnap.exists) return { ok: true, duplicate: true };
    if (!cfgSnap.exists || !deviceSnap.exists) return { ok: false, reason: 'invalid' };

    const cfg = cfgSnap.data();
    const priv = privSnap.exists ? privSnap.data() : {};
    const device = deviceSnap.data();
    const photoCount = counterSnap.exists ? counterSnap.data().photoCount : 0;
    const now = Timestamp.now();

    if (cfg.paused === true) return { ok: false, reason: 'paused' };
    if (cfg.startAt && now.toMillis() < cfg.startAt.toMillis()) return { ok: false, reason: 'window' };
    if (cfg.endAt && now.toMillis() > cfg.endAt.toMillis()) return { ok: false, reason: 'window' };
    if (priv.eventCap && photoCount >= priv.eventCap) return { ok: false, reason: 'cap' };
    if (!(device.snapsRemaining > 0)) return { ok: false, reason: 'quota' };

    tx.update(db.doc(`devices/${uid}`), { snapsRemaining: FieldValue.increment(-1) });
    tx.set(db.doc('counters/event'), { photoCount: FieldValue.increment(1) }, { merge: true });
    tx.set(photoRef, {
      deviceUid: uid,
      nickname: device.nickname || '',
      storagePath: filePath,
      byteSize: size,
      width: dims.width,
      height: dims.height,
      capturedAt: event.data.metadata && event.data.metadata.capturedAt
        ? Timestamp.fromMillis(Number(event.data.metadata.capturedAt) || now.toMillis())
        : now,
      receivedAt: now,
      status: 'visible',
      rotation: 0,
    });
    tx.set(resultRef, { deviceUid: uid, ok: true, reason: null, at: now });
    return { ok: true };
  });

  if (outcome.duplicate) return;
  if (!outcome.ok) {
    await file.delete().catch(() => {});
    await writeResult(uuid, uid, false, outcome.reason);
  }
});

exports.verifyGalleryPin = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const uid = request.auth.uid;
  const pin = String(request.data && request.data.pin || '');
  if (!/^\d{4,6}$/.test(pin)) return { ok: false };

  const attemptsRef = db.doc(`pinAttempts/${uid}`);
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX_FAILS = 5;

  const gate = await db.runTransaction(async (tx) => {
    const snap = await tx.get(attemptsRef);
    const now = Date.now();
    const data = snap.exists ? snap.data() : { count: 0, windowStart: now };
    const windowStart = data.windowStart && data.windowStart.toMillis
      ? data.windowStart.toMillis() : (data.windowStart || now);
    const inWindow = now - windowStart < WINDOW_MS;
    const count = inWindow ? data.count : 0;
    if (inWindow && count >= MAX_FAILS) {
      return { blocked: true, retryAfterSec: Math.ceil((windowStart + WINDOW_MS - now) / 1000) };
    }
    tx.set(attemptsRef, {
      count: count + 1,
      windowStart: inWindow ? Timestamp.fromMillis(windowStart) : Timestamp.fromMillis(now),
    });
    return { blocked: false };
  });
  if (gate.blocked) return { ok: false, retryAfterSec: gate.retryAfterSec };

  const [cfgSnap, privSnap] = await Promise.all([
    db.doc('config/event').get(),
    db.doc('config/private').get(),
  ]);
  if (!cfgSnap.exists || !privSnap.exists) return { ok: false };
  if (cfgSnap.data().galleryReleased !== true) return { ok: false };

  const { galleryPinHash, galleryPinSalt } = privSnap.data();
  const hash = crypto.createHash('sha256').update(String(galleryPinSalt) + pin).digest('hex');
  if (hash !== galleryPinHash) return { ok: false };

  const auth = getAuth();
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, { ...(user.customClaims || {}), gallery: true });
  await attemptsRef.delete().catch(() => {});
  return { ok: true };
});

exports.exportZip = onCall(
  { region: 'us-central1', memory: '1GiB', timeoutSeconds: 540 },
  async (request) => {
    if (!request.auth || request.auth.token.admin !== true) {
      throw new HttpsError('permission-denied', 'Admin only.');
    }
    const includeHidden = request.data && request.data.includeHidden === true;
    const archiver = require('archiver');

    let query = db.collection('photos');
    if (!includeHidden) query = query.where('status', '==', 'visible');
    const photos = await query.get();

    const bucket = getStorage().bucket();
    const exportId = crypto.randomUUID();
    const zipFile = bucket.file(`exports/${exportId}.zip`);
    const zipStream = zipFile.createWriteStream({ contentType: 'application/zip' });
    const archive = archiver('zip', { zlib: { level: 0 } }); // JPEGs don't recompress
    const done = new Promise((resolve, reject) => {
      zipStream.on('finish', resolve);
      zipStream.on('error', reject);
      archive.on('error', reject);
    });
    archive.pipe(zipStream);

    const seen = new Set();
    for (const doc of photos.docs) {
      const p = doc.data();
      const when = (p.capturedAt || p.receivedAt).toDate();
      const stamp = when.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const nick = String(p.nickname || 'guest').replace(/[^\w\- ]/g, '').slice(0, 20) || 'guest';
      let name = `${stamp}_${nick}_${doc.id.slice(0, 8)}.jpg`;
      if (seen.has(name)) name = `${stamp}_${nick}_${doc.id}.jpg`;
      seen.add(name);
      archive.append(bucket.file(p.storagePath).createReadStream(), { name });
    }
    await archive.finalize();
    await done;

    const [url] = await zipFile.getSignedUrl({
      action: 'read',
      expires: Date.now() + 24 * 60 * 60 * 1000,
    });
    await db.collection('audit').add({
      action: 'export',
      target: exportId,
      actorUid: request.auth.uid,
      at: Timestamp.now(),
    });
    return { url, count: photos.size };
  }
);
