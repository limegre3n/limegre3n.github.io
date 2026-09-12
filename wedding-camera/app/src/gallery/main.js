/**
 * Gallery app — workstream ④.
 * Implements PRD GALLERY-001..006 against docs/CONTRACTS.md §2, §4 (gallery claim), §5.
 *
 * Hard rules honoured here:
 *  - all rendered text via textContent (never innerHTML) — XSS guard, CONTRACTS §9
 *  - theming only through lib/theme.js (no admin-entered HTML/JS, PRD D19)
 *  - noindex meta stays in the HTML (GALLERY-004)
 *
 * The album is a light "paper" surface (see gallery.css). The couple's accent can
 * be any hex, so every place it carries text gets a derived, contrast-checked ink.
 */
import { auth, db, storage, functions } from '../lib/firebase.js';
import { onAuthStateChanged, signInAnonymously } from 'firebase/auth';
import { collection, doc, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { zip } from 'fflate';
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

/* ── contrast-safe accent derivatives ─────────────────────────────── */
/* The palette is couple-chosen (CONTRACTS §9) and may land anywhere in the
 * gamut, so derive every ink that sits on or near the accent. */

const PAPER_RGB = [0xf6, 0xf4, 0xf1];
const COVER_RGB = [0x1a, 0x16, 0x13];

function parseColor(value) {
  const v = String(value || '').trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
    if (h.length >= 6) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mix(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}

function css(rgb) {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/** Nudge `colour` toward black/white until it clears `ratio` against `bg`. */
function ensureContrast(colour, bg, ratio) {
  const target = luminance(bg) > 0.4 ? [0, 0, 0] : [255, 255, 255];
  let out = colour;
  for (let i = 0; i <= 12 && contrast(out, bg) < ratio; i += 1) {
    out = mix(colour, target, i / 12);
  }
  return out;
}

function refreshInkTokens() {
  try {
    const root = document.documentElement;
    const accent = parseColor(getComputedStyle(root).getPropertyValue('--c-accent'))
      || [0xe8, 0xb0, 0x4b];
    // Filled controls (primary button, Save): pick the better ink, then — only if
    // that ink still misses AA, which happens for mid-tone accents — nudge the fill
    // itself away from the ink until the label clears 4.5:1.
    const inkDark = [0x14, 0x11, 0x0d];
    const inkLight = [255, 255, 255];
    const useDark = contrast(accent, inkDark) >= contrast(accent, inkLight);
    const ink = useDark ? inkDark : inkLight;
    const away = useDark ? inkLight : [0, 0, 0];
    let fill = accent;
    for (let i = 0; i <= 12 && contrast(fill, ink) < 4.5; i += 1) fill = mix(accent, away, i / 12);
    root.style.setProperty('--on-accent', css(ink));
    root.style.setProperty('--accent-fill', css(fill));
    // Accent used as small text on paper (eyebrow) and on the dark cover (monogram).
    root.style.setProperty('--accent-strong', css(ensureContrast(accent, PAPER_RGB, 4.5)));
    root.style.setProperty('--accent-lift', css(ensureContrast(accent, COVER_RGB, 4.5)));
    root.style.setProperty('--accent-fade', `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, 0.3)`);
    // Cover plate: always a deep tint of the accent, so white cover type stays AA.
    root.style.setProperty('--cover-a', css(mix(accent, [0x26, 0x20, 0x1b], 0.7)));
    root.style.setProperty('--cover-b', css(mix(accent, [0x0b, 0x0a, 0x09], 0.93)));
  } catch { /* styling only — never block the gallery */ }
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
function photoCountLabel(n) {
  return `${n} photo${n === 1 ? '' : 's'}`;
}
function byLine(data) {
  return data && data.nickname ? `by ${data.nickname}` : 'by a guest';
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
const shots = new Map();      // uuid → { root, img, frame, meta, requested }
let observer = null;
let themeHeroDone = false;
let wallHeroPath = null;

/* GALLERY-006 — selection lives only for as long as the tab is open. */
const selected = new Set();   // uuid
let selecting = false;
let selectionBusy = false;
let packing = false;          // GALLERY-005 server-side ZIP in flight

/* A screenful of tiles would otherwise fire ~20 signed reads at once. Cap the
 * in-flight lookups: the roll still fills top-down, and neither the phone nor
 * the rules layer gets a burst it has to queue anyway. */
const MAX_INFLIGHT = 4;
let inflight = 0;
const waitingForSlot = [];

function schedule(task, front = false) {
  return new Promise((resolve, reject) => {
    const run = () => {
      inflight += 1;
      task().then(resolve, reject).finally(() => {
        inflight -= 1;
        const next = waitingForSlot.shift();
        if (next) next();
      });
    };
    if (inflight < MAX_INFLIGHT) run();
    else if (front) waitingForSlot.unshift(run); // the open lightbox goes first
    else waitingForSlot.push(run);
  });
}

function photoUrl(path, front = false) {
  if (!urlCache.has(path)) {
    urlCache.set(path, schedule(() => getDownloadURL(storageRef(storage, path)), front).catch((error) => {
      urlCache.delete(path);
      throw error;
    }));
  }
  return urlCache.get(path);
}

/* ── album cover art ──────────────────────────────────────────────── */
/** Theme hero (if the couple set one) wins on every cover; otherwise the wall
 *  cover borrows the first frame of the roll, blurred behind the scrim. */
function applyThemeHero() {
  const path = config && config.theme && config.theme.heroImagePath;
  if (!path || themeHeroDone) return;
  themeHeroDone = true;
  photoUrl(path).then((url) => {
    document.querySelectorAll('[data-cover-img], #wall-hero-img').forEach((img) => {
      img.src = url;
      img.hidden = false;
      img.classList.remove('is-blurred');
    });
  }).catch((error) => {
    themeHeroDone = false;
    console.warn('hero image unavailable', error);
  });
}

function applyWallHero() {
  if (config && config.theme && config.theme.heroImagePath) return; // theme hero wins
  const first = photos[0];
  if (!first || !first.storagePath || wallHeroPath === first.storagePath) return;
  wallHeroPath = first.storagePath;
  photoUrl(first.storagePath).then((url) => {
    const img = $('wall-hero-img');
    img.src = url;
    img.classList.add('is-blurred');
    img.hidden = false;
  }).catch(() => { wallHeroPath = null; });
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

function failShot(shot) {
  shot.frame.classList.remove('is-loaded');
  shot.frame.classList.add('is-failed');
  if (!shot.fallback) {
    const tpl = $('tpl-shot-fallback');
    shot.fallback = tpl.content.firstElementChild.cloneNode(true);
    shot.frame.appendChild(shot.fallback);
  }
}

/** A tile never shimmers forever: after SLOW_MS it settles on the soft icon,
 *  and still swaps in the photo if the request lands later. */
const SLOW_MS = 20_000;

function loadShot(uuid) {
  const shot = shots.get(uuid);
  const data = photos.find((p) => p.uuid === uuid);
  if (!shot || !data || shot.requested || !data.storagePath) return;
  shot.requested = true;
  const slow = setTimeout(() => failShot(shot), SLOW_MS);
  photoUrl(data.storagePath).then((url) => {
    shot.img.addEventListener('load', () => {
      clearTimeout(slow);
      shot.frame.classList.remove('is-failed');
      shot.frame.classList.add('is-loaded');
    }, { once: true });
    shot.img.addEventListener('error', () => { clearTimeout(slow); failShot(shot); }, { once: true });
    shot.img.src = url;
  }).catch((error) => {
    console.error('photo failed to load', uuid, error);
    clearTimeout(slow);
    failShot(shot); // a soft icon, never a raw error label
  });
}

function buildShot(uuid) {
  const root = el('button', 'shot');
  root.type = 'button';
  root.dataset.uuid = uuid;

  const frame = el('div', 'shot-frame');
  const img = el('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  frame.appendChild(img);

  // GALLERY-006: the badge ships with every tile but only paints in select mode.
  frame.appendChild($('tpl-shot-check').content.firstElementChild.cloneNode(true));

  const meta = el('span', 'shot-meta');
  root.append(frame, meta);
  root.addEventListener('click', () => {
    if (selecting) toggleSelection(uuid);
    else openDetail(uuid);
  });

  const shot = { root, img, frame, meta, requested: false, fallback: null };
  shots.set(uuid, shot);
  return shot;
}

function renderWall() {
  const wall = $('wall');
  ensureObserver();

  const count = photos.length;
  $('wall-empty').hidden = count > 0;
  $('wall-count').textContent = count ? photoCountLabel(count) : '';
  $('toolbar-count').textContent = count ? photoCountLabel(count) : 'No photos yet';
  $('wall-count').hidden = count === 0;

  const seen = new Set();
  for (const data of photos) {
    seen.add(data.uuid);
    const shot = shots.get(data.uuid) || buildShot(data.uuid);
    const by = byLine(data);
    const when = fmtWhen(data.capturedAt || data.receivedAt);
    shot.meta.textContent = when ? `${by} · ${when}` : by;
    syncShotSemantics(shot, data);
    if (data.width > 0 && data.height > 0) {
      shot.root.style.setProperty('--ar', `${data.width} / ${data.height}`);
    }
    wall.appendChild(shot.root);
    if (observer) observer.observe(shot.root);
    else loadShot(data.uuid);
  }
  for (const [uuid, shot] of shots) {
    if (!seen.has(uuid)) { shot.root.remove(); shots.delete(uuid); }
  }
  // A moderator hiding a frame mid-session must not leave it in the selection.
  for (const uuid of selected) if (!seen.has(uuid)) selected.delete(uuid);
  syncToolbarActions();
  renderSelection();

  applyWallHero();
  if (!$('lightbox').hidden) syncDetail();
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
  setSelectMode(false, false);
  hideReady();
  photos = [];
  shots.clear();
  wallHeroPath = null;
  if (observer) { observer.disconnect(); observer = null; }
  $('wall').textContent = '';
}

/* ── layout toggle (tight grid ⇄ single-column roll) ───────────────── */
const LAYOUT_KEY = 'gallery-layout';

function setLayout(layout, remember = true) {
  const next = layout === 'roll' ? 'roll' : 'grid';
  $('wall').dataset.layout = next;
  $('view-grid').setAttribute('aria-pressed', String(next === 'grid'));
  $('view-roll').setAttribute('aria-pressed', String(next === 'roll'));
  if (!remember) return;
  try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* private mode */ }
}

$('view-grid').addEventListener('click', () => setLayout('grid'));
$('view-roll').addEventListener('click', () => setLayout('roll'));
try { setLayout(localStorage.getItem(LAYOUT_KEY) || 'grid', false); } catch { /* ignore */ }

/* ── full-screen photo detail + download (GALLERY-003) ────────────── */
let detailUuid = null;
let lastFocused = null;

const lightbox = () => $('lightbox');

function detailIndex() {
  return photos.findIndex((p) => p.uuid === detailUuid);
}

/** Refreshes caption, counter and nav for the current frame (live feed safe). */
function syncDetail() {
  const index = detailIndex();
  if (index < 0) { closeDetail(); return; }
  const data = photos[index];
  const by = byLine(data);
  const when = fmtWhen(data.capturedAt || data.receivedAt);
  $('lightbox-by').textContent = by;
  $('lightbox-when').textContent = when;
  $('lightbox-counter').textContent = `${index + 1} / ${photos.length}`;
  $('lb-prev').disabled = index <= 0;
  $('lb-next').disabled = index >= photos.length - 1;
  $('lightbox-img').alt = `Photo ${by}`;
}

let detailSlow = null;

function detailFailed(message) {
  $('lb-spinner').hidden = true;
  $('lightbox-error').textContent = message;
  $('lightbox-error').hidden = false;
}

function showFrame(uuid) {
  const data = photos.find((p) => p.uuid === uuid);
  if (!data) return;
  detailUuid = uuid;
  const img = $('lightbox-img');
  img.classList.remove('is-loaded');
  img.removeAttribute('src');
  $('lb-spinner').hidden = false;
  $('lightbox-error').hidden = true;
  syncDetail();

  clearTimeout(detailSlow);
  detailSlow = setTimeout(() => {
    if (detailUuid === uuid) detailFailed('This photo is taking too long. Try again in a moment.');
  }, SLOW_MS);

  photoUrl(data.storagePath, true).then((url) => {
    if (detailUuid !== uuid) return;
    img.addEventListener('load', () => {
      if (detailUuid !== uuid) return;
      clearTimeout(detailSlow);
      img.classList.add('is-loaded');
      $('lb-spinner').hidden = true;
      $('lightbox-error').hidden = true;
    }, { once: true });
    img.addEventListener('error', () => {
      if (detailUuid !== uuid) return;
      clearTimeout(detailSlow);
      detailFailed('That photo could not be opened.');
    }, { once: true });
    img.src = url;
  }).catch((error) => {
    console.error('detail load failed', error);
    if (detailUuid !== uuid) return;
    clearTimeout(detailSlow);
    detailFailed('That photo could not be opened.');
  });
}

function step(delta) {
  const index = detailIndex();
  const next = index + delta;
  if (index < 0 || next < 0 || next >= photos.length) return;
  showFrame(photos[next].uuid);
}

function openDetail(uuid) {
  if (!photos.some((p) => p.uuid === uuid)) return;
  lastFocused = document.activeElement;
  lightbox().hidden = false;
  document.body.classList.add('is-locked');
  document.body.style.overflow = 'hidden'; // keep the wall from scrolling behind
  showFrame(uuid);
  $('lightbox-close').focus({ preventScroll: true });
}

function closeDetail() {
  if (lightbox().hidden) return;
  detailUuid = null;
  clearTimeout(detailSlow);
  lightbox().hidden = true;
  document.body.classList.remove('is-locked');
  document.body.style.overflow = '';
  $('lightbox-img').removeAttribute('src');
  $('lightbox-img').classList.remove('is-loaded');
  if (lastFocused && document.contains(lastFocused)) {
    lastFocused.focus({ preventScroll: true });
  }
  lastFocused = null;
}

$('lightbox-close').addEventListener('click', closeDetail);
$('lb-prev').addEventListener('click', () => step(-1));
$('lb-next').addEventListener('click', () => step(1));
$('lb-stage').addEventListener('click', (e) => { if (e.target === $('lb-stage')) closeDetail(); });

/* Keyboard: Escape closes, arrows page the roll, Tab stays inside the dialog. */
document.addEventListener('keydown', (e) => {
  if (lightbox().hidden) return;
  if (e.key === 'Escape') { closeDetail(); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); step(1); return; }
  if (e.key !== 'Tab') return;
  const focusable = [...$('lb-dialog').querySelectorAll('button:not(:disabled)')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* Swipe between frames on touch. */
let touchStart = null;
$('lb-stage').addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });
$('lb-stage').addEventListener('touchend', (e) => {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy)) return;
  step(dx < 0 ? 1 : -1);
}, { passive: true });

$('lightbox-download').addEventListener('click', async () => {
  const data = photos.find((p) => p.uuid === detailUuid);
  if (!data) return;
  const btn = $('lightbox-download');
  const label = $('download-label');
  btn.disabled = true;
  label.textContent = 'Saving…';
  try {
    await saveSinglePhoto(data); // GALLERY-003
  } catch (error) {
    console.error('download failed', error);
    $('lightbox-error').textContent = 'Download failed. Check your connection and try again.';
    $('lightbox-error').hidden = false;
  } finally {
    btn.disabled = false;
    label.textContent = 'Save';
  }
});

/* ── saving photos (GALLERY-003 / 005 / 006) ──────────────────────── */
/* iOS puts a downloaded file in Files › Downloads rather than the camera roll,
 * which surprises guests often enough to be worth one line of copy. */
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function coupleSlug() {
  return safeName(config && config.coupleNames, 'wedding');
}

/** The filename pattern the lightbox has always used: couple-stamp-nickname.jpg */
function photoFileName(data) {
  const nick = safeName(data.nickname, 'guest');
  return `${coupleSlug()}-${fileStamp(data.capturedAt || data.receivedAt)}-${nick}.jpg`;
}

/* A stalled connection must not leave the guest staring at "Saving…" forever:
 * every photo gets a ceiling, so the UI can surface the failure and recover. */
const PHOTO_FETCH_MS = 60_000;

function withDeadline(promise, ms, message) {
  let timer = null;
  const bell = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, bell]).finally(() => clearTimeout(timer));
}

/** The deadline covers the signed-URL lookup as well as the bytes: either half
 *  can stall, and a guest stuck on "Saving…" has no way out. */
async function fetchPhotoBlob(data, front = false) {
  const abort = new AbortController();
  const job = (async () => {
    const url = await photoUrl(data.storagePath, front);
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return res.blob();
  })();
  job.catch(() => { /* the deadline may win the race; never leave this unhandled */ });
  try {
    return await withDeadline(job, PHOTO_FETCH_MS, 'photo fetch timed out');
  } catch (error) {
    abort.abort();
    throw error;
  }
}

/** Anchor click on a blob URL — same origin, so this works without a gesture. */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000); // Safari reads it lazily
}

