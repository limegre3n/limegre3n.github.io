/**
 * Guest state machine (workstream ① — contract: docs/CONTRACTS.md §7).
 *
 * States: loading → welcome → viewfinder ⇄ capturing, overlays pendingBadge /
 * offlineBadge, terminals noSnaps / notStarted / ended / paused / invalidLink /
 * permissionDenied / cameraUnavailable.
 *
 * Owns the 90s film-disposable presentation (PRD D16): plastic chassis, film
 * counter window, wind-on animation and a WebAudio-synthesised shutter — no
 * image, font or audio assets are loaded (NFR payload budget).
 *
 * Never renders a captured frame (CAMERA-004 / D7): the only feedback is the
 * exposure counter, the wind-on blackout and the shutter sound.
 */
import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import {
  doc, getDoc, setDoc, onSnapshot, serverTimestamp, updateDoc,
} from 'firebase/firestore';
import { auth, db } from '../lib/firebase.js';
import { applyTheme } from '../lib/theme.js';
import { Camera, reencodeFile } from './camera.js';
import { mountZoomControl } from './zoom-ui.js';
import { queue } from './queue.js';
import {
  currentStockId, mountDateStamp, mountFilm, tzOffsetMinutes,
} from './film-ui.js';

const appEl = document.getElementById('app');
const liveEl = document.getElementById('live');

/** ~0.8s wind-on lockout after every shutter press (CAMERA-003). */
const WIND_ON_MS = 800;
/** Screen-flash duration for the front camera (CONTRACTS §8). */
const SCREEN_FLASH_MS = 300;
const FLASH_PRE_MS = 140;
/** Give up on the in-page viewfinder and offer the phone camera after this long. */
const CAMERA_START_TIMEOUT_MS = 10_000;

const state = {
  slug: null,
  cfg: null,
  device: null,
  uid: null,
  camera: null,
  view: null,           // logical view currently mounted
  cameraError: rememberedCameraBlock() ? 'permissionDenied' : null, // 'permissionDenied' | 'cameraUnavailable' | null
  cameraReady: false,   // stream live and delivering frames
  bootError: false,
  locked: false,        // shutter lockout in progress
  routeQueued: false,
  flashArmed: false,
  torchOn: false,
  zoom: null,           // zoom-ui.js handle; the magnification lives on the Camera
  ephemeralToasted: false,
  cleanups: [],
  lastAnnounced: '',
};

/* ------------------------------------------------------------------ utils */

function slugFromPath() {
  const m = /^\/e\/([A-Za-z0-9]+)\/?$/.exec(location.pathname);
  return m ? m[1] : null;
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    node.setAttribute(k, v === true ? '' : v);
  }
  if (text !== undefined) node.textContent = text; // textContent only (CONTRACTS §9)
  return node;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setDomState(name) {
  appEl.dataset.state = name;
}

function announce(message) {
  if (!liveEl || message === state.lastAnnounced) return;
  state.lastAnnounced = message;
  liveEl.textContent = message;
}

function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  state.cleanups.push(() => target.removeEventListener(type, handler, options));
}

function teardown() {
  const fns = state.cleanups.splice(0);
  for (const fn of fns) { try { fn(); } catch { /* ignore */ } }
}

function pad2(n) {
  return String(Math.max(0, n)).padStart(2, '0');
}

function haptic(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}

/* A browser that refused the camera prompt once (blocked permission, or Android's
 * "can't ask while another app draws over the screen") will refuse again on every
 * visit. Remember it per phone so we lead with the phone-camera path silently; the
 * fallback card's Try-again clears the memory and re-requests. Storage failures are
 * ignored — this is a convenience, never a gate. */
const CAMERA_BLOCK_KEY = 'wc.cameraBlocked';
function rememberedCameraBlock() {
  try { return localStorage.getItem(CAMERA_BLOCK_KEY) === '1'; } catch { return false; }
}
function rememberCameraBlock(blocked) {
  try {
    if (blocked) localStorage.setItem(CAMERA_BLOCK_KEY, '1');
    else localStorage.removeItem(CAMERA_BLOCK_KEY);
  } catch { /* ignore */ }
}

function platform() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/* ------------------------------------------------- contrast-safe theming */
/* Theme colours are couple-chosen (CONTRACTS §9) and may land anywhere in the
 * gamut, so derive ink tokens that still clear WCAG AA on the dark chassis.  */

const SHELL_RGB = [0x22, 0x1e, 0x1a];
const RECESS_RGB = [0x0c, 0x0a, 0x09];

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

/** Nudge `colour` toward white/black until it clears `ratio` against `bg`. */
function ensureContrast(colour, bg, ratio) {
  const target = luminance(bg) > 0.4 ? [0, 0, 0] : [255, 255, 255];
  let out = colour;
  for (let i = 0; i <= 10 && contrast(out, bg) < ratio; i += 1) {
    out = mix(colour, target, i / 10);
  }
  return out;
}

function refreshInkTokens() {
  try {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const accent = parseColor(cs.getPropertyValue('--c-accent')) || [0xe8, 0xb0, 0x4b];
    const text = parseColor(cs.getPropertyValue('--c-text')) || [0xf5, 0xef, 0xe6];

    // Body copy on plastic: keep the couple's text colour when it is legible.
    root.style.setProperty('--ink', contrast(text, SHELL_RGB) >= 4.5 ? css(text) : '#f4efe8');
    // Accent used as ink (counter digits, monogram) inside the sunken window.
    root.style.setProperty('--accent-ink', css(ensureContrast(accent, RECESS_RGB, 4.5)));
    // Label colour on top of an accent fill (shutter, primary button).
    const onAccent = contrast(accent, [0x12, 0x0f, 0x0c]) >= contrast(accent, [255, 253, 248])
      ? '#120f0c' : '#fffdf8';
    root.style.setProperty('--c-on-accent', onAccent);
  } catch { /* styling only — never block the camera */ }
}

