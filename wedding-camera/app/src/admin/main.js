/**
 * Admin app — workstream ④.
 * Implements PRD ADMIN-001..009 against docs/CONTRACTS.md §2 (shapes), §4 (claims), §5.
 *
 * Hard rules honoured here:
 *  - all rendered text via textContent (never innerHTML) — XSS guard, CONTRACTS §9
 *  - every Firestore/Storage/callable call has a catch + a visible toast
 *  - admin writes are direct Firestore writes batched with their audit doc (CONTRACTS §5)
 */
import { auth, db, storage, functions } from '../lib/firebase.js';
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from 'firebase/auth';
import {
  collection, doc, increment, onSnapshot, orderBy, query, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { imagePathOf, openSlideshow } from '../lib/slideshow.js';

const GRANT_SNAPS = 10;

/* ADMIN-009 / GALLERY-007 — the couple's note on a frame. The rules cap the
 * stored string at 200 chars; an empty string means "no caption". */
const CAPTION_MAX = 200;
const ADD_NOTE_LABEL = 'Add a note';

const app = document.getElementById('app');
const views = new Map(
  [...document.querySelectorAll('[data-view]')].map((el) => [el.dataset.view, el]),
);
const $ = (id) => document.getElementById(id);

/* ── tiny DOM helpers ─────────────────────────────────────────────── */
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
  setTimeout(() => node.remove(), kind === 'bad' ? 7000 : 4000);
}

function reportError(what, error) {
  console.error(what, error);
  const code = error && (error.code || error.message) ? (error.code || error.message) : '';
  toast(code ? `${what} (${code})` : what, 'bad');
}

/* ── confirm modal ────────────────────────────────────────────────── */
let modalResolve = null;
function closeModal(result) {
  $('modal').hidden = true;
  document.body.style.overflow = '';
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(result);
}
function confirmAction({ title, body, confirmLabel = 'Confirm' }) {
  $('modal-title').textContent = title;
  $('modal-body').textContent = body;
  $('modal-confirm').textContent = confirmLabel;
  $('modal').hidden = false;
  document.body.style.overflow = 'hidden';
  $('modal-confirm').focus();
  return new Promise((resolve) => { modalResolve = resolve; });
}
$('modal-cancel').addEventListener('click', () => closeModal(false));
$('modal-confirm').addEventListener('click', () => closeModal(true));
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal').hidden) closeModal(false);
});

/* ── formatting ───────────────────────────────────────────────────── */
function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate();
  if (ts instanceof Date) return ts;
  return null;
}
function fmtDateTime(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
function fmtAgo(ts) {
  const d = toDate(ts);
  if (!d) return 'never seen';
  const secs = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return fmtDateTime(ts);
}

/* ── audit helper (ADMIN-008) ─────────────────────────────────────── */
function auditEntry(action, target) {
  return {
    action,
    target: target ?? null,
    actorUid: auth.currentUser ? auth.currentUser.uid : '',
    at: serverTimestamp(),
  };
}

/* ── login (ADMIN-001) ────────────────────────────────────────────── */
const LOGIN_ERRORS = {
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/invalid-login-credentials': 'Email or password is incorrect.',
  'auth/wrong-password': 'Email or password is incorrect.',
  'auth/user-not-found': 'Email or password is incorrect.',
  'auth/invalid-email': 'That does not look like an email address.',
  'auth/user-disabled': 'That account has been disabled.',
  'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
  'auth/network-request-failed': 'No connection. Check your signal and try again.',
};

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  const errorNode = $('login-error');
  errorNode.hidden = true;
  if (!email || !password) {
    errorNode.textContent = 'Enter both email and password.';
    errorNode.hidden = false;
    return;
  }
  const submit = $('login-submit');
  submit.disabled = true;
  submit.textContent = 'Signing in…';
  try {
    await signInWithEmailAndPassword(auth, email, password);
    $('login-password').value = '';
  } catch (error) {
    console.error('sign-in failed', error);
    errorNode.textContent = LOGIN_ERRORS[error?.code] || 'Could not sign in. Please try again.';
    errorNode.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});

