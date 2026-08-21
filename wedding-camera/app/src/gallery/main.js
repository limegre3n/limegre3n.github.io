/**
 * Gallery app — workstream ④.
 * Implements PRD GALLERY-001..004 against docs/CONTRACTS.md §2, §4 (gallery claim), §5.
 *
 * Hard rules honoured here:
 *  - all rendered text via textContent (never innerHTML) — XSS guard, CONTRACTS §9
 *  - theming only through lib/theme.js (no admin-entered HTML/JS, PRD D19)
 *  - noindex meta stays in the HTML (GALLERY-004)
 */
import { auth, db, storage, functions } from '../lib/firebase.js';
import { onAuthStateChanged, signInAnonymously } from 'firebase/auth';
import { collection, doc, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { applyTheme } from '../lib/theme.js';

const app = document.getElementById('app');
const views = new Map(
  [...document.querySelectorAll('[data-view]')].map((el) => [el.dataset.view, el]),
);
const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text); // textContent only
  return node;
}

function setState(name) {
  app.dataset.state = name;
  for (const [key, node] of views) node.hidden = key !== name;
}

function toast(message, kind = '') {
  const node = el('div', `toast ${kind}`.trim(), message);
  $('toasts').appendChild(node);
  setTimeout(() => node.remove(), kind === 'bad' ? 6000 : 3500);
}

/* ── slug (CONTRACTS §1: /gallery/{eventSlug}/) ───────────────────── */
function slugFromLocation() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const at = parts.indexOf('gallery');
  const fromPath = at >= 0 ? parts[at + 1] : undefined;
  if (fromPath && fromPath !== 'index.html') return decodeURIComponent(fromPath);
  // Dev convenience: the vite dev server has no /gallery/** rewrite.
  return new URLSearchParams(window.location.search).get('slug') || '';
}
const slug = slugFromLocation();

/* ── formatting ───────────────────────────────────────────────────── */
function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate();
  return ts instanceof Date ? ts : null;
}
function fmtWhen(ts) {
  const d = toDate(ts);
  if (!d) return '';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
function fileStamp(ts) {
  const d = toDate(ts) || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
function safeName(text, fallback) {
  const cleaned = String(text || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 24);
  return cleaned || fallback;
}

/* ── auth (CONTRACTS §4: anonymous auth for gallery viewers) ──────── */
function ensureUser() {
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      unsub();
      if (user) { resolve(user); return; }
      try {
        const cred = await signInAnonymously(auth);
        resolve(cred.user);
      } catch (error) { reject(error); }
    }, reject);
  });
}

/** Remembered unlock: the gallery claim rides along with the anonymous session. */
async function hasGalleryClaim(forceRefresh = false) {
  try {
    const user = auth.currentUser;
    if (!user) return false;
    const token = await user.getIdTokenResult(forceRefresh);
    return token.claims && token.claims.gallery === true;
  } catch (error) {
    console.error('claim check failed', error);
    return false;
  }
}

/* ── state ────────────────────────────────────────────────────────── */
let config = null;
let unlocked = false;
let wallUnsub = null;
let photos = [];
const urlCache = new Map();   // storagePath → Promise<string>
const shots = new Map();      // uuid → { root, img, frame, caption, requested }
let observer = null;

function photoUrl(path) {
  if (!urlCache.has(path)) {
    urlCache.set(path, getDownloadURL(storageRef(storage, path)).catch((error) => {
      urlCache.delete(path);
      throw error;
    }));
  }
  return urlCache.get(path);
}

/* ── photo wall (GALLERY-002 attribution / GALLERY-003 detail) ─────── */
function ensureObserver() {
  if (observer || typeof IntersectionObserver !== 'function') return;
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      loadShot(entry.target.dataset.uuid);
    }
  }, { rootMargin: '400px 0px' });
}