/**
 * iOS Safari tints its toolbar and status bar from <meta name="theme-color">.
 * Painting it with the couple's background makes the browser chrome blend into
 * the camera chassis (with viewport-fit=cover + black-translucent in index.html).
 * Theming stays config-only (D19): the value is the already-validated hex from
 * config/event.theme.colors.bg — anything else is ignored.
 */
function paintBrowserChrome() {
  try {
    const bg = state.cfg?.theme?.colors?.bg;
    if (!/^#[0-9a-fA-F]{3,8}$/.test(String(bg || ''))) return;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bg);
  } catch { /* chrome tint is decoration — never block the camera */ }
}

function paint() {
  if (state.cfg) applyTheme(state.cfg);
  refreshInkTokens();
  paintBrowserChrome();
}

/* --------------------------------------------------------- fullscreen */
/* Android Chrome/Samsung can hide their own chrome; iOS Safari cannot (no
 * element fullscreen). Every call is fire-and-forget: a rejection must never
 * interrupt loading the film or taking a photo, and the native-camera fallback
 * (which drops out of fullscreen when the camera app opens) is left alone.   */

function canFullscreen() {
  const root = document.documentElement;
  return !!(document.fullscreenEnabled && typeof root.requestFullscreen === 'function');
}

function lockPortrait() {
  try {
    const p = globalThis.screen?.orientation?.lock?.('portrait');
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* unsupported outside fullscreen / on iOS */ }
}

function unlockOrientation() {
  try { globalThis.screen?.orientation?.unlock?.(); } catch { /* unsupported */ }
}

/** Must be called synchronously inside a user gesture (tap) to be granted. */
function requestImmersive() {
  if (!canFullscreen() || document.fullscreenElement) return;
  try {
    const p = document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    if (p && typeof p.then === 'function') p.then(lockPortrait, () => {});
    else lockPortrait();
  } catch { /* denied — carry on exactly as before */ }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) unlockOrientation();
});

function mount(...children) {
  appEl.replaceChildren(...children);
  paint();
}

/* ------------------------------------------------------------ shutter SFX */
/* Mechanical click + film-advance ratchet, synthesised on the fly. No audio
 * files (payload budget); silently degrades where WebAudio is unavailable.   */

const sfx = {
  ctx: null,
  noise: null,

  arm() {
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return null;
      if (!this.ctx) this.ctx = new AC();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      if (!this.noise) {
        const len = Math.floor(this.ctx.sampleRate * 0.6);
        const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
        this.noise = buf;
      }
      return this.ctx;
    } catch {
      return null;
    }
  },

  burst(dest, at, { dur = 0.02, gain = 0.4, freq = 3000, q = 1, type = 'bandpass' } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(filter).connect(g).connect(dest);
    src.start(at, Math.random() * 0.3, dur + 0.02);
    src.stop(at + dur + 0.05);
  },

  /** Shutter clack + body thunk + wind-on ratchet, ~0.7s (fits the lockout). */
  shutter() {
    const ctx = this.arm();
    if (!ctx) return;
    try {
      const master = ctx.createGain();
      master.gain.value = 0.85;
      master.connect(ctx.destination);
      const t0 = ctx.currentTime + 0.01;

      // Leaf-shutter open/close: two bright transients.
      this.burst(master, t0, { dur: 0.012, gain: 0.75, freq: 4300, q: 0.6 });
      this.burst(master, t0 + 0.02, { dur: 0.03, gain: 0.5, freq: 2100, q: 0.9 });

      // Hollow plastic body resonance.
      const body = ctx.createOscillator();
      const bodyGain = ctx.createGain();
      body.type = 'triangle';
      body.frequency.setValueAtTime(240, t0);
      body.frequency.exponentialRampToValueAtTime(85, t0 + 0.09);
      bodyGain.gain.setValueAtTime(0.0001, t0);
      bodyGain.gain.linearRampToValueAtTime(0.3, t0 + 0.005);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
      body.connect(bodyGain).connect(master);
      body.start(t0);
      body.stop(t0 + 0.12);

      // Thumbwheel ratchet: clicks that slow down as the film winds on.
      let t = t0 + 0.16;
      for (let i = 0; i < 17; i += 1) {
        const step = 0.016 + (i / 17) * 0.018;
        this.burst(master, t, {
          dur: 0.008,
          gain: 0.1 + Math.random() * 0.05,
          freq: 2400 + Math.random() * 1600,
          q: 2.2,
        });
        t += step;
      }
      // Faint mechanical whirr underneath the ratchet.
      this.burst(master, t0 + 0.16, { dur: 0.42, gain: 0.05, freq: 700, q: 0.7, type: 'lowpass' });
    } catch { /* audio is decoration — never break capture */ }
  },
};

/* --------------------------------------------------------- snap accounting */

function totalSnaps() {
  const base = state.cfg?.defaultSnaps ?? 10;
  return base + (state.device?.snapsGranted || 0);
}

/** Authoritative remaining minus in-flight items (CONTRACTS §6.5). */
function snapsLeft() {
  if (!state.device) return 0;
  return Math.max(0, state.device.snapsRemaining - queue.pendingCount);
}

function ephemeralStorage() {
  return queue.persistent === false;
}