/** GALLERY-003: one frame at stored quality (lightbox Save, single selection). */
async function saveSinglePhoto(data) {
  const blob = await fetchPhotoBlob(data, true);
  saveBlob(blob, photoFileName(data));
}

/* ── the ready banner (shared by GALLERY-005 and GALLERY-006) ─────── */
/* A ZIP is never handed over by navigating after an await: mobile Safari and
 * Chrome both drop such a navigation. The guest gets a link to tap instead. */
let readyBlobUrl = null;

function syncDock() {
  const open = !$('ready-banner').hidden || !$('selbar').hidden;
  app.classList.toggle('has-dock', open);
}

function hideReady() {
  $('ready-banner').hidden = true;
  $('ready-link').removeAttribute('href');
  if (readyBlobUrl) { URL.revokeObjectURL(readyBlobUrl); readyBlobUrl = null; }
  syncDock();
}

function showReady({ note, label, href, filename, hint = false, blobUrl = null }) {
  if (readyBlobUrl && readyBlobUrl !== blobUrl) URL.revokeObjectURL(readyBlobUrl);
  readyBlobUrl = blobUrl;
  $('ready-note').textContent = note;
  $('ready-label').textContent = label;
  const link = $('ready-link');
  link.href = href;
  link.download = filename;
  $('ready-hint').hidden = !hint;
  $('ready-banner').hidden = false;
  syncDock();
  link.focus({ preventScroll: true });
}

