/**
 * Guest state machine (workstream ① — contract: docs/CONTRACTS.md §7).
 * PoC version: functionally complete flow; ① owns the disposable-camera aesthetics.
 */
import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import {
  doc, getDoc, setDoc, onSnapshot, serverTimestamp, updateDoc,
} from 'firebase/firestore';
import { auth, db } from '../lib/firebase.js';
import { applyTheme } from '../lib/theme.js';
import { Camera, reencodeFile } from './camera.js';
import { queue } from './queue.js';

const appEl = document.getElementById('app');
const state = {
  cfg: null,
  device: null,
  uid: null,
  camera: null,
  optimisticTaken: 0, // shutter presses not yet reflected in device.snapsRemaining
};

function slugFromPath() {
  const m = /^\/e\/([A-Za-z0-9]+)\/?$/.exec(location.pathname);
  return m ? m[1] : null;
}

function setState(name) {
  appEl.dataset.state = name;
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(children) {
  appEl.replaceChildren(...children);
}

function snapsLeft() {
  if (!state.device) return 0;
  return Math.max(0, state.device.snapsRemaining - queue.pendingCount);
}

function renderTerminal(name, title, body, extra = []) {
  setState(name);
  render([
    el('div', { class: 'terminal-card' }),
  ]);
  const card = appEl.firstChild;
  card.append(
    el('h1', { 'data-theme-couple-names': '' }, state.cfg?.coupleNames || ''),
    el('h2', {}, title),
    el('p', {}, body),
    ...extra,
  );
  if (state.cfg) applyTheme(state.cfg);
}

/* ---------------- gates (CONTRACTS §7 order) ---------------- */

function evaluateGates() {
  const cfg = state.cfg;
  const now = Date.now();
  if (!cfg || cfg.slug !== slugFromPath()) {
    renderTerminal('invalidLink', 'Hmm, that link doesn’t look right.',
      'Please re-scan the QR code from the wedding.');
    return false;
  }
  if (cfg.startAt && now < cfg.startAt.toMillis()) {
    renderTerminal('notStarted', 'The camera isn’t open yet!',
      `Come back on ${cfg.eventDateText}.`);
    return false;
  }
  if (cfg.endAt && now > cfg.endAt.toMillis()) {
    renderTerminal('ended', 'The camera is closed.',
      'The film is off to be developed — the gallery is coming soon!');
    return false;
  }
  if (cfg.paused) {
    renderTerminal('paused', 'The camera is taking a little rest.',
      'Hold tight — it’ll be back shortly.');
    return false;
  }
  return true;
}

/* ---------------- welcome / nickname ---------------- */

function renderWelcome() {
  setState('welcome');
  const card = el('div', { class: 'welcome-card' });
  card.append(
    el('div', { class: 'monogram', 'data-theme-monogram': '' }),
    el('h1', { 'data-theme-couple-names': '' }),
    el('p', { class: 'date', 'data-theme-event-date': '' }),
    el('p', { class: 'welcome', 'data-theme-welcome-text': '' }),
  );
  const form = el('form', { class: 'name-form' });
  const input = el('input', {
    type: 'text', maxlength: '30', required: '', autocomplete: 'off',
    placeholder: 'Who’s snapping? (your name)', 'aria-label': 'Your name or nickname',
  });
  const btn = el('button', { type: 'submit', class: 'primary' }, 'Start snapping');
  const consent = el('p', { class: 'consent', 'data-theme-consent-text': '' });
  form.append(input, btn);
  card.append(form, consent);
  render([card]);
  applyTheme(state.cfg);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nickname = input.value.trim().slice(0, 30);
    if (!nickname) return;
    btn.disabled = true;
    try {
      await setDoc(doc(db, 'devices', state.uid), {
        nickname,
        snapsRemaining: state.cfg.defaultSnaps,
        snapsGranted: 0,
        createdAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
        consentShownAt: serverTimestamp(),
      });
      await startViewfinder();
    } catch (err) {
      btn.disabled = false;
      consent.textContent = 'Something went wrong — try again.';
    }
  });
}