/* --------------------------------------------------- gates (CONTRACTS §7) */

function gateState() {
  if (state.bootError) return 'bootError';
  const cfg = state.cfg;
  const now = Date.now();
  if (!cfg || cfg.slug !== state.slug) return 'invalidLink';
  if (cfg.startAt?.toMillis && now < cfg.startAt.toMillis()) return 'notStarted';
  if (cfg.endAt?.toMillis && now > cfg.endAt.toMillis()) return 'ended';
  if (cfg.paused) return 'paused';
  if (!state.device) return 'welcome';
  if (state.cameraError) return state.cameraError;
  if (snapsLeft() <= 0) return 'noSnaps';
  return 'viewfinder';
}

/** Hook the active view uses to refresh counter/badges without re-rendering. */
let refreshChrome = () => {};
/** Guard so a snapshot arriving mid-render can never interleave two views. */
let routing = false;

async function route(force = false) {
  if (state.locked || routing) { state.routeQueued = true; return; }
  const want = gateState();
  if (want === state.view && !force) { refreshChrome(); return; }

  routing = true;
  try {
    teardown();
    refreshChrome = () => {};
    if (want !== 'viewfinder') { state.camera?.dispose(); state.camera = null; }
    state.view = want;

    switch (want) {
      case 'welcome': renderWelcome(); break;
      case 'viewfinder': await renderViewfinder(); break;
      case 'noSnaps': renderNoSnaps(); break;
      case 'permissionDenied':
      case 'cameraUnavailable': renderCameraFallback(want); break;
      default: renderTerminal(want);
    }
  } finally {
    routing = false;
  }
  if (state.routeQueued && !state.locked) { state.routeQueued = false; await route(); }
}

/* --------------------------------------------------------------- fragments */

function badgeRow() {
  const wrap = el('div', { class: 'vf__badges' });
  const pending = el('span', { class: 'badge badge--pending', hidden: true });
  const offline = el('span', { class: 'badge badge--offline', hidden: true });
  const warn = el('span', { class: 'badge badge--warn', hidden: true });
  wrap.append(offline, pending, warn);
  return { wrap, pending, offline, warn };
}

/** Shared badge logic: pending count (UPLOAD-005), offline, ephemeral notice. */
function updateBadges(badges) {
  const pending = queue.pendingCount;
  const online = navigator.onLine !== false;
  badges.pending.hidden = pending === 0 || !online;
  badges.pending.textContent = `${pending} sending…`;
  badges.offline.hidden = online;
  badges.offline.textContent = pending > 0
    ? `${pending} will send when signal returns`
    : 'Offline — keep snapping, we’ll send later';
  badges.warn.hidden = !(ephemeralStorage() && pending > 0);
  badges.warn.textContent = 'Keep this page open until photos send';
}

function cardShell(extraClass = '') {
  const card = el('div', { class: `card plastic ${extraClass}`.trim() });
  const inner = el('div', { class: 'card__inner' });
  card.append(el('div', { class: 'card__strip' }), inner);
  return { card, inner };
}

function coupleHeader(inner, { monogram = true } = {}) {
  if (monogram) inner.append(el('div', { class: 'monogram', 'data-theme-monogram': true }));
  inner.append(el('h1', { 'data-theme-couple-names': true }));
  inner.append(el('p', { class: 'card__date', 'data-theme-event-date': true }));
  inner.append(el('div', { class: 'card__rule' }));
}

function nativeCaptureControl(onBlob) {
  const label = el('label', { class: 'native' });
  label.append(el('span', {}, '📷 Use my phone’s camera'));
  const input = el('input', {
    type: 'file', accept: 'image/*', capture: 'environment', class: 'sr-only',
  });
  label.append(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (snapsLeft() <= 0) { onBlob(null, 'no-film'); return; }
    let blob = null;
    try { blob = await reencodeFile(file); } catch { /* handled below */ }
    if (!blob) { onBlob(null, 'encode'); return; }
    try {
      await queue.enqueue(blob, Date.now());
      onBlob(blob);
    } catch { onBlob(null, 'queue'); }
  });
  return label;
}

/* ------------------------------------------------------------ loading view */

function renderLoading() {
  state.view = 'loading';
  setDomState('loading');
  const boot = el('div', { class: 'boot', role: 'status' });
  boot.append(
    el('div', { class: 'boot__body' }, undefined),
    el('p', { class: 'boot__label' }, 'Loading the camera…'),
  );
  boot.firstChild.append(el('span', { class: 'boot__lens' }));
  mount(boot);
  announce('Loading the camera');
}

/* ------------------------------------------------- welcome (GUEST-002) */