$('back-to-login').addEventListener('click', () => {
  notAuthorized = false;
  setState('login');
});

$('sign-out').addEventListener('click', async () => {
  try {
    stopSubscriptions();
    await signOut(auth);
  } catch (error) {
    reportError('Could not sign out', error);
  }
});

/* ── tabs ─────────────────────────────────────────────────────────── */
function selectTab(which) {
  const photos = which === 'photos';
  $('tab-photos').setAttribute('aria-selected', String(photos));
  $('tab-devices').setAttribute('aria-selected', String(!photos));
  $('panel-photos').hidden = !photos;
  $('panel-devices').hidden = photos;
}
$('tab-photos').addEventListener('click', () => selectTab('photos'));
$('tab-devices').addEventListener('click', () => selectTab('devices'));

/* ── controls: pause / release / zip ──────────────────────────────── */
let eventConfig = null;
let controlBusy = false;

function renderControls() {
  const pausePill = $('pause-pill');
  const releasePill = $('release-pill');
  const pauseBtn = $('pause-btn');
  const releaseBtn = $('release-btn');

  $('live-btn').disabled = !eventConfig || !eventConfig.slug; // ADMIN-010
  if (!eventConfig) {
    pausePill.textContent = 'Uploads —';
    releasePill.textContent = 'Gallery —';
    pauseBtn.disabled = true;
    releaseBtn.disabled = true;
    return;
  }
  const paused = eventConfig.paused === true;
  const released = eventConfig.galleryReleased === true;

  pausePill.textContent = paused ? 'Uploads paused' : 'Uploads live';
  pausePill.className = `pill ${paused ? 'warn' : 'on'}`;
  releasePill.textContent = released ? 'Gallery released' : 'Gallery locked';
  releasePill.className = `pill ${released ? 'on' : ''}`.trim();

  pauseBtn.textContent = paused ? 'Resume uploads' : 'Pause uploads';
  pauseBtn.className = paused ? 'btn' : 'btn btn-danger';
  pauseBtn.disabled = controlBusy;

  releaseBtn.textContent = released ? 'Gallery is live' : 'Release gallery';
  releaseBtn.disabled = released || controlBusy; // one-way in the UI (ADMIN-007)

  if (eventConfig.coupleNames) $('couple-names').textContent = eventConfig.coupleNames;
}

$('pause-btn').addEventListener('click', async () => {
  if (!eventConfig) return;
  const paused = eventConfig.paused === true;
  const next = !paused;
  const ok = await confirmAction({
    title: next ? 'Pause all uploads?' : 'Resume uploads?',
    body: next
      ? 'Guests will see a gentle "camera resting" message and photos already queued will wait until you resume.'
      : 'Guests can shoot and upload again within a few seconds.',
    confirmLabel: next ? 'Pause uploads' : 'Resume uploads',
  });
  if (!ok) return;
  controlBusy = true;
  renderControls();
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'config', 'event'), { paused: next });
    batch.set(doc(collection(db, 'audit')), auditEntry(next ? 'pause' : 'resume', null));
    await batch.commit();
    toast(next ? 'Uploads paused.' : 'Uploads resumed.', 'good');
  } catch (error) {
    reportError(next ? 'Could not pause uploads' : 'Could not resume uploads', error);
  } finally {
    controlBusy = false;
    renderControls();
  }
});