function loadShot(uuid) {
  const shot = shots.get(uuid);
  const data = photos.find((p) => p.uuid === uuid);
  if (!shot || !data || shot.requested || !data.storagePath) return;
  shot.requested = true;
  photoUrl(data.storagePath).then((url) => {
    shot.img.src = url;
    shot.img.hidden = false;
    shot.frame.firstChild.textContent = '';
  }).catch((error) => {
    console.error('photo failed to load', uuid, error);
    shot.requested = false;
    shot.frame.firstChild.textContent = 'unavailable';
  });
}

function buildShot(uuid) {
  const root = el('button', 'shot');
  root.type = 'button';
  root.dataset.uuid = uuid;

  const frame = el('div', 'shot-frame', '…');
  const img = el('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.hidden = true;
  frame.appendChild(img);

  const caption = el('span', 'shot-by');
  root.append(frame, caption);
  root.addEventListener('click', () => openDetail(uuid));

  const shot = { root, img, frame, caption, requested: false };
  shots.set(uuid, shot);
  return shot;
}

function renderWall() {
  const wall = $('wall');
  ensureObserver();

  $('wall-empty').hidden = photos.length > 0;
  $('wall-count').textContent = photos.length
    ? `${photos.length} photo${photos.length === 1 ? '' : 's'}`
    : '';

  const seen = new Set();
  for (const data of photos) {
    seen.add(data.uuid);
    const shot = shots.get(data.uuid) || buildShot(data.uuid);
    const by = data.nickname ? `by ${data.nickname}` : 'by a guest';
    shot.caption.textContent = by;
    shot.root.setAttribute('aria-label', `Photo ${by}. Tap to view and save.`);
    wall.appendChild(shot.root);
    if (observer) observer.observe(shot.root);
    else loadShot(data.uuid);
  }
  for (const [uuid, shot] of shots) {
    if (!seen.has(uuid)) { shot.root.remove(); shots.delete(uuid); }
  }
}

function startWall() {
  if (wallUnsub) return;
  // GALLERY-002: only approved photos, oldest → newest (the roll in order).
  // Rules require the status filter for the list to be allowed (firestore.rules /photos).
  const q = query(
    collection(db, 'photos'),
    where('status', '==', 'visible'),
    orderBy('receivedAt', 'asc'),
  );
  wallUnsub = onSnapshot(q, (snap) => {
    photos = snap.docs.map((d) => ({ uuid: d.id, ...d.data() }));
    renderWall();
  }, (error) => {
    console.error('photo feed failed', error);
    toast('Could not load the photos. Pull to refresh and try again.', 'bad');
  });
}

function stopWall() {
  if (wallUnsub) { wallUnsub(); wallUnsub = null; }
  photos = [];
  shots.clear();
  if (observer) { observer.disconnect(); observer = null; }
  $('wall').textContent = '';
}

/* ── detail overlay + download (GALLERY-003) ──────────────────────── */
let detailUuid = null;
let objectUrl = null;

function openDetail(uuid) {
  const data = photos.find((p) => p.uuid === uuid);
  if (!data) return;
  detailUuid = uuid;
  const img = $('lightbox-img');
  img.removeAttribute('src');
  $('lightbox-error').hidden = true;
  const by = data.nickname ? `by ${data.nickname}` : 'by a guest';
  const when = fmtWhen(data.capturedAt || data.receivedAt);
  $('lightbox-caption').textContent = when ? `${by} · ${when}` : by;
  img.alt = `Photo ${by}`;
  $('lightbox').hidden = false;
  document.body.style.overflow = 'hidden'; // keep the wall from scrolling behind
  photoUrl(data.storagePath).then((url) => {
    if (detailUuid === uuid) img.src = url;
  }).catch((error) => {
    console.error('detail load failed', error);
    $('lightbox-error').textContent = 'That photo could not be opened.';
    $('lightbox-error').hidden = false;
  });
}

function closeDetail() {
  detailUuid = null;
  $('lightbox').hidden = true;
  document.body.style.overflow = '';
  $('lightbox-img').removeAttribute('src');
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
}

$('lightbox-close').addEventListener('click', closeDetail);
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeDetail(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('lightbox').hidden) closeDetail();
});