function renderWelcome() {
  setDomState('welcome');
  const snaps = state.cfg?.defaultSnaps ?? 10;

  const page = el('div', { class: 'page plastic' });
  page.append(el('div', { class: 'page__leader' }));

  // Header band — monogram, names, date. Names are the only large element.
  const brand = el('header', { class: 'brand' });
  brand.append(
    el('span', { class: 'brand__mono', 'data-theme-monogram': true }),
    el('h1', { class: 'brand__names', 'data-theme-couple-names': true }),
    el('p', { class: 'brand__date', 'data-theme-event-date': true }),
  );

  const sheet = el('div', { class: 'sheet' });
  sheet.append(el('p', { class: 'welcome', 'data-theme-welcome-text': true }));

  // Three-step explainer — this is where the roll size lives now (no chip).
  const steps = el('ol', { class: 'steps3' });
  for (const [num, label] of [['1', 'Scan'], ['2', `Snap ${snaps}`], ['3', 'See them after the wedding']]) {
    const item = el('li');
    item.append(
      el('span', { class: 'steps3__num', 'aria-hidden': 'true' }, num),
      el('span', { class: 'steps3__label' }, label),
    );
    steps.append(item);
  }
  sheet.append(steps);

  const form = el('form', { class: 'form', novalidate: true });
  const field = el('div', { class: 'field' });
  const inputId = 'guest-nickname';
  const label = el('label', { class: 'field__label label-caps', for: inputId }, 'Your name');
  const input = el('input', {
    id: inputId,
    type: 'text',
    maxlength: '30',
    autocomplete: 'off',
    autocapitalize: 'words',
    spellcheck: 'false',
    enterkeyhint: 'go',
    placeholder: 'e.g. Auntie May',
    'aria-describedby': 'nickname-error consent-note',
  });
  const error = el('p', { class: 'field__error', id: 'nickname-error', role: 'alert' });
  field.append(label, input, error);
  const submit = el('button', { type: 'submit', class: 'btn btn--primary' }, 'Load the film');
  form.append(field, submit);
  sheet.append(form);

  page.append(brand, sheet);
  page.append(el('p', { class: 'consent', id: 'consent-note', 'data-theme-consent-text': true }));
  mount(page);
  announce('Enter your name to start');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // Fullscreen is requested on the first shutter tap instead (camera already live),
    // so it can never interfere with the browser's camera-permission prompt.
    sfx.arm();
    const nickname = input.value.trim().slice(0, 30);
    if (!nickname) {
      error.textContent = 'Pop your name in first so the couple knows who snapped it.';
      input.focus();
      return;
    }
    error.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Loading the film…';
    const deviceRef = doc(db, 'devices', state.uid);
    try {
      await setDoc(deviceRef, {
        nickname,
        snapsRemaining: state.cfg.defaultSnaps,
        snapsGranted: 0,
        createdAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
        consentShownAt: serverTimestamp(),
      });
      state.device = { nickname, snapsRemaining: state.cfg.defaultSnaps, snapsGranted: 0 };
    } catch (err) {
      console.error('device-create-failed', err);
      // A previous attempt may already have registered this phone (create is one-shot in
      // the rules) — if so, carry on instead of showing a dead-end error.
      const existing = await getDoc(deviceRef).catch(() => null);
      if (existing?.exists()) {
        state.device = existing.data();
      } else {
        submit.disabled = false;
        submit.textContent = 'Load the film';
        const code = err?.code || err?.name || 'unknown';
        const now = Date.now();
        const closed = state.cfg?.startAt && state.cfg?.endAt
          && (now < state.cfg.startAt.toMillis() || now > state.cfg.endAt.toMillis());
        error.textContent = code === 'permission-denied'
          ? (closed
            ? 'The camera isn’t open right now — please try again once the celebration starts.'
            : 'The camera isn’t accepting new guests right now. Please show this to the couple: '
              + 'check the opening and closing times in the event settings. (permission-denied)')
          : `Something went wrong — please try again. (${code})`;
        return;
      }
    }

    // Past this point the phone is registered; a camera/render problem must not be
    // reported as a registration failure (the fallback views handle camera errors).
    try {
      watchDevice();
      await route();
    } catch (err) {
      console.error('post-register-route-failed', err);
      submit.disabled = false;
      submit.textContent = 'Load the film';
      error.textContent = `You’re in — but the camera view hit a snag. Reload the page to continue. (${err?.name || 'error'})`;
    }
  });
}

/* -------------------------------------------------------- viewfinder view */