/* ---------------- viewfinder ---------------- */

async function startViewfinder() {
  if (snapsLeft() <= 0 && queue.pendingCount === 0) { renderNoSnaps(); return; }
  setState('viewfinder');

  const frame = el('div', { class: 'camera-frame' });
  const video = el('video', { class: 'viewfinder', playsinline: '', muted: '' });
  const flash = el('div', { class: 'screen-flash', hidden: '' });
  const counter = el('div', { class: 'counter', role: 'status' });
  const badge = el('div', { class: 'badge', hidden: '' });
  const controls = el('div', { class: 'controls' });
  const shutter = el('button', { class: 'shutter', 'aria-label': 'Take photo' });
  const flipBtn = el('button', { class: 'ctl flip', 'aria-label': 'Switch camera' }, '⟲');
  const torchBtn = el('button', { class: 'ctl torch', 'aria-label': 'Flash', hidden: '' }, '⚡');
  const zoomBtn = el('button', { class: 'ctl zoom', 'aria-label': 'Zoom' }, '1×');
  controls.append(flipBtn, shutter, torchBtn, zoomBtn);
  frame.append(video, flash, counter, badge, controls);
  render([frame]);
  applyTheme(state.cfg);

  const updateCounter = () => {
    counter.textContent = `${String(snapsLeft()).padStart(2, '0')}/${String(state.cfg.defaultSnaps + (state.device?.snapsGranted || 0)).padStart(2, '0')}`;
    const pending = queue.pendingCount;
    badge.hidden = pending === 0;
    badge.textContent = navigator.onLine
      ? `${pending} sending…`
      : `${pending} will send when signal returns`;
    if (snapsLeft() <= 0 && pending === 0) renderNoSnaps();
  };
  queue.addEventListener('change', updateCounter);
  globalThis.addEventListener('online', updateCounter);
  globalThis.addEventListener('offline', updateCounter);

  state.camera = new Camera(video);
  try {
    await state.camera.start();
  } catch (err) {
    renderCameraFallback(err?.name === 'NotAllowedError' ? 'permissionDenied' : 'cameraUnavailable');
    return;
  }

  torchBtn.hidden = !state.camera.supportsTorch && state.camera.facingMode !== 'user';
  const refreshTorchBtn = () => {
    const front = state.camera.facingMode === 'user';
    torchBtn.hidden = !front && !state.camera.supportsTorch;
  };
  refreshTorchBtn();

  let zoomLevel = 1;
  zoomBtn.addEventListener('click', async () => {
    zoomLevel = zoomLevel >= 2 ? 1 : zoomLevel + 0.5;
    zoomBtn.textContent = `${zoomLevel}×`;
    await state.camera.applyZoom(zoomLevel);
  });
  flipBtn.addEventListener('click', async () => {
    flipBtn.disabled = true;
    await state.camera.flip().catch(() => {});
    refreshTorchBtn();
    flipBtn.disabled = false;
  });
  let torchOn = false;
  torchBtn.addEventListener('click', async () => {
    torchOn = !torchOn;
    torchBtn.classList.toggle('on', torchOn);
    if (state.camera.facingMode !== 'user') await state.camera.setTorch(torchOn).catch(() => {});
  });

  let locked = false;
  shutter.addEventListener('click', async () => {
    if (locked || snapsLeft() <= 0) return;
    locked = true;
    shutter.disabled = true;
    try {
      // Screen flash for front camera when "flash" armed.
      if (torchOn && state.camera.facingMode === 'user') {
        flash.hidden = false;
        await new Promise((r) => setTimeout(r, 120));
      }
      const blob = await state.camera.capture();
      flash.hidden = true;
      appEl.classList.add('winding');
      await queue.enqueue(blob, Date.now());
      updateCounter();
    } catch { /* capture failed — do not consume anything */ }
    // ~0.8s wind-on lockout (CAMERA-003)
    setTimeout(() => {
      appEl.classList.remove('winding');
      locked = false;
      shutter.disabled = false;
    }, 800);
  });

  updateCounter();
}

