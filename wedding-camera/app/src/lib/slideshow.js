/**
 * Slideshow / TV mode — shared module (PRD GALLERY-009 + ADMIN-010).
 *
 * One full-screen, auto-advancing photo show for the venue TV or a laptop on the
 * dinner table, with a persistent corner card carrying a QR code so the room can
 * scan while it plays:
 *   - gallery variant → the album URL + "Scan to see the album" + the PIN
 *   - admin variant   → the guest camera URL + "Scan to take photos", no PIN
 *
 * Hard rules honoured here:
 *  - all rendered text via textContent (never innerHTML) — XSS guard, CONTRACTS §9
 *  - every colour comes from a theme token (see slideshow.css); nothing hardcoded
 *    but the black stage and the white QR card a scanner needs
 *  - the caller owns the data: it hands in a subscribe function and a URL resolver,
 *    so the gallery reuses its signed-URL cache and the admin its own
 */
import QRCode from 'qrcode';
import './slideshow.css';

/* ── tuning ───────────────────────────────────────────────────────── */
const ADVANCE_MS = 7000;      // a frame holds for 7s…
const FADE_MS = 900;          // …and crosses into the next over 900ms
const CONTROLS_MS = 3000;     // controls fade 3s after the last input
const PRELOAD_AHEAD = 2;      // fetch the next two frames while this one shows
const RETRY_MS = 1200;        // a frame that will not load steps aside quickly
const QR_RATIO = 0.22;        // of the shorter viewport edge
const QR_MIN = 120;
const QR_MAX = 260;
const QR_DARK = '#111111';
const QR_LIGHT = '#ffffff';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/**
 * The bytes to show for a photo. The finalize pipeline may publish a developed
 * copy (`developedPath`); until it does, the original upload is the picture.
 * Shared with the wall, the strip, the lightbox and the admin grid so one photo
 * is only ever fetched from one place.
 */
export function imagePathOf(photo) {
  if (!photo) return '';
  const developed = typeof photo.developedPath === 'string' ? photo.developedPath.trim() : '';
  return developed || photo.storagePath || '';
}

/**
 * Dev/test hook: `?slideshowInterval=500` shortens the 7s hold so a browser test
 * does not have to sit through it. Honoured on localhost ONLY — on a real host
 * the query string can come from anywhere, and the wedding TV gets 7s.
 */
export function slideshowIntervalMs() {
  try {
    if (!LOCAL_HOSTS.includes(window.location.hostname)) return ADVANCE_MS;
    const raw = new URLSearchParams(window.location.search).get('slideshowInterval');
    const ms = Number(raw);
    return Number.isFinite(ms) && ms >= 100 && ms <= 60_000 ? ms : ADVANCE_MS;
  } catch {
    return ADVANCE_MS;
  }
}

/* ── tiny DOM helpers (textContent only) ──────────────────────────── */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function icon(...paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

const ICONS = {
  prev: ['M15 5l-7 7 7 7'],
  next: ['M9 5l7 7-7 7'],
  play: ['M8 5l11 7-11 7z'],
  pause: ['M9 5v14', 'M15 5v14'],
  shuffle: ['M4 7h3.5l9 10H20', 'M4 17h3.5l9-10H20', 'M17.5 4.5L20 7l-2.5 2.5', 'M17.5 14.5L20 17l-2.5 2.5'],
  qr: ['M4 9V5h4', 'M20 9V5h-4', 'M4 15v4h4', 'M20 15v4h-4', 'M9 9h2v2H9z', 'M13 13h2v2h-2z'],
  exit: ['M6 6l12 12', 'M18 6L6 18'],
};

function iconButton(name, label, className = 'tv-btn') {
  const btn = el('button', className);
  btn.type = 'button';
  btn.setAttribute('aria-label', label);
  btn.appendChild(icon(...ICONS[name]));
  return btn;
}

/* ── formatting ───────────────────────────────────────────────────── */
function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate();
  return ts instanceof Date ? ts : null;
}

function timeOf(photo) {
  const date = toDate(photo.capturedAt) || toDate(photo.receivedAt);
  return date ? date.getTime() : 0;
}