async function renderViewfinder() {
  setDomState('viewfinder');

  const vf = el('div', { class: 'vf' });
  const stage = el('div', { class: 'vf__stage' });
  const video = el('video', {
    class: 'vf__video', playsinline: true, autoplay: true, muted: true,
    'aria-hidden': 'true',
  });
  video.muted = true;
  const wash = el('div', { class: 'vf__wash' });
  const grain = el('div', { class: 'vf__grain' });
  const glass = el('div', { class: 'vf__glass' });
  const flash = el('div', { class: 'vf__flash' });
  const blackout = el('div', { class: 'vf__blackout' });
  const wind = el('div', { class: 'vf__wind' });
  wind.append(el('div', { class: 'vf__sprockets' }), el('div', { class: 'vf__sprockets' }));

  // Badges live top-left on the glass; nothing else competes with the counter.
  const rail = el('div', { class: 'vf__rail' });
  const badges = badgeRow();
  rail.append(badges.wrap);

  stage.append(video, wash, grain, glass);
  for (const c of ['tl', 'tr', 'bl', 'br']) stage.append(el('div', { class: `vf__bracket vf__bracket--${c}` }));
  // Film date-print in the corner of the frame, not a badge on the chrome.
  stage.append(el('span', { class: 'vf__stamp', 'data-theme-monogram': true, 'aria-hidden': 'true' }));
  stage.append(blackout, wind, flash, rail);

  /* ---- deck (bottom third, one-handed reach) ---- */
  const deck = el('div', { class: 'deck plastic' });

  // One chassis bar: counter window left, secondary control right, same height.
  const bar = el('div', { class: 'deck__bar' });
  const counter = el('div', { class: 'counter recess' });
  const dial = el('span', { class: 'counter__dial', 'aria-hidden': 'true' });
  const digits = el('span', { class: 'counter__digits digits', 'aria-hidden': 'true' });
  const counterLabel = el('span', { class: 'counter__label label-caps', 'aria-hidden': 'true' }, 'exposures left');
  counter.append(dial, digits, counterLabel);
  bar.append(counter);

  const row = el('div', { class: 'deck__row' });
  const leftSlot = el('div', { class: 'deck__slot deck__slot--left' });
  const rightSlot = el('div', { class: 'deck__slot deck__slot--right' });
  const flipBtn = el('button', {
    type: 'button', class: 'ctl', 'aria-label': 'Switch to front camera',
  }, '⟳');
  const shutter = el('button', {
    type: 'button', class: 'shutter', 'aria-label': 'Take photo',
  });
  const flashBtn = el('button', {
    type: 'button', class: 'ctl', 'aria-label': 'Flash off', 'aria-pressed': 'false',
  }, '⚡');
  // CAMERA-010: zoom is a step-less lens slider, not a stepping button, so it
  // gets its own full-width row between the chassis bar and the shutter — always
  // thumb-reachable, never overlapping the shutter. zoom-ui.js fills this host.
  const zoomHost = el('div', { class: 'deck__zoom' });
  leftSlot.append(flipBtn);
  row.append(leftSlot, shutter, rightSlot);
  deck.append(bar, zoomHost, row);

  /**
   * The control row is [flip] [shutter] [flash]. The flash button appears only
   * where flash exists (front camera, or a torch-capable rear track); the right
   * slot is otherwise left empty so the shutter stays centred under the thumb.
   */
  function layoutControls(flashAvailable) {
    if (flashAvailable) {
      if (flashBtn.parentElement !== rightSlot) rightSlot.append(flashBtn);
    } else if (flashBtn.parentElement) {
      flashBtn.remove();
    }
  }
  layoutControls(false); // torch capability is unknown until the stream is live

  vf.append(stage, deck);
  // CAMERA-011: the film dial sits between the frame and the chassis, and owns the
  // live look (video `filter` + grain/vignette layers) — never the video transform.
  const film = mountFilm({ host: vf, stage, video, before: deck });
  state.cleanups.push(film.destroy);
  mount(vf);

  /* ---- chrome refresh ---- */
  let toastTimer = null;
  function toast(message) {
    const node = el('div', { class: 'toast', role: 'status' }, message);
    stage.querySelector('.toast')?.remove();
    stage.append(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), 3200);
  }
  state.cleanups.push(() => clearTimeout(toastTimer));

  refreshChrome = () => {
    const left = snapsLeft();
    const total = totalSnaps();
    digits.textContent = `${pad2(left)}/${pad2(total)}`;
    updateBadges(badges);
    // Never armed before the stream delivers frames — a tap then would throw
    // camera-not-ready and look like a lost shot.
    shutter.disabled = state.locked || left <= 0 || !state.cameraReady;
    announce(`${left} of ${total} exposures left`);
  };

  refreshChrome(); // fill the counter window before the stream warms up

  // CAMERA-012: quartz date-back preview, live with config/event.dateStamp (which
  // may be absent = on). Preview only — the capture draws the video, not the DOM.
  const stamp = mountDateStamp(stage, () => state.cfg?.dateStamp !== false);
  const chromeWithoutStamp = refreshChrome;
  refreshChrome = () => { chromeWithoutStamp(); stamp.update(); };
  state.cleanups.push(stamp.destroy);

  on(queue, 'change', (e) => {
    const detail = e.detail || {};
    if (detail.rejection) handleRejection(detail.rejection, toast);
    refreshChrome();
    if (!state.locked) route();
  });
  on(globalThis, 'online', () => { refreshChrome(); });
  on(globalThis, 'offline', () => { refreshChrome(); });

  if (ephemeralStorage() && !state.ephemeralToasted) {
    toast('Private browsing: keep this page open until your photos send.');
    state.ephemeralToasted = true;
  }

  /* ---- camera acquisition (CONTRACTS §8) ---- */
  state.cameraReady = false;
  appEl.dataset.camera = 'starting';
  state.camera = new Camera(video);
  try {
    // A permission prompt that Android refuses to display can leave getUserMedia
    // pending indefinitely; never strand the guest on a black viewfinder.
    await Promise.race([
      state.camera.start(),
      new Promise((_, reject) => setTimeout(
        () => reject(Object.assign(new Error('camera-start-timeout'), { name: 'TimeoutError' })),
        CAMERA_START_TIMEOUT_MS,
      )),
    ]);
  } catch (err) {
    console.warn('camera-start-failed', err?.name || err);
    state.cameraError = err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
      ? 'permissionDenied' : 'cameraUnavailable';
    if (state.cameraError === 'permissionDenied') rememberCameraBlock(true);
    appEl.dataset.camera = 'off';
    await route();
    return;
  }
  state.cameraError = null;
  state.cameraReady = true;
  appEl.dataset.camera = 'live';
  announce('Camera ready');
  state.cleanups.push(() => { appEl.dataset.camera = 'off'; state.cameraReady = false; });
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshChrome();
  });

  /* ---- flash: torch on rear when capable, screen-flash on front ---- */
  function syncFlashBtn() {
    const front = state.camera.facingMode === 'user';
    layoutControls(front || !!state.camera.supportsTorch);
    flashBtn.classList.toggle('on', state.flashArmed);
    flashBtn.setAttribute('aria-pressed', String(state.flashArmed));
    flashBtn.setAttribute('aria-label', state.flashArmed
      ? (front ? 'Screen flash on' : 'Flash on')
      : (front ? 'Screen flash off' : 'Flash off'));
    flipBtn.setAttribute('aria-label', front ? 'Switch to rear camera' : 'Switch to front camera');
  }

  async function applyFlashState() {
    const front = state.camera.facingMode === 'user';
    state.torchOn = !front && state.flashArmed;
    if (!front) await state.camera.setTorch(state.torchOn).catch(() => {});
    syncFlashBtn();
  }
  syncFlashBtn();

  flashBtn.addEventListener('click', async () => {
    sfx.arm();
    state.flashArmed = !state.flashArmed;
    await applyFlashState();
  });

  flipBtn.addEventListener('click', async () => {
    if (state.locked) return;
    sfx.arm();
    flipBtn.disabled = true;
    state.cameraReady = false;
    refreshChrome();
    try {
      // Camera.flip() swaps in the ladder for that side and restores the
      // magnification the guest last chose there (CAMERA-010).
      await state.camera.flip();
      state.zoom?.refresh();
      await applyFlashState();
    } catch (err) {
      toast('Couldn’t switch camera.');
    }
    state.cameraReady = !!state.camera?.stream;
    flipBtn.disabled = false;
    refreshChrome();
  });

  /* ---- zoom: step-less lens slider (CAMERA-006 / CAMERA-010) ----
   * The Camera owns the ladder (which lens 1× really is) and the magnification;
   * zoom-ui.js owns the slider, the pinch gesture and the ?diag=1 sheet. The
   * default is always 1× — the phone's main wide lens, never the ultra-wide. */
  state.zoom = mountZoomControl({
    host: zoomHost,
    camera: state.camera,
    gestureTarget: stage,
    sfx,
    onChange: (mag) => announce(`Zoom ${mag.toFixed(1)} times`),
  });
  state.cleanups.push(() => { state.zoom?.destroy(); state.zoom = null; });

  /* ---- shutter (CAMERA-003 / CAMERA-004: no preview, ever) ---- */
  shutter.addEventListener('click', async () => {
    if (state.locked || snapsLeft() <= 0) return;
    // Returning guests never see the welcome card, so the first shutter tap is
    // their first gesture — and re-asks if they left fullscreen (app switch).
    requestImmersive();
    state.locked = true;
    shutter.disabled = true;
    shutter.dataset.pressed = '1';
    const started = performance.now();
    setDomState('capturing');

    const front = state.camera.facingMode === 'user';
    const useScreenFlash = state.flashArmed && front;
    let blob = null;
    try {
      if (useScreenFlash) {
        flash.classList.add('on');
        await wait(FLASH_PRE_MS);
      }
      sfx.shutter();
      haptic([14, 40, 8]);
      announce('Photo taken, winding on');
      blob = await state.camera.capture();
    } catch (err) {
      console.warn('capture-failed', err);
    } finally {
      if (useScreenFlash) {
        setTimeout(() => flash.classList.remove('on'), Math.max(0, SCREEN_FLASH_MS - FLASH_PRE_MS));
      }
    }

    if (blob) {
      try {
        // IndexedDB before any upload (UPLOAD-001). The bytes stay the clean
        // original; only the stock id and this phone's clock offset ride along
        // as metadata, both captured now, at shot time (CONTRACTS §11).
        await queue.enqueue(blob, Date.now(), {
          filter: currentStockId(),
          tzOffsetMinutes: tzOffsetMinutes(),
        });
      } catch (err) {
        console.error('enqueue-failed', err);
        toast('That photo couldn’t be saved — try again.');
      }
    } else {
      toast('That shot didn’t take — no film used.');
    }

    refreshChrome();
    await wait(Math.max(0, WIND_ON_MS - (performance.now() - started)));

    shutter.dataset.pressed = '0';
    state.locked = false;
    if (state.view === 'viewfinder') setDomState('viewfinder');
    if (state.routeQueued) { state.routeQueued = false; await route(); return; }
    await route();
  });

  refreshChrome();
}