$('release-btn').addEventListener('click', async () => {
  if (!eventConfig || eventConfig.galleryReleased === true) return;
  const hidden = photoDocs.filter((p) => p.status === 'hidden').length;
  const visible = photoDocs.length - hidden;
  const ok = await confirmAction({
    title: 'Release the gallery?',
    body: `${visible} photo${visible === 1 ? '' : 's'} will become visible to anyone with the link and the PIN`
      + `${hidden ? `; ${hidden} hidden one${hidden === 1 ? '' : 's'} stay out` : ''}. `
      + 'This cannot be undone from here.',
    confirmLabel: 'Release gallery',
  });
  if (!ok) return;
  controlBusy = true;
  renderControls();
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'config', 'event'), { galleryReleased: true });
    batch.set(doc(collection(db, 'audit')), auditEntry('release', null));
    await batch.commit();
    toast('Gallery released.', 'good');
  } catch (error) {
    reportError('Could not release the gallery', error);
  } finally {
    controlBusy = false;
    renderControls();
  }
});

/**
 * Manual reconciliation sweep (UPLOAD-009 / CONTRACTS §5 `reconcileNow`).
 * Admin-gated and idempotent server-side, so it is safe to press twice and it
 * deliberately writes NO audit doc (audit actions are a closed rules-enforced set).
 */
const RECONCILE_LABEL = 'Deliver pending photos now';

$('reconcile-btn').addEventListener('click', async () => {
  const btn = $('reconcile-btn');
  btn.disabled = true;
  btn.classList.add('spin');
  btn.textContent = 'Checking uploads…';
  try {
    const call = httpsCallable(functions, 'reconcileNow');
    const res = await call({});
    const data = res && res.data ? res.data : {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const scanned = num(data.scanned);
    const accepted = num(data.accepted);
    const deferred = num(data.deferred);
    const rejected = num(data.rejected);
    const parts = [
      `Checked ${scanned} upload${scanned === 1 ? '' : 's'}`,
      `${accepted} delivered`,
    ];
    if (deferred) parts.push(`${deferred} waiting (paused)`);
    if (rejected) parts.push(`${rejected} not accepted`);
    toast(parts.join(' · '), accepted ? 'good' : '');
  } catch (error) {
    reportError('Could not deliver pending photos', error);
  } finally {
    btn.disabled = false;
    btn.classList.remove('spin');
    btn.textContent = RECONCILE_LABEL;
  }
});

$('zip-btn').addEventListener('click', async () => {
  const btn = $('zip-btn');
  btn.disabled = true;
  btn.classList.add('spin');
  btn.textContent = 'Zipping…';
  try {
    const call = httpsCallable(functions, 'exportZip');
    const res = await call({ includeHidden: false });
    const data = res && res.data ? res.data : {};
    if (!data.url) throw new Error('no url returned');
    toast(`ZIP ready — ${data.count ?? 0} photo${data.count === 1 ? '' : 's'}.`, 'good');
    window.open(data.url, '_blank', 'noopener');
  } catch (error) {
    reportError('ZIP export failed', error);
  } finally {
    btn.disabled = false;
    btn.classList.remove('spin');
    btn.textContent = 'Download ZIP';
  }
});

/* ── photo grid (ADMIN-002 / ADMIN-003) ───────────────────────────── */
const thumbUrls = new Map();   // storagePath → Promise<string>
const frames = new Map();      // uuid → { card, root, img, thumb, nick, time, badge, caption… }
let photoDocs = [];

function thumbUrl(path) {
  if (!thumbUrls.has(path)) {
    thumbUrls.set(
      path,
      getDownloadURL(storageRef(storage, path)).catch((error) => {
        thumbUrls.delete(path); // allow a retry on the next render
        throw error;
      }),
    );
  }
  return thumbUrls.get(path);
}

/** Thumbnails load only as they come into view — the couple may have 1,000+ frames. */
let thumbObserver = null;
function ensureThumbObserver() {
  if (thumbObserver || typeof IntersectionObserver !== 'function') return;
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      thumbObserver.unobserve(entry.target);
      loadThumb(entry.target.dataset.uuid);
    }
  }, { rootMargin: '300px 0px' });
}