function renderNoSnaps() {
  state.camera?.stop();
  const pending = queue.pendingCount;
  renderTerminal('noSnaps', 'You’ve used your film! 🎞️',
    pending > 0
      ? `Keep this page open a moment — ${pending} photo${pending > 1 ? 's are' : ' is'} still sending.`
      : 'Your photos will be developed after the wedding. Thank you!');
  queue.addEventListener('change', () => {
    if (appEl.dataset.state === 'noSnaps') renderNoSnaps();
  }, { once: true });
}

function renderCameraFallback(kind) {
  setState(kind);
  const card = el('div', { class: 'terminal-card' });
  card.append(
    el('h2', {}, kind === 'permissionDenied' ? 'Camera permission needed' : 'Camera unavailable'),
    el('p', {}, kind === 'permissionDenied'
      ? 'Please allow camera access in your browser settings (aA menu → Website Settings → Camera on iPhone; ⋮ → Settings → Site settings → Camera on Android), then reload.'
      : 'No worries — you can still snap with your phone’s own camera below.'),
  );
  const retry = el('button', { class: 'primary' }, 'Try again');
  retry.addEventListener('click', () => location.reload());
  const label = el('label', { class: 'native-capture' }, 'Use my phone camera');
  const input = el('input', {
    type: 'file', accept: 'image/*', capture: 'environment', hidden: '',
  });
  label.append(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file || snapsLeft() <= 0) return;
    const blob = await reencodeFile(file).catch(() => null);
    if (blob) await queue.enqueue(blob, Date.now());
    input.value = '';
  });
  card.append(retry, label);
  render([card]);
  applyTheme(state.cfg);
}

/* ---------------- boot ---------------- */

async function boot() {
  setState('loading');
  render([el('div', { class: 'loading' }, 'Loading the camera…')]);

  const slug = slugFromPath();
  if (!slug) {
    renderTerminal('invalidLink', 'Hmm, that link doesn’t look right.',
      'Please re-scan the QR code from the wedding.');
    return;
  }

  await signInAnonymously(auth);
  await new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (u) => { if (u) { stop(); resolve(); } });
  });
  state.uid = auth.currentUser.uid;

  const cfgRef = doc(db, 'config', 'event');
  const cfgSnap = await getDoc(cfgRef);
  if (!cfgSnap.exists()) {
    renderTerminal('invalidLink', 'Hmm, that link doesn’t look right.',
      'Please re-scan the QR code from the wedding.');
    return;
  }
  state.cfg = cfgSnap.data();
  document.title = `${state.cfg.coupleNames} — Wedding Camera`;

  await queue.init();
  if (queue.persistent === false) {
    // Private browsing / ephemeral storage: photos won't survive a closed tab.
    console.warn('Ephemeral storage: keep the page open until photos send.');
  }

  // Live re-evaluation of pause/window (GUEST-004/005).
  onSnapshot(cfgRef, (snap) => {
    if (!snap.exists()) return;
    state.cfg = snap.data();
    const active = ['viewfinder', 'welcome'].includes(appEl.dataset.state);
    if (active && !evaluateGates()) state.camera?.stop();
  });

  if (!evaluateGates()) return;

  const deviceRef = doc(db, 'devices', state.uid);
  const deviceSnap = await getDoc(deviceRef);
  if (deviceSnap.exists()) {
    state.device = deviceSnap.data();
    updateDoc(deviceRef, { lastSeenAt: serverTimestamp() }).catch(() => {});
    onSnapshot(deviceRef, (snap) => {
      if (snap.exists()) {
        state.device = snap.data();
        queue.dispatchEvent(new CustomEvent('change', { detail: { pending: queue.pendingCount } }));
      }
    });
    await startViewfinder();
  } else {
    renderWelcome();
    onSnapshot(deviceRef, (snap) => {
      if (snap.exists()) state.device = snap.data();
    });
  }
}

boot().catch((err) => {
  console.error(err);
  renderTerminal('invalidLink', 'Something went wrong.', 'Please re-scan the QR code and try again.');
});