/* ----------------------------------------------------------- terminals */

const TERMINALS = {
  notStarted: {
    title: 'The camera isn’t open yet!',
    body: (cfg) => `Come back on ${cfg?.eventDateText || 'the big day'} — the film is loaded and waiting.`,
    art: 'canister',
  },
  ended: {
    title: 'The camera is closed.',
    body: () => 'The film is off to be developed — the gallery is coming soon!',
    art: 'canister',
  },
  paused: {
    title: 'The camera is taking a little rest.',
    body: () => 'Hold tight — it’ll be back in a moment. Keep this page open.',
    art: 'lamp',
  },
  invalidLink: {
    title: 'Hmm, that link doesn’t look right.',
    body: () => 'Please re-scan the QR code from the wedding.',
    art: null,
    noHeader: true,
  },
  bootError: {
    title: 'We can’t reach the camera right now.',
    body: () => 'Check your signal and try again — nothing is lost.',
    art: null,
    noHeader: true,
    retry: true,
  },
};

function renderTerminal(kind) {
  const spec = TERMINALS[kind] || TERMINALS.invalidLink;
  setDomState(kind in TERMINALS ? kind : 'invalidLink');
  const { card, inner } = cardShell('card--terminal');
  if (!spec.noHeader && state.cfg) coupleHeader(inner);
  if (spec.art === 'canister') inner.append(el('div', { class: 'canister' }));
  if (spec.art === 'lamp') inner.append(el('span', { class: 'lamp' }));
  inner.append(el('h2', {}, spec.title));
  inner.append(el('p', { class: 'muted' }, spec.body(state.cfg)));

  // UPLOAD-005 + GUEST-004: uploads keep draining behind these cards (and a pause
  // now DEFERS rather than rejects, CONTRACTS §5), so the count must be live here —
  // this is exactly where a photo is most likely to still be in flight.
  const status = el('p', { class: 'status-line', role: 'status' });
  const offlineHint = el('p', { class: 'notice', hidden: true },
    'No signal right now — will send when signal returns.');
  inner.append(status, offlineHint);

  if (spec.retry) {
    const retry = el('button', { type: 'button', class: 'btn btn--primary' }, 'Try again');
    retry.addEventListener('click', () => location.reload());
    inner.append(retry);
  }
  mount(card);
  announce(`${spec.title} ${spec.body(state.cfg)}`);

  // Only claim "all sent" once this card has actually watched something drain —
  // a guest who never shot anything should not be told their photos went out.
  let sawPending = queue.pendingCount > 0;

  const update = () => {
    const pending = queue.pendingCount;
    const online = navigator.onLine !== false;
    if (pending > 0) sawPending = true;
    offlineHint.hidden = online || pending === 0;
    if (pending > 0) {
      status.textContent = online
        ? `${pending} photo${pending > 1 ? 's' : ''} still sending — keep this page open.`
        : `${pending} photo${pending > 1 ? 's' : ''} waiting for signal — keep this page open.`;
    } else {
      status.textContent = sawPending ? 'All photos sent. ✓' : '';
    }
    if (status.textContent) announce(status.textContent);
  };

  refreshChrome = update;
  on(queue, 'change', (e) => {
    if (e.detail?.rejection) handleRejection(e.detail.rejection);
    update();
  });
  on(globalThis, 'online', update);
  on(globalThis, 'offline', update);
  update();
}