function loadThumb(uuid) {
  const frame = frames.get(uuid);
  const data = photoDocs.find((p) => p.uuid === uuid);
  const path = data ? imagePathOf(data) : '';
  if (!frame || frame.loaded || !path) return;
  frame.loaded = true;
  thumbUrl(path).then((url) => {
    frame.img.src = url;
    frame.img.hidden = false;
    frame.thumb.firstChild.textContent = '';
  }).catch((error) => {
    console.error('thumbnail failed', uuid, error);
    frame.loaded = false;
    frame.thumb.firstChild.textContent = 'no preview';
  });
}

/**
 * ADMIN-009 — the caption row lives OUTSIDE the hide/unhide button so a hidden
 * frame can still be captioned and a tap on the note never toggles the photo.
 */
function buildCaptionRow(uuid) {
  const row = el('div', 'caption-row');

  const view = el('button', 'caption-view');
  view.type = 'button';
  const viewText = el('span', 'caption-text');
  view.appendChild(viewText);

  const tick = el('span', 'caption-tick', 'Saved');
  tick.hidden = true;

  const form = el('form', 'caption-edit');
  form.hidden = true;
  form.noValidate = true;

  const input = el('textarea', 'caption-input');
  input.rows = 2;
  input.maxLength = CAPTION_MAX;
  input.placeholder = 'A note from the two of you…';
  input.setAttribute('aria-label', 'Note on this photo');

  const foot = el('div', 'caption-foot');
  const counter = el('span', 'caption-counter');
  const cancel = el('button', 'btn btn-small btn-quiet caption-cancel', 'Cancel');
  cancel.type = 'button';
  const save = el('button', 'btn btn-small btn-primary caption-save', 'Save');
  save.type = 'submit';
  foot.append(counter, cancel, save);
  form.append(input, foot);

  row.append(view, tick, form);

  view.addEventListener('click', () => openCaptionEditor(uuid));
  cancel.addEventListener('click', () => closeCaptionEditor(frames.get(uuid), true));
  input.addEventListener('input', () => syncCaptionCounter(frames.get(uuid)));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeCaptionEditor(frames.get(uuid), true); }
    // Single-line feel: Enter saves, Shift+Enter still breaks the line.
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); saveCaption(uuid); }
  });
  form.addEventListener('submit', (event) => { event.preventDefault(); saveCaption(uuid); });

  return { row, view, viewText, tick, form, input, counter, save };
}