$('lightbox-download').addEventListener('click', async () => {
  const data = photos.find((p) => p.uuid === detailUuid);
  if (!data) return;
  const btn = $('lightbox-download');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const url = await photoUrl(data.storagePath);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`http ${res.status}`);
    const blob = await res.blob();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    const couple = safeName(config && config.coupleNames, 'wedding');
    const nick = safeName(data.nickname, 'guest');
    const link = el('a');
    link.href = objectUrl;
    link.download = `${couple}-${fileStamp(data.capturedAt || data.receivedAt)}-${nick}.jpg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (error) {
    console.error('download failed', error);
    $('lightbox-error').textContent = 'Download failed. Check your connection and try again.';
    $('lightbox-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save photo';
  }
});

/* ── PIN entry (GALLERY-002) ──────────────────────────────────────── */
$('pin-input').addEventListener('input', (e) => {
  const cleaned = e.target.value.replace(/\D+/g, '').slice(0, 6);
  if (cleaned !== e.target.value) e.target.value = cleaned;
});

function pinError(message) {
  const node = $('pin-error');
  node.textContent = message;
  node.hidden = false;
  const input = $('pin-input');
  input.classList.remove('shake');
  void input.offsetWidth; // restart the animation
  input.classList.add('shake');
}

function fmtRetry(seconds) {
  const total = Math.max(1, Math.ceil(Number(seconds) || 0));
  if (total < 60) return `${total} second${total === 1 ? '' : 's'}`;
  const mins = Math.ceil(total / 60);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

$('pin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('pin-input');
  const pin = input.value.replace(/\D+/g, '');
  $('pin-error').hidden = true;
  if (pin.length < 4 || pin.length > 6) {
    pinError('The PIN is 4 to 6 digits.');
    return;
  }
  const submit = $('pin-submit');
  submit.disabled = true;
  submit.textContent = 'Checking…';
  try {
    const call = httpsCallable(functions, 'verifyGalleryPin');
    const res = await call({ pin });
    const data = (res && res.data) || {};
    if (data.ok === true) {
      // CONTRACTS §4: the claim only lands in a freshly minted token.
      await auth.currentUser.getIdToken(true);
      unlocked = true;
      input.value = '';
      openGallery();
      return;
    }
    if (data.retryAfterSec) {
      pinError(`Too many tries. Try again in ${fmtRetry(data.retryAfterSec)}.`);
    } else {
      pinError('That PIN does not match. Have another go.');
    }
  } catch (error) {
    console.error('pin check failed', error);
    pinError('Could not check the PIN. Check your connection and try again.');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Open the gallery';
  }
});

/* ── routing between states ───────────────────────────────────────── */
function openGallery() {
  setState('wall');
  startWall();
}

function evaluate() {
  if (!config) {
    setState('invalid');
    return;
  }
  applyTheme(config); // CONTRACTS §9

  if (!slug || config.slug !== slug) {
    stopWall();
    setState('invalid');
    return;
  }
  if (config.galleryReleased !== true) {
    // GALLERY-001 — locked "still developing" page.
    stopWall();
    closeDetail();
    setState('locked');
    return;
  }
  if (unlocked) {
    if (app.dataset.state !== 'wall') openGallery();
    return;
  }
  setState('pin');
  const input = $('pin-input');
  if (input && !input.value) setTimeout(() => input.focus({ preventScroll: true }), 50);
}

/* ── boot ─────────────────────────────────────────────────────────── */
async function boot() {
  setState('loading');
  try {
    await ensureUser();
  } catch (error) {
    console.error('anonymous sign-in failed', error);
    $('loading-note').textContent = 'Could not reach the gallery. Check your connection and reload.';
    return;
  }

  unlocked = await hasGalleryClaim(); // remembered unlock, per browser

  onSnapshot(doc(db, 'config', 'event'), (snap) => {
    config = snap.exists() ? snap.data() : null;
    evaluate();
  }, (error) => {
    console.error('config feed failed', error);
    $('loading-note').textContent = 'Could not load this gallery. Please reload.';
    setState('loading');
  });
}

boot();