/* ------------------------------------------- film used up (noSnaps card) */

function renderNoSnaps() {
  setDomState('noSnaps');
  const { card, inner } = cardShell('card--end');
  coupleHeader(inner);
  inner.append(el('div', { class: 'canister' }));
  inner.append(el('h2', {}, 'That’s a wrap — your film is used up!'));
  inner.append(el('p', { class: 'muted' },
    'Thanks for shooting. Your photos are off to be developed; the couple will share the gallery after the wedding.'));

  const chip = el('div', { class: 'film-chip' });
  chip.append(el('strong', { class: 'digits' }, `${pad2(totalSnaps())}/${pad2(totalSnaps())}`),
    el('span', {}, 'exposures shot'));
  inner.append(chip);

  const status = el('p', { class: 'status-line', role: 'status' });
  inner.append(status);
  if (ephemeralStorage()) {
    inner.append(el('p', { class: 'notice' },
      'Your browser is in private mode, so photos only live in this tab — please keep this page open until sending finishes.'));
  }
  mount(card);

  const update = () => {
    const pending = queue.pendingCount;
    if (pending === 0) {
      status.textContent = 'All photos sent. ✓';
      announce('All photos sent');
      return;
    }
    status.textContent = navigator.onLine !== false
      ? `${pending} photo${pending > 1 ? 's' : ''} still sending — keep this page open.`
      : `${pending} photo${pending > 1 ? 's' : ''} waiting for signal — we’ll send them automatically.`;
    announce(status.textContent);
  };
  refreshChrome = update;
  on(queue, 'change', (e) => {
    if (e.detail?.rejection) handleRejection(e.detail.rejection);
    update();
    route();
  });
  on(globalThis, 'online', update);
  on(globalThis, 'offline', update);
  update();
}

/* ------------------- permission denied / camera unavailable (CAMERA-009) */

const PERMISSION_STEPS = {
  ios: [
    'Tap the “aA” or “⋯” button in Safari’s address bar.',
    'Choose Website Settings → Camera → Allow.',
    'Come back here and tap Try again.',
  ],
  android: [
    'Tap the lock icon (or ⋮ → Settings → Site settings) in Chrome’s address bar.',
    'Set Camera to Allow.',
    'Come back here and tap Try again.',
  ],
  desktop: [
    'Click the camera or lock icon in your browser’s address bar.',
    'Allow camera access for this page.',
    'Then tap Try again.',
  ],
};

/**
 * Zero-friction fallback (CAMERA-009). Whatever stopped the in-page viewfinder —
 * a blocked permission prompt (Android refuses to show it while any overlay or
 * accessibility service is active), a denied permission, or no getUserMedia at all —
 * the guest must never be asked to change a phone setting. The phone's own camera
 * app needs no web permission, so it is the PRIMARY action here; the "fix the
 * viewfinder" steps are a footnote for the curious.
 */