function buildFrame(uuid) {
  const card = el('div', 'photo-card');
  card.dataset.uuid = uuid;

  const root = el('button', 'frame');
  root.type = 'button';
  root.dataset.uuid = uuid;

  const thumb = el('div', 'frame-thumb', '…');
  const img = el('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.hidden = true;
  thumb.appendChild(img);

  const badge = el('span', 'frame-state', 'Hidden');
  badge.hidden = true;

  const meta = el('div', 'frame-meta');
  const nick = el('span', 'frame-nick');
  const time = el('span', 'frame-time');
  meta.append(nick, time);

  root.append(thumb, badge, meta);
  root.addEventListener('click', () => togglePhoto(uuid));

  const caption = buildCaptionRow(uuid);
  card.append(root, caption.row);

  const frame = {
    card, root, img, thumb, nick, time, badge, loaded: false, saving: false, ...caption,
  };
  frames.set(uuid, frame);
  return frame;
}

/** The stored note for a photo, trimmed ('' when the couple left none). */
function captionOf(uuid) {
  const data = photoDocs.find((p) => p.uuid === uuid);
  return data && typeof data.caption === 'string' ? data.caption.trim() : '';
}

function paintCaption(frame, data) {
  const text = typeof data.caption === 'string' ? data.caption.trim() : '';
  frame.viewText.textContent = text || ADD_NOTE_LABEL;
  frame.view.classList.toggle('is-empty', !text);
  frame.view.setAttribute('aria-label', text ? `Note: ${text}. Tap to edit.` : 'Add a note to this photo.');
}

function paintFrame(frame, data) {
  const hidden = data.status === 'hidden';
  frame.nick.textContent = data.nickname || 'Unknown guest';
  frame.time.textContent = fmtDateTime(data.receivedAt);
  frame.badge.hidden = !hidden;
  frame.card.classList.toggle('hidden-photo', hidden);
  frame.root.classList.toggle('hidden-photo', hidden);
  frame.root.setAttribute('aria-pressed', String(hidden));
  frame.root.setAttribute(
    'aria-label',
    `${hidden ? 'Hidden' : 'Visible'} photo by ${data.nickname || 'unknown guest'}, `
    + `${fmtDateTime(data.receivedAt)}. Tap to ${hidden ? 'unhide' : 'hide'}.`,
  );
  paintCaption(frame, data);
}

/* ── caption editing (ADMIN-009) ──────────────────────────────────── */
function syncCaptionCounter(frame) {
  if (!frame) return;
  // `fill()`, paste and IME can all land more than maxlength — clamp for real.
  if (frame.input.value.length > CAPTION_MAX) frame.input.value = frame.input.value.slice(0, CAPTION_MAX);
  const used = frame.input.value.length;
  frame.counter.textContent = `${used}/${CAPTION_MAX}`;
  frame.counter.classList.toggle('is-full', used >= CAPTION_MAX);
}

function openCaptionEditor(uuid) {
  const frame = frames.get(uuid);
  if (!frame) return;
  frame.tick.hidden = true;
  frame.input.value = captionOf(uuid);
  syncCaptionCounter(frame);
  frame.view.hidden = true;
  frame.form.hidden = false;
  frame.card.classList.add('is-editing');
  frame.input.focus();
  const end = frame.input.value.length;
  frame.input.setSelectionRange(end, end);
}

function closeCaptionEditor(frame, focusBack = false) {
  if (!frame) return;
  frame.form.hidden = true;
  frame.view.hidden = false;
  frame.card.classList.remove('is-editing');
  if (focusBack) frame.view.focus();
}

const SAVED_TICK_MS = 2200;

function flashSaved(frame) {
  frame.tick.hidden = false;
  clearTimeout(frame.tickTimer);
  frame.tickTimer = setTimeout(() => { frame.tick.hidden = true; }, SAVED_TICK_MS);
}

/** Writes `caption` and its audit doc in one batch (ADMIN-008 / CONTRACTS §5). */
async function saveCaption(uuid) {
  const frame = frames.get(uuid);
  if (!frame || frame.saving) return;
  const next = frame.input.value.trim().slice(0, CAPTION_MAX);
  if (next === captionOf(uuid)) { closeCaptionEditor(frame, true); return; }
  frame.saving = true;
  frame.save.disabled = true;
  frame.save.textContent = 'Saving…';
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'photos', uuid), { caption: next });
    batch.set(doc(collection(db, 'audit')), auditEntry('caption', uuid));
    await batch.commit();
    closeCaptionEditor(frame);
    flashSaved(frame);
  } catch (error) {
    // The editor stays open with the typed text so nothing the couple wrote is lost.
    reportError('Could not save that note', error);
  } finally {
    frame.saving = false;
    frame.save.disabled = false;
    frame.save.textContent = 'Save';
  }
}