/** "Sep 12, 8:24 PM" — the same shape the lightbox uses, one notch friendlier. */
function fmtWhen(photo) {
  const date = toDate(photo.capturedAt) || toDate(photo.receivedAt);
  if (!date) return '';
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function captionOf(photo) {
  return photo && typeof photo.caption === 'string' ? photo.caption.trim() : '';
}

function byLine(photo) {
  const nick = photo && photo.nickname ? String(photo.nickname) : 'A guest';
  const when = fmtWhen(photo);
  return when ? `${nick} · ${when}` : nick;
}

/* Only one slideshow is ever on screen. */
let active = null;

/**
 * Opens the slideshow. Returns a handle: `{ close() }`.
 *
 * @param {object}   options
 * @param {(cb: (photos: object[]) => void) => (() => void)} options.photos$
 *        Subscribe to the frames. MUST call `cb` immediately with the current
 *        list and again on every change; returns an unsubscribe function. Each
 *        photo: { uuid, storagePath, developedPath?, caption?, nickname?,
 *        capturedAt?, receivedAt? }.
 * @param {(path: string) => Promise<string>} options.imageUrlFor
 *        Resolves a storage path to a URL (the caller's cache / scheduler).
 * @param {object}  [options.config]  event config, for the album's own wording.
 * @param {{url: string, label: string, pin?: string}} options.qr  corner card.
 * @param {'gallery'|'admin'} [options.variant]
 * @param {number}  [options.intervalMs]  overrides the 7s hold.
 * @param {() => void} [options.onClose]
 */
export function openSlideshow(options) {
  const {
    photos$, imageUrlFor, qr, variant = 'gallery', onClose,
  } = options || {};
  if (typeof photos$ !== 'function' || typeof imageUrlFor !== 'function') {
    throw new Error('openSlideshow needs photos$ and imageUrlFor');
  }
  if (active) active.close();

  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : slideshowIntervalMs();

  /* ── state ──────────────────────────────────────────────────────── */
  let byUuid = new Map();       // uuid → photo
  let chrono = [];              // uuids, oldest → newest
  let order = [];               // playback order (chrono, or shuffled)
  let currentUuid = null;
  let frontLayer = 0;
  let kbFlip = false;
  let paused = false;
  let shuffled = false;
  let showQr = true;
  let closed = false;
  let misses = 0;               // consecutive frames that would not load
  let token = 0;                // invalidates an in-flight frame load
  let advanceTimer = null;
  let controlsTimer = null;
  let wakeLock = null;
  let wentFullscreen = false;
  const preloaded = new Set();
  const inerted = [];
  const lastFocused = document.activeElement;

  /* ── chrome ─────────────────────────────────────────────────────── */
  const root = el('div', 'tv');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Slideshow');
  root.dataset.variant = variant;
  root.dataset.controls = 'on';
  root.tabIndex = -1;

  const stage = el('div', 'tv-stage');
  const layers = [0, 1].map(() => {
    const layerRoot = el('div', 'tv-layer');
    const blur = el('div', 'tv-blur');
    const img = el('img', 'tv-photo');
    img.alt = '';
    img.decoding = 'async';
    layerRoot.append(blur, img);
    stage.appendChild(layerRoot);
    return { root: layerRoot, blur, img };
  });

  const scrim = el('div', 'tv-scrim');
  scrim.setAttribute('aria-hidden', 'true');

  const meta = el('div', 'tv-meta');
  const captionNode = el('p', 'tv-caption');
  captionNode.hidden = true;
  const byNode = el('p', 'tv-by');
  meta.append(captionNode, byNode);

  const note = el('p', 'tv-note');
  note.hidden = true;

  /* corner card: QR + label (+ PIN for the gallery variant) */
  const card = el('aside', 'tv-card');
  const qrCanvas = el('canvas', 'tv-qr');
  qrCanvas.setAttribute('aria-hidden', 'true');
  const qrLabel = el('p', 'tv-qr-label', (qr && qr.label) || '');
  card.append(qrCanvas, qrLabel);
  const pin = qr && typeof qr.pin === 'string' ? qr.pin.trim() : '';
  if (pin) {
    const pinRow = el('p', 'tv-pin');
    pinRow.append(el('span', 'tv-pin-word', 'PIN'), el('span', 'tv-pin-digits', pin));
    card.appendChild(pinRow);
  }
  card.setAttribute('aria-label', pin
    ? `${qrLabel.textContent}. PIN ${pin}.`
    : qrLabel.textContent);

  /* controls */
  const controls = el('div', 'tv-controls');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Slideshow controls');
  const prevBtn = iconButton('prev', 'Previous photo');
  const playBtn = iconButton('pause', 'Pause slideshow');
  const nextBtn = iconButton('next', 'Next photo');
  const shuffleBtn = iconButton('shuffle', 'Shuffle');
  shuffleBtn.setAttribute('aria-pressed', 'false');
  const qrBtn = iconButton('qr', 'Hide the QR card');
  qrBtn.setAttribute('aria-pressed', 'true');
  const counter = el('p', 'tv-count');
  const exitBtn = iconButton('exit', 'Exit slideshow', 'tv-btn tv-exit');
  exitBtn.appendChild(el('span', null, 'Exit'));
  controls.append(prevBtn, playBtn, nextBtn, shuffleBtn, qrBtn, counter, exitBtn);

  root.append(stage, scrim, meta, note, card, controls);

  /* ── ordering ───────────────────────────────────────────────────── */
  function indexOfCurrent() {
    return currentUuid ? order.indexOf(currentUuid) : -1;
  }

  function updateCounter() {
    const at = indexOfCurrent();
    counter.textContent = order.length ? `${at < 0 ? 1 : at + 1} / ${order.length}` : '0 / 0';
  }

  /** Keeps the shuffled order stable, dropping hidden frames and slipping new
   *  ones in somewhere ahead of the frame currently on screen. */
  function mergeShuffled(previous) {
    const kept = previous.filter((uuid) => byUuid.has(uuid));
    const known = new Set(kept);
    const at = Math.max(0, kept.indexOf(currentUuid));
    for (const uuid of chrono) {
      if (known.has(uuid)) continue;
      const span = Math.max(1, kept.length - at);
      const pos = Math.min(kept.length, at + 1 + Math.floor(Math.random() * span));
      kept.splice(pos, 0, uuid);
      known.add(uuid);
    }
    return kept;
  }

  function shuffleAll() {
    const list = [...chrono];
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    // Whatever is on screen stays on screen — it simply becomes the new "here".
    if (currentUuid && list.includes(currentUuid)) {
      list.splice(list.indexOf(currentUuid), 1);
      list.unshift(currentUuid);
    }
    return list;
  }

  /** New frames join in order without interrupting the one on screen. */
  function applyPhotos(list) {
    const sorted = [...(list || [])].filter((p) => p && p.uuid && imagePathOf(p))
      .sort((a, b) => timeOf(a) - timeOf(b));
    byUuid = new Map(sorted.map((p) => [p.uuid, p]));
    chrono = sorted.map((p) => p.uuid);
    const previousAt = indexOfCurrent();
    order = shuffled ? mergeShuffled(order) : chrono.slice();

    if (order.length === 0) {
      token += 1;
      currentUuid = null;
      stopAdvance();
      showNote('Waiting for photos…');
      updateCounter();
      return;
    }
    note.hidden = true;
    if (!currentUuid) { present(order[0]); return; }
    if (!byUuid.has(currentUuid)) {
      // The frame on screen was just hidden — step to whatever took its place.
      present(order[Math.min(Math.max(previousAt, 0), order.length - 1)]);
      return;
    }
    updateCounter();
    // The frame after this one may be new: warm it up.
    preloadAhead();
  }

  /* ── frames ─────────────────────────────────────────────────────── */
  function showNote(text) {
    note.textContent = text;
    note.hidden = false;
  }

  function paintMeta(photo) {
    const caption = captionOf(photo); // GALLERY-007, in the couple's voice
    captionNode.textContent = caption;
    captionNode.hidden = caption === '';
    byNode.textContent = byLine(photo);
  }

  function loadInto(img, url) {
    return new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('frame failed to load'));
      img.src = url;
    });
  }

  function swapTo(layer) {
    kbFlip = !kbFlip;
    // Same layer gets the same direction every other frame, so restart by hand.
    layer.img.style.animation = 'none';
    void layer.img.offsetWidth;
    layer.img.style.animation = '';
    layer.root.dataset.kb = kbFlip ? 'a' : 'b';
    layer.root.classList.add('is-on');
    layers[frontLayer].root.classList.remove('is-on');
    frontLayer = layers.indexOf(layer);
  }

  function preloadAhead() {
    const at = indexOfCurrent();
    if (at < 0) return;
    for (let step = 1; step <= PRELOAD_AHEAD; step += 1) {
      const uuid = order[(at + step) % order.length];
      const photo = byUuid.get(uuid);
      const path = imagePathOf(photo);
      if (!path || preloaded.has(path)) continue;
      preloaded.add(path);
      imageUrlFor(path).then((url) => { new Image().src = url; })
        .catch(() => { preloaded.delete(path); });
    }
  }

  async function present(uuid) {
    const mine = ++token;
    const photo = byUuid.get(uuid);
    if (!photo) return;
    currentUuid = uuid;
    updateCounter();
    stopAdvance();
    const back = layers[1 - frontLayer];
    try {
      const url = await imageUrlFor(imagePathOf(photo));
      if (closed || mine !== token) return;
      await loadInto(back.img, url);
      if (closed || mine !== token) return;
      back.blur.style.backgroundImage = `url("${url.replace(/["\\]/g, '\\$&')}")`;
      misses = 0;
      note.hidden = true;
      paintMeta(photo);
      swapTo(back);
      scheduleAdvance();
      preloadAhead();
    } catch (error) {
      if (closed || mine !== token) return;
      console.warn('slideshow frame unavailable', uuid, error);
      misses += 1;
      if (misses >= Math.min(order.length, 6)) {
        showNote('These photos are not loading right now.');
        return;
      }
      advanceTimer = setTimeout(() => go(1), RETRY_MS);
    }
  }

  function go(delta) {
    if (order.length === 0) return;
    const at = indexOfCurrent();
    const from = at < 0 ? 0 : at;
    const next = (from + delta + order.length) % order.length;
    present(order[next]);
  }

  function stopAdvance() {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  }

  function scheduleAdvance() {
    stopAdvance();
    if (paused || order.length < 2) return;
    advanceTimer = setTimeout(() => go(1), intervalMs);
  }

  /* ── controls ───────────────────────────────────────────────────── */
  function setPaused(next) {
    paused = next;
    playBtn.textContent = '';
    playBtn.appendChild(icon(...(paused ? ICONS.play : ICONS.pause)));
    playBtn.setAttribute('aria-label', paused ? 'Play slideshow' : 'Pause slideshow');
    playBtn.setAttribute('aria-pressed', String(paused));
    if (paused) stopAdvance();
    else scheduleAdvance();
    wakeControls();
  }

  function setShuffled(next) {
    shuffled = next;
    shuffleBtn.setAttribute('aria-pressed', String(shuffled));
    shuffleBtn.setAttribute('aria-label', shuffled ? 'Shuffle on' : 'Shuffle');
    order = shuffled ? shuffleAll() : chrono.slice();
    updateCounter();
    preloadAhead();
    wakeControls();
  }

  function setQrVisible(next) {
    showQr = next;
    card.hidden = !showQr;
    qrBtn.setAttribute('aria-pressed', String(showQr));
    qrBtn.setAttribute('aria-label', showQr ? 'Hide the QR card' : 'Show the QR card');
    wakeControls();
  }

  function wakeControls() {
    if (closed) return;
    root.dataset.controls = 'on';
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => {
      if (!closed) root.dataset.controls = 'off';
    }, CONTROLS_MS);
  }

  prevBtn.addEventListener('click', () => { go(-1); wakeControls(); });
  nextBtn.addEventListener('click', () => { go(1); wakeControls(); });
  playBtn.addEventListener('click', () => setPaused(!paused));
  shuffleBtn.addEventListener('click', () => setShuffled(!shuffled));
  qrBtn.addEventListener('click', () => setQrVisible(!showQr));
  exitBtn.addEventListener('click', () => close());

  for (const type of ['mousemove', 'pointerdown', 'touchstart', 'wheel']) {
    root.addEventListener(type, wakeControls, { passive: true });
  }

  /* Space pause · ←/→ step · S shuffle · Q QR · Esc exit.
   * Capture phase so the host page's own Escape handlers stay out of it. */
  function onKeyDown(event) {
    if (closed) return;
    const handled = {
      ' ': () => setPaused(!paused),
      Spacebar: () => setPaused(!paused),
      ArrowLeft: () => { go(-1); wakeControls(); },
      ArrowRight: () => { go(1); wakeControls(); },
      s: () => setShuffled(!shuffled),
      S: () => setShuffled(!shuffled),
      q: () => setQrVisible(!showQr),
      Q: () => setQrVisible(!showQr),
      Escape: () => close(),
    }[event.key];
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
    handled();
  }

  /* ── QR code (qrcode → canvas, error correction M) ──────────────── */
  function qrSize() {
    const edge = Math.min(window.innerWidth || 0, window.innerHeight || 0) || 600;
    return Math.round(Math.min(QR_MAX, Math.max(QR_MIN, edge * QR_RATIO)));
  }

  let qrDrawn = 0;
  function drawQr() {
    const target = qrSize();
    if (!qr || !qr.url || target === qrDrawn) return;
    qrDrawn = target;
    QRCode.toCanvas(qrCanvas, qr.url, {
      width: target,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: QR_DARK, light: QR_LIGHT },
    }).catch((error) => {
      qrDrawn = 0;
      console.warn('QR code could not be drawn', error);
      card.hidden = true; // a broken card is worse than no card
    });
  }

  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawQr, 180);
  }

  /* ── screen wake lock ───────────────────────────────────────────── */
  async function acquireWakeLock() {
    try {
      if (!navigator.wakeLock || closed || document.visibilityState !== 'visible') return;
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {
      wakeLock = null; // unsupported or refused — the show still runs
    }
  }

  function releaseWakeLock() {
    const held = wakeLock;
    wakeLock = null;
    if (held) held.release().catch(() => { /* already gone */ });
  }

  function onVisibility() {
    if (closed) return;
    if (document.visibilityState === 'visible' && !wakeLock) acquireWakeLock();
  }

  /* ── fullscreen ─────────────────────────────────────────────────── */
  function onFullscreenChange() {
    // The browser eats Escape while fullscreen, so leaving it means "exit".
    if (wentFullscreen && !document.fullscreenElement) close();
  }

  async function enterFullscreen() {
    try {
      if (!root.requestFullscreen || document.fullscreenElement) return;
      await root.requestFullscreen({ navigationUI: 'hide' });
      wentFullscreen = true;
    } catch {
      wentFullscreen = false; // a fixed overlay is the fallback, and it is fine
    }
  }

  /* ── open / close ───────────────────────────────────────────────── */
  function setBackgroundInert(on) {
    if (!('inert' in HTMLElement.prototype)) return;
    if (on) {
      for (const node of document.body.children) {
        if (node === root || node.inert) continue;
        node.inert = true;
        inerted.push(node);
      }
      return;
    }
    for (const node of inerted) node.inert = false;
    inerted.length = 0;
  }

  let unsubscribe = null;

  function close() {
    if (closed) return;
    closed = true;
    active = null;
    token += 1;
    stopAdvance();
    clearTimeout(controlsTimer);
    clearTimeout(resizeTimer);
    if (unsubscribe) { try { unsubscribe(); } catch { /* already gone */ } }
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    window.removeEventListener('resize', onResize);
    releaseWakeLock();
    if (wentFullscreen && document.fullscreenElement) {
      document.exitFullscreen().catch(() => { /* already left */ });
    }
    wentFullscreen = false;
    setBackgroundInert(false);
    document.body.style.overflow = bodyOverflow;
    root.remove();
    if (lastFocused && document.contains(lastFocused)) {
      lastFocused.focus({ preventScroll: true });
    }
    if (typeof onClose === 'function') onClose();
  }

  const bodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden'; // no horizontal scroll on a TV
  document.body.appendChild(root);
  setBackgroundInert(true);

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  window.addEventListener('resize', onResize);

  root.focus({ preventScroll: true });
  drawQr();
  enterFullscreen();
  acquireWakeLock();
  wakeControls();

  unsubscribe = photos$((list) => { if (!closed) applyPhotos(list); });

  active = { close };
  return active;
}