function renderCameraFallback(kind) {
  setDomState(kind);
  const { card, inner } = cardShell('card--fallback');
  const denied = kind === 'permissionDenied';
  inner.append(el('h2', {}, 'Let’s use your phone’s camera'));
  inner.append(el('p', { class: 'muted' },
    'This page can’t open the camera directly on your phone right now — no problem. '
    + 'Tap the button, take your shot, and it lands on the roll just the same.'));

  const chip = el('div', { class: 'film-chip' });
  const digits = el('strong', { class: 'digits' }, `${pad2(snapsLeft())}/${pad2(totalSnaps())}`);
  chip.append(digits, el('span', {}, 'exposures left'));
  inner.append(chip);

  const status = el('p', { class: 'status-line', role: 'status' });

  const capture = nativeCaptureControl((blob, problem) => {
    if (blob) {
      sfx.arm();
      sfx.shutter();
      haptic([14, 40, 8]);
      status.textContent = 'Got it — sending…';
    } else if (problem === 'no-film') {
      status.textContent = 'Your film is used up.';
    } else {
      status.textContent = 'That photo couldn’t be read — try another.';
    }
    refreshChrome();
    route();
  });
  capture.classList.add('native--primary');
  capture.firstChild.textContent = '📷 Take a photo';
  inner.append(capture);
  inner.append(status);

  // Footnote: how to get the in-page viewfinder back, for guests who care.
  const more = el('details', { class: 'fallback-more' });
  more.append(el('summary', {}, denied
    ? 'Prefer the built-in viewfinder?' : 'Want to try the built-in viewfinder again?'));
  if (denied) {
    more.append(el('p', { class: 'muted' },
      'Your phone blocked the camera prompt — usually a screen filter, chat bubble or '
      + 'autofill service drawing over the screen, or camera access set to Block for this site.'));
    const steps = el('ol', { class: 'steps' });
    for (const step of PERMISSION_STEPS[platform()]) steps.append(el('li', {}, step));
    more.append(steps);
  }
  const retry = el('button', { type: 'button', class: 'btn btn--ghost' }, 'Try again');
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    retry.textContent = 'Checking…';
    rememberCameraBlock(false);
    state.cameraError = null;
    await route(true);
  });
  more.append(retry);
  inner.append(more);

  inner.append(el('p', { class: 'consent' },
    'Photos taken with your own camera go through exactly the same private pipeline — location data is stripped before sending.'));
  mount(card);
  announce('Use your phone camera to take a photo');

  refreshChrome = () => {
    digits.textContent = `${pad2(snapsLeft())}/${pad2(totalSnaps())}`;
  };
  on(queue, 'change', (e) => {
    if (e.detail?.rejection) handleRejection(e.detail.rejection);
    refreshChrome();
    route();
  });
}

/* ----------------------------------------- upload rejections (CONTRACTS §6.4) */

function handleRejection(reason, toast) {
  switch (reason) {
    case 'quota':
      if (toast) toast('Your film was already full — that one didn’t make it.');
      break;
    // No 'paused' case: a pause DEFERS server-side (CONTRACTS §5/§6.4) — it is
    // never written as a results.reason, so the client can never observe it.
    case 'window':
    case 'cap':
      if (toast) toast('The camera has closed — that photo wasn’t saved.');
      break;
    default:
      console.warn('upload-rejected', reason); // invalid / duplicate: silent + logged
  }
  // Gates re-evaluate on the next route() call; config snapshot supplies truth.
}

/* -------------------------------------------------------------- watchers */

function watchDevice() {
  const deviceRef = doc(db, 'devices', state.uid);
  updateDoc(deviceRef, { lastSeenAt: serverTimestamp() }).catch(() => {});
  const unsub = onSnapshot(deviceRef, (snap) => {
    if (!snap.exists()) return;
    state.device = snap.data();
    route();
  }, (err) => console.warn('device-watch-failed', err));
  globalThis.addEventListener('pagehide', unsub, { once: true });
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  renderLoading();

  state.slug = slugFromPath();

  let authFailed = false;
  try {
    if (!auth.currentUser) await signInAnonymously(auth);
    await new Promise((resolve, reject) => {
      const stop = onAuthStateChanged(auth, (u) => { if (u) { stop(); resolve(); } }, reject);
    });
  } catch (err) {
    console.error('auth-failed', err);
    authFailed = true;
  }

  // UPLOAD-005/009: photos already on this device outrank every gate below. The
  // queue comes up BEFORE any early return (bad link, auth failure, no config —
  // e.g. the link reopened with no signal), so the IndexedDB roll is loaded and
  // the online/beforeunload listeners exist no matter which card we end up on.
  // init() needs no config, and pump() parks on `auth.currentUser` being null and
  // retries once sign-in lands (queue.js pump/onAuthStateChanged), so calling it
  // after a failed sign-in is safe: the film resumes on the next reload with signal.
  await queue.init().catch((err) => console.warn('queue-init-failed', err));

  // Gate precedence is unchanged: an unusable link is still "invalid link", and a
  // failed sign-in is still the boot-error card.
  if (!state.slug) { state.view = null; await route(); return; }
  if (authFailed) {
    state.bootError = true;
    state.view = null;
    await route();
    return;
  }
  state.uid = auth.currentUser.uid;

  const cfgRef = doc(db, 'config', 'event');
  let cfgSnap;
  try {
    cfgSnap = await getDoc(cfgRef);
  } catch (err) {
    console.error('config-read-failed', err);
    state.bootError = true;
    state.view = null;
    await route();
    return;
  }
  if (!cfgSnap.exists()) { state.view = null; await route(); return; }
  state.cfg = cfgSnap.data();
  paint();
  document.title = state.cfg.coupleNames
    ? `${state.cfg.coupleNames} — Wedding Camera`
    : 'Wedding Camera';

  // Live re-evaluation of window/pause (GUEST-004/005, CONTRACTS §7).
  onSnapshot(cfgRef, (snap) => {
    if (!snap.exists()) return;
    state.cfg = snap.data();
    paint();
    route();
  }, (err) => console.warn('config-watch-failed', err));

  // Cheap ticker so notStarted/ended flip over without a config write.
  const tick = setInterval(() => { if (!state.locked) route(); }, 20_000);
  globalThis.addEventListener('pagehide', () => clearInterval(tick), { once: true });

  // Returning device skips the welcome card (GUEST-003).
  try {
    const deviceSnap = await getDoc(doc(db, 'devices', state.uid));
    if (deviceSnap.exists()) state.device = deviceSnap.data();
  } catch (err) {
    console.warn('device-read-failed', err);
  }
  if (state.device) watchDevice();

  await route();
}

boot().catch(async (err) => {
  console.error('boot-failed', err);
  state.bootError = true;
  state.view = null;
  await route();
});