function renderPhotos(docs) {
  photoDocs = docs;
  const grid = $('photo-grid');
  ensureThumbObserver();
  const hiddenCount = docs.filter((d) => d.status === 'hidden').length;

  $('photo-count-tab').textContent = docs.length ? String(docs.length) : '';
  $('photo-empty').hidden = docs.length > 0;
  $('photo-summary').textContent = docs.length
    ? `${docs.length} photo${docs.length === 1 ? '' : 's'} · ${hiddenCount} hidden`
    : 'Nothing developed yet.';

  const seen = new Set();
  docs.forEach((data, index) => {
    seen.add(data.uuid);
    const frame = frames.get(data.uuid) || buildFrame(data.uuid);
    paintFrame(frame, data);
    // Only move a card that is actually out of place: re-inserting a node blurs
    // whatever is focused inside it, and a caption editor may be open (ADMIN-009).
    const at = grid.children[index];
    if (at !== frame.card) grid.insertBefore(frame.card, at || null);
    if (frame.loaded) return;
    if (thumbObserver) thumbObserver.observe(frame.root);
    else loadThumb(data.uuid);
  });
  for (const [uuid, frame] of frames) {
    if (!seen.has(uuid)) { frame.card.remove(); frames.delete(uuid); }
  }
  notifyLiveWall(); // ADMIN-010: a hide takes the frame out of the show, live
}

async function togglePhoto(uuid) {
  const current = photoDocs.find((p) => p.uuid === uuid);
  const frame = frames.get(uuid);
  if (!current || !frame) return;
  const next = current.status === 'hidden' ? 'visible' : 'hidden';
  frame.root.classList.add('busy');
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'photos', uuid), { status: next });
    batch.set(
      doc(collection(db, 'audit')),
      auditEntry(next === 'hidden' ? 'hide' : 'unhide', uuid),
    );
    await batch.commit();
    toast(next === 'hidden' ? 'Photo hidden from the gallery.' : 'Photo is visible again.');
  } catch (error) {
    reportError(next === 'hidden' ? 'Could not hide that photo' : 'Could not unhide that photo', error);
  } finally {
    frame.root.classList.remove('busy');
  }
}

/* ── live wall / TV mode (ADMIN-010) ──────────────────────────────── */
/* The same slideshow the gallery uses (lib/slideshow.js), fed from the live
 * admin query so a frame that lands during dinner joins the rotation on its own
 * and a frame the couple hide leaves it. Only 'visible' photos ever appear —
 * the darkroom is where hidden frames live, never the TV. The corner card
 * carries the GUEST CAMERA link, so the room can pick up a camera, and never a
 * gallery PIN. */
const liveFeeds = new Set();
let liveWall = null;

function visiblePhotos() {
  return photoDocs.filter((data) => data.status !== 'hidden');
}

function notifyLiveWall() {
  for (const feed of liveFeeds) feed(visiblePhotos());
}

/** Subscribe contract of lib/slideshow.js: current frames now, then every change. */
function liveFeed(onPhotos) {
  liveFeeds.add(onPhotos);
  onPhotos(visiblePhotos());
  return () => liveFeeds.delete(onPhotos);
}

/** The address on the printed QR code: /e/{slug}/ (CONTRACTS §1). */
function cameraUrl() {
  return `${window.location.origin}/e/${eventConfig.slug}/`;
}

$('live-btn').addEventListener('click', () => {
  if (liveWall) return;
  if (!eventConfig || !eventConfig.slug) {
    toast('The event link is not set up yet.', 'bad');
    return;
  }
  if (visiblePhotos().length === 0) {
    toast('No visible photos to show yet.');
    return;
  }
  liveWall = openSlideshow({
    photos$: liveFeed,
    imageUrlFor: thumbUrl,
    config: eventConfig,
    qr: { url: cameraUrl(), label: 'Scan to take photos' },
    variant: 'admin',
    onClose: () => { liveWall = null; },
  });
});