$('ready-dismiss').addEventListener('click', () => {
  hideReady();
  const back = selecting ? $('sel-download') : $('download-all');
  if (back && !back.disabled) back.focus({ preventScroll: true });
});

/* ── Download all (GALLERY-005) ───────────────────────────────────── */
/* The whole album is zipped server-side by the `exportGalleryZip` callable —
 * hundreds of originals are far too much for a phone to fetch and pack. */
const EXPORT_TIMEOUT_MS = 540_000; // 9 minutes, matching the function's own ceiling

const EXPORT_ERRORS = {
  'permission-denied': 'The album locked itself again. Reload the page and enter the PIN.',
  'failed-precondition': 'The album is not open yet.',
  'resource-exhausted': 'Please wait a little before downloading again.',
};

function errorCode(error) {
  return String((error && error.code) || '').replace(/^functions\//, '');
}

function setPacking(on, label) {
  packing = on;
  $('download-all-spinner').hidden = !on;
  $('download-all-label').textContent = label || 'Download all';
  syncToolbarActions();
}

async function downloadWholeAlbum() {
  if (packing || photos.length === 0) return;
  const count = photos.length;
  hideReady();
  setPacking(true, `Packing ${photoCountLabel(count)}…`);
  try {
    // Building the album ZIP server-side — or waiting on another guest's build —
    // can run for minutes, so this call outlives the 70s callable default and the
    // button simply stays in its packing state until the server answers.
    const call = httpsCallable(functions, 'exportGalleryZip', { timeout: EXPORT_TIMEOUT_MS });
    const res = await call({});
    const data = (res && res.data) || {};
    if (!data.url) throw new Error('export returned no url');
    const total = Number(data.count) > 0 ? Number(data.count) : count;
    showReady({
      note: 'Your album is ready',
      label: `Download ZIP (${photoCountLabel(total)})`,
      href: data.url,
      filename: `${coupleSlug()}-album.zip`,
      hint: IS_IOS,
    });
  } catch (error) {
    console.error('album export failed', error);
    toast(EXPORT_ERRORS[errorCode(error)]
      || 'Could not prepare the album. Try again in a moment.', 'bad');
  } finally {
    setPacking(false);
  }
}

$('download-all').addEventListener('click', downloadWholeAlbum);

/* ── select mode (GALLERY-006) ────────────────────────────────────── */
/* Anything past this is a server job: packing it in the browser means holding
 * every original in memory at once. */
const MAX_SELECTION_ZIP = 60;
const OVER_CAP_MSG = 'For more than 60 photos, use Download all';
const ZIP_FETCH_CONCURRENCY = 4;

function syncToolbarActions() {
  $('download-all').disabled = packing || photos.length === 0;
  $('select-toggle').disabled = packing || photos.length === 0;
}

/** In select mode a tile is a checkbox, not a link into the lightbox. */
function syncShotSemantics(shot, data) {
  const by = byLine(data);
  if (selecting) {
    shot.root.setAttribute('role', 'checkbox');
    shot.root.setAttribute('aria-checked', String(selected.has(data.uuid)));
    shot.root.setAttribute('aria-label', `Photo ${by}. Select this photo.`);
  } else {
    shot.root.removeAttribute('role');
    shot.root.removeAttribute('aria-checked');
    shot.root.setAttribute('aria-label', `Photo ${by}. Opens full screen.`);
  }
}

function refreshShotSemantics() {
  for (const data of photos) {
    const shot = shots.get(data.uuid);
    if (shot) syncShotSemantics(shot, data);
  }
}

function setSelectionStatus(text) {
  $('selbar-count').textContent = text;
}

function renderSelection() {
  const n = selected.size;
  const over = n > MAX_SELECTION_ZIP;
  const all = photos.length > 0 && n >= photos.length;
  if (!selectionBusy) setSelectionStatus(`${n} selected`);
  $('sel-all').textContent = all ? 'Clear' : 'Select all';
  $('sel-all').disabled = selectionBusy || photos.length === 0;
  $('sel-cancel').disabled = selectionBusy;
  $('sel-download').disabled = selectionBusy || n === 0 || over;
}

function setSelectMode(on, manageFocus = true) {
  if (selecting === on) return;
  selecting = on;
  if (!on) selected.clear();
  $('wall').dataset.selecting = on ? 'true' : 'false';
  $('select-toggle').setAttribute('aria-pressed', String(on));
  $('select-toggle-label').textContent = on ? 'Done' : 'Select';
  $('selbar').hidden = !on;
  $('wall-foot').textContent = on
    ? 'Tap photos to pick them, then download the selection.'
    : 'Tap any photo to see it full screen and save it.';
  refreshShotSemantics();
  renderSelection();
  syncDock();
  if (!manageFocus) return;
  const target = on ? $('sel-all') : $('select-toggle');
  if (target && !target.disabled) target.focus({ preventScroll: true });
}

function toggleSelection(uuid) {
  if (selectionBusy) return;
  if (selected.has(uuid)) selected.delete(uuid);
  else selected.add(uuid);
  const shot = shots.get(uuid);
  const data = photos.find((p) => p.uuid === uuid);
  if (shot && data) syncShotSemantics(shot, data);
  if (selected.size === MAX_SELECTION_ZIP + 1) toast(OVER_CAP_MSG);
  renderSelection();
}

$('select-toggle').addEventListener('click', () => setSelectMode(!selecting));
$('sel-cancel').addEventListener('click', () => setSelectMode(false));

$('sel-all').addEventListener('click', () => {
  if (selectionBusy) return;
  const all = photos.length > 0 && selected.size >= photos.length;
  selected.clear();
  if (!all) {
    for (const data of photos) selected.add(data.uuid);
    if (selected.size > MAX_SELECTION_ZIP) toast(OVER_CAP_MSG);
  }
  refreshShotSemantics();
  renderSelection();
});

/* Escape leaves select mode; the lightbox keeps its own Escape. */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !selecting) return;
  if (!lightbox().hidden) return;
  setSelectMode(false);
});

/** Four at a time: enough to saturate a phone's link, few enough to stay polite. */
async function fetchSelectionBlobs(picks) {
  const blobs = new Array(picks.length);
  let started = 0;
  let done = 0;
  setSelectionStatus(`Fetching 0 / ${picks.length}…`);
  const worker = async () => {
    for (;;) {
      const index = started;
      started += 1;
      if (index >= picks.length) return;
      blobs[index] = await fetchPhotoBlob(picks[index]);
      done += 1;
      setSelectionStatus(`Fetching ${done} / ${picks.length}…`);
    }
  };
  const lanes = Math.min(ZIP_FETCH_CONCURRENCY, picks.length);
  await Promise.all(Array.from({ length: lanes }, worker));
  return blobs;
}

async function buildZipEntries(picks, blobs) {
  const entries = {};
  for (let i = 0; i < picks.length; i += 1) {
    let name = photoFileName(picks[i]);
    if (entries[name]) { // same guest, same minute — keep both frames
      const dot = name.lastIndexOf('.');
      name = `${name.slice(0, dot)}-${i + 1}${name.slice(dot)}`;
    }
    entries[name] = new Uint8Array(await blobs[i].arrayBuffer());
  }
  return entries;
}

/** Level 0: JPEGs do not recompress, so deflating only burns phone battery. */
function zipEntries(entries) {
  return new Promise((resolve, reject) => {
    zip(entries, { level: 0 }, (error, data) => (error ? reject(error) : resolve(data)));
  });
}