/* ── devices (ADMIN-005) ──────────────────────────────────────────── */
function renderDevices(docs) {
  const list = $('device-list');
  list.textContent = ''; // clear
  $('device-count-tab').textContent = docs.length ? String(docs.length) : '';
  $('device-empty').hidden = docs.length > 0;
  $('device-summary').textContent = docs.length
    ? `${docs.length} guest device${docs.length === 1 ? '' : 's'}`
    : 'No guests have picked up a camera yet.';

  for (const data of docs) {
    const row = el('div', 'device');
    const info = el('div', 'device-info');
    info.append(
      el('span', 'device-nick', data.nickname || 'Unknown guest'),
      el('span', 'device-stats',
        `${data.snapsRemaining ?? 0} snaps left · ${data.snapsGranted ?? 0} granted`),
      el('span', 'device-seen', `seen ${fmtAgo(data.lastSeenAt)}`),
    );
    const grant = el('button', 'btn btn-small', `+${GRANT_SNAPS} snaps`);
    grant.type = 'button';
    grant.addEventListener('click', () => grantSnaps(data.uid, data.nickname, grant));
    row.append(info, grant);
    list.appendChild(row);
  }
}

async function grantSnaps(uid, nickname, button) {
  button.disabled = true;
  button.textContent = 'Granting…';
  try {
    const batch = writeBatch(db);
    // Rules allow admin to touch exactly these two device fields (CONTRACTS §2/§5).
    batch.update(doc(db, 'devices', uid), {
      snapsRemaining: increment(GRANT_SNAPS),
      snapsGranted: increment(GRANT_SNAPS),
    });
    batch.set(doc(collection(db, 'audit')), auditEntry('grant', uid));
    await batch.commit();
    toast(`+${GRANT_SNAPS} snaps for ${nickname || 'that guest'}.`, 'good');
  } catch (error) {
    reportError('Could not grant snaps', error);
  } finally {
    button.disabled = false;
    button.textContent = `+${GRANT_SNAPS} snaps`;
  }
}

/* ── subscriptions ────────────────────────────────────────────────── */
let unsubs = [];
function stopSubscriptions() {
  if (liveWall) liveWall.close();
  for (const unsub of unsubs) { try { unsub(); } catch { /* ignore */ } }
  unsubs = [];
  eventConfig = null;
  photoDocs = [];
  frames.clear();
  if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
  $('photo-grid').textContent = '';
  $('device-list').textContent = '';
}

function startSubscriptions() {
  stopSubscriptions();

  unsubs.push(onSnapshot(doc(db, 'config', 'event'), (snap) => {
    eventConfig = snap.exists() ? snap.data() : null;
    if (!snap.exists()) toast('Event config is missing.', 'bad');
    renderControls();
  }, (error) => reportError('Lost the event config feed', error)));

  // ADMIN-002: all photos, newest first, live.
  unsubs.push(onSnapshot(
    query(collection(db, 'photos'), orderBy('receivedAt', 'desc')),
    (snap) => renderPhotos(snap.docs.map((d) => ({ uuid: d.id, ...d.data() }))),
    (error) => {
      reportError('Lost the photo feed', error);
      $('photo-summary').textContent = 'Photo feed interrupted — reload to retry.';
    },
  ));

  unsubs.push(onSnapshot(
    query(collection(db, 'devices'), orderBy('lastSeenAt', 'desc')),
    (snap) => renderDevices(snap.docs.map((d) => ({ uid: d.id, ...d.data() }))),
    (error) => {
      reportError('Lost the guest list feed', error);
      $('device-summary').textContent = 'Guest feed interrupted — reload to retry.';
    },
  ));
}

/* ── auth gate (ADMIN-001, CONTRACTS §4) ──────────────────────────── */
let notAuthorized = false;

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    stopSubscriptions();
    setState(notAuthorized ? 'unauthorized' : 'login');
    return;
  }
  setState('loading');
  $('loading-note').textContent = 'Checking your host access…';
  let claims = {};
  try {
    const token = await user.getIdTokenResult();
    claims = token.claims || {};
  } catch (error) {
    reportError('Could not verify your access', error);
    setState('login');
    return;
  }
  if (claims.admin !== true) {
    notAuthorized = true;
    try { await signOut(auth); } catch (error) { console.error('sign-out failed', error); }
    setState('unauthorized');
    return;
  }
  notAuthorized = false;
  renderControls();
  selectTab('photos');
  setState('main');
  startSubscriptions();
});