async function downloadSelection() {
  const picks = photos.filter((data) => selected.has(data.uuid));
  if (!picks.length || picks.length > MAX_SELECTION_ZIP || selectionBusy) return;
  selectionBusy = true;
  hideReady();
  renderSelection();
  try {
    if (picks.length === 1) {
      setSelectionStatus('Saving…');
      await saveSinglePhoto(picks[0]);
      selectionBusy = false;
      setSelectMode(false);
      return;
    }
    const blobs = await fetchSelectionBlobs(picks);
    setSelectionStatus('Packing ZIP…');
    const entries = await buildZipEntries(picks, blobs);
    const bytes = await zipEntries(entries);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    showReady({
      note: `${photoCountLabel(picks.length)} ready`,
      label: 'Save ZIP',
      href: url,
      filename: `${coupleSlug()}-selected-${picks.length}-photos.zip`,
      hint: IS_IOS,
      blobUrl: url,
    });
  } catch (error) {
    console.error('selection download failed', error);
    toast('Could not save those photos. Check your connection and try again.', 'bad');
  } finally {
    selectionBusy = false;
    renderSelection();
  }
}

$('sel-download').addEventListener('click', downloadSelection);

/* ── PIN entry (GALLERY-002) ──────────────────────────────────────── */
const pinCells = [...$('pin-cells').children];

function renderPinCells() {
  const value = $('pin-input').value;
  pinCells.forEach((cell, i) => {
    cell.textContent = value[i] || '';
    cell.classList.toggle('is-filled', Boolean(value[i]));
    cell.classList.toggle('is-active', i === Math.min(value.length, pinCells.length - 1));
  });
}

$('pin-input').addEventListener('input', (e) => {
  const cleaned = e.target.value.replace(/\D+/g, '').slice(0, 6);
  if (cleaned !== e.target.value) e.target.value = cleaned;
  $('pin-error').hidden = true;
  renderPinCells();
});
$('pin-input').addEventListener('focus', renderPinCells);
$('pin-input').addEventListener('blur', renderPinCells);

function pinError(message) {
  const node = $('pin-error');
  node.textContent = message;
  node.hidden = false;
  const cells = $('pin-cells');
  cells.classList.remove('shake');
  void cells.offsetWidth; // restart the animation
  cells.classList.add('shake');
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
    input.focus({ preventScroll: true });
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
      renderPinCells();
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
  refreshInkTokens();
  applyThemeHero();

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
  renderPinCells();
}

/* ── boot ─────────────────────────────────────────────────────────── */
async function boot() {
  setState('loading');
  refreshInkTokens();
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
