/**
 * Step-less, lens-aware zoom control (CAMERA-006 / CAMERA-010).
 *
 * A horizontal track with a tick per rung of the lens ladder, a draggable thumb
 * and a live readout. The scale is LOGARITHMIC so 0.5 → 1 → 2 → 4 → 8 sit at
 * even spacing, which is how every phone camera app reads and how guests expect
 * a lens ring to feel. Everything beyond the ladder's optical ceiling is drawn
 * as a hatched, dimmed segment so a guest can see where quality starts dropping.
 *
 *   mountZoomControl({ host, camera, onChange, gestureTarget, sfx }) -> handle
 *
 * Interaction: drag the thumb, tap anywhere on the track (a tap near a tick
 * snaps to that lens), pinch on the viewfinder, or focus the track and use
 * ←/→ (0.1 steps) and Home/End. `role=slider` + aria-value* carry the semantics
 * a native <input type=range> would, without its unstyleable tick rendering.
 *
 * Text is set with textContent only (CONTRACTS §9) — never innerHTML.
 */
import { snapToRung, opticalCeiling } from './lens.js';
import './zoom.css';

/** Magnitude tolerance for snapping to a rung (CAMERA-010). */
const SNAP_TOL = 0.06;
/** …plus a pixel tolerance, so a tap ON a tick always takes that lens. */
const SNAP_PX = 16;
/** Keyboard step for ←/→. */
const KEY_STEP = 0.1;

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const round2 = (n) => Math.round(n * 100) / 100;

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    node.setAttribute(k, v === true ? '' : String(v));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/* --------------------------------------------------------- scale mapping */

/** Log scale: equal screen distance per doubling, like a real lens ring. */
function posFromMag(ladder, mag) {
  const lo = Math.log(ladder.min);
  const hi = Math.log(ladder.max);
  if (!(hi > lo)) return 0;
  return clamp((Math.log(clamp(mag, ladder.min, ladder.max)) - lo) / (hi - lo), 0, 1);
}

function magFromPos(ladder, pos) {
  const lo = Math.log(ladder.min);
  const hi = Math.log(ladder.max);
  return round2(Math.exp(lo + clamp(pos, 0, 1) * (hi - lo)));
}

function formatMag(mag) {
  return `${mag.toFixed(1)}×`;
}

/* ------------------------------------------------------------------ mount */

export function mountZoomControl({ host, camera, onChange, gestureTarget = null, sfx = null } = {}) {
  const wrap = el('div', { class: 'zoomctl' });
  const track = el('div', {
    class: 'zoomctl__track',
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Zoom',
  });
  // The rail is inset inside the (larger) hit area so the thumb and the end
  // labels stay fully on the chassis at 0.5× and at the top of the ladder.
  const rail = el('div', { class: 'zoomctl__rail', 'aria-hidden': 'true' });
  const digital = el('div', { class: 'zoomctl__digital', 'aria-hidden': 'true' });
  const ticks = el('div', { class: 'zoomctl__ticks', 'aria-hidden': 'true' });
  const fill = el('div', { class: 'zoomctl__fill', 'aria-hidden': 'true' });
  const thumb = el('div', { class: 'zoomctl__thumb', 'aria-hidden': 'true' });
  const readout = el('output', { class: 'zoomctl__readout digits', 'aria-hidden': 'true' }, '1.0×');
  rail.append(digital, fill, ticks, thumb);
  track.append(rail);
  wrap.append(track, readout);
  host.append(wrap);

  let ladder = camera.ladder || fallbackLadder();
  let mag = camera.magnification || 1;
  let tickNodes = [];

  function fallbackLadder() {
    // Before the stream is live we still render something honest and usable.
    return {
      mode: 'digital', facing: 'environment', min: 1, max: 2, oneX: 1,
      deviceId: null, nativeMin: null, nativeMax: null,
      rungs: [{ mag: 1, label: '1×', real: true }, { mag: 2, label: '2×', real: false }],
      notes: [],
    };
  }

  /* ---- rendering ---- */

  function renderTicks() {
    ticks.replaceChildren();
    tickNodes = ladder.rungs.map((rung) => {
      const pos = posFromMag(ladder, rung.mag);
      const node = el('div', {
        class: `zoomctl__tick${rung.real === false ? ' zoomctl__tick--digital' : ''}`,
      });
      node.style.setProperty('--pos', `${pos * 100}%`);
      node.append(
        el('span', { class: 'zoomctl__mark' }),
        el('span', { class: 'zoomctl__label' }, rung.label),
      );
      ticks.append(node);
      return { rung, node, pos };
    });

    // Hatch the stretch past the last lens: it is pure crop from there up.
    const ceiling = opticalCeiling(ladder);
    const start = posFromMag(ladder, ceiling);
    digital.style.setProperty('--from', `${start * 100}%`);
    digital.hidden = start >= 0.999;
    wrap.dataset.mode = ladder.mode;
  }

  function render() {
    const pos = posFromMag(ladder, mag);
    thumb.style.setProperty('--pos', `${pos * 100}%`);
    fill.style.setProperty('--pos', `${pos * 100}%`);
    readout.textContent = formatMag(mag);
    track.setAttribute('aria-valuemin', String(ladder.min));
    track.setAttribute('aria-valuemax', String(ladder.max));
    track.setAttribute('aria-valuenow', String(mag));
    track.setAttribute('aria-valuetext', `${mag.toFixed(1)} times`);
    wrap.dataset.mag = String(mag);
    // The readout goes accent-coloured only when the guest has left 1×.
    wrap.classList.toggle('zoomctl--zoomed', Math.abs(mag - 1) > 0.001);
    for (const t of tickNodes) {
      t.node.classList.toggle('zoomctl__tick--active', Math.abs(t.rung.mag - mag) < 0.001);
    }
  }

  /* ---- value changes ---- */

  function commit(next, { snap = true, haptics = false } = {}) {
    const target = snap ? snapToRung(ladder, next, SNAP_TOL) : round2(clamp(next, ladder.min, ladder.max));
    if (target === mag) return;
    const wasRung = isRung(mag);
    mag = target;
    render();
    // A short tick as the slider drops into a real lens — the detent you feel
    // on a lens ring, so a guest knows when they are on glass and not on crop.
    if (haptics && isRung(mag) && !wasRung) {
      try { navigator.vibrate?.(8); } catch { /* unsupported */ }
    }
    camera.setMagnification(mag).catch(() => {});
    onChange?.(mag);
  }

  function isRung(value) {
    return ladder.rungs.some((r) => Math.abs(r.mag - value) < 0.001);
  }

  /** Pointer x → magnification, snapping when the tap lands on a tick. */
  function magAtClientX(clientX) {
    const box = rail.getBoundingClientRect();
    if (!box.width) return mag;
    const pos = (clientX - box.left) / box.width;
    const raw = magFromPos(ladder, pos);
    const near = tickNodes.find((t) => Math.abs(box.left + t.pos * box.width - clientX) <= SNAP_PX);
    return near ? near.rung.mag : raw;
  }

  /* ---- drag ---- */

  let dragId = null;
  const onPointerDown = (e) => {
    if (dragId !== null) return;
    dragId = e.pointerId;
    sfx?.arm?.(); // unlock WebAudio on this gesture, like every other control
    track.setPointerCapture?.(e.pointerId);
    track.classList.add('is-dragging');
    commit(magAtClientX(e.clientX), { haptics: true });
    e.preventDefault();
  };
  const onPointerMove = (e) => {
    if (e.pointerId !== dragId) return;
    commit(magAtClientX(e.clientX), { haptics: true });
    e.preventDefault();
  };
  const onPointerUp = (e) => {
    if (e.pointerId !== dragId) return;
    dragId = null;
    track.releasePointerCapture?.(e.pointerId);
    track.classList.remove('is-dragging');
  };
  track.addEventListener('pointerdown', onPointerDown);
  track.addEventListener('pointermove', onPointerMove);
  track.addEventListener('pointerup', onPointerUp);
  track.addEventListener('pointercancel', onPointerUp);

  /* ---- keyboard (input type=range semantics) ---- */

  const onKeyDown = (e) => {
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = mag + KEY_STEP;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = mag - KEY_STEP;
    else if (e.key === 'Home') next = ladder.min;
    else if (e.key === 'End') next = ladder.max;
    else if (e.key === 'PageUp') next = mag * 2;
    else if (e.key === 'PageDown') next = mag / 2;
    if (next === null) return;
    e.preventDefault();
    commit(next);
  };
  track.addEventListener('keydown', onKeyDown);

  /* ---- pinch on the viewfinder (multiplicative, like every camera app) ---- */

  const points = new Map();
  let pinchStart = null;
  const spread = () => {
    const [a, b] = [...points.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const gestureDown = (e) => {
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 2) pinchStart = { dist: spread(), mag };
  };
  const gestureMove = (e) => {
    if (!points.has(e.pointerId)) return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size !== 2 || !pinchStart || !pinchStart.dist) return;
    commit(pinchStart.mag * (spread() / pinchStart.dist), { haptics: true });
    e.preventDefault();
  };
  const gestureUp = (e) => {
    points.delete(e.pointerId);
    if (points.size < 2) pinchStart = null;
  };
  if (gestureTarget) {
    gestureTarget.addEventListener('pointerdown', gestureDown);
    gestureTarget.addEventListener('pointermove', gestureMove, { passive: false });
    gestureTarget.addEventListener('pointerup', gestureUp);
    gestureTarget.addEventListener('pointercancel', gestureUp);
    gestureTarget.style.touchAction = 'none';
  }

  /* ---- the camera tells us when the ladder or the value moved ---- */

  const onLadder = (e) => {
    ladder = e.detail.ladder;
    mag = clamp(camera.magnification || 1, ladder.min, ladder.max);
    renderTicks();
    render();
  };
  const onMagnification = (e) => {
    const next = round2(e.detail.magnification);
    if (next === mag) return;
    mag = next;
    render();
  };
  camera.addEventListener('ladderchange', onLadder);
  camera.addEventListener('magnificationchange', onMagnification);

  renderTicks();
  render();

  let diag = null;
  if (isDiagRequested()) diag = mountDiagnostics({ camera, host: document.body });

  return {
    el: wrap,
    get magnification() { return mag; },
    setMagnification(next) { commit(next, { snap: false }); },
    refresh() { ladder = camera.ladder || ladder; mag = camera.magnification || mag; renderTicks(); render(); },
    destroy() {
      track.removeEventListener('pointerdown', onPointerDown);
      track.removeEventListener('pointermove', onPointerMove);
      track.removeEventListener('pointerup', onPointerUp);
      track.removeEventListener('pointercancel', onPointerUp);
      track.removeEventListener('keydown', onKeyDown);
      if (gestureTarget) {
        gestureTarget.removeEventListener('pointerdown', gestureDown);
        gestureTarget.removeEventListener('pointermove', gestureMove);
        gestureTarget.removeEventListener('pointerup', gestureUp);
        gestureTarget.removeEventListener('pointercancel', gestureUp);
      }
      camera.removeEventListener('ladderchange', onLadder);
      camera.removeEventListener('magnificationchange', onMagnification);
      diag?.destroy();
      wrap.remove();
    },
  };
}

/* ------------------------------------------------------- diagnostics view */

export function isDiagRequested() {
  try { return new URLSearchParams(location.search).get('diag') === '1'; } catch { return false; }
}

/**
 * `?diag=1` — a dismissible bottom sheet of everything the heuristics saw.
 * This is what the couple screenshots from their own phones so we can tune the
 * ladder for the handsets that actually turn up on the day. Text only.
 */
export function mountDiagnostics({ camera, host = document.body } = {}) {
  const sheet = el('div', { class: 'zoomdiag', role: 'dialog', 'aria-label': 'Camera diagnostics' });
  const head = el('div', { class: 'zoomdiag__head' });
  const title = el('h2', { class: 'zoomdiag__title' }, 'Camera diagnostics');
  const copy = el('button', { type: 'button', class: 'zoomdiag__btn' }, 'Copy');
  const close = el('button', { type: 'button', class: 'zoomdiag__btn', 'aria-label': 'Dismiss diagnostics' }, 'Close');
  head.append(title, copy, close);
  const body = el('pre', { class: 'zoomdiag__body', tabindex: '0' }, 'collecting…');
  sheet.append(head, body);
  host.append(sheet);

  const refresh = () => { body.textContent = camera.diagnosticsReport(); };
  const onAny = () => refresh();
  camera.addEventListener('ladderchange', onAny);
  camera.addEventListener('magnificationchange', onAny);
  const timer = setInterval(refresh, 1000);
  refresh();

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(body.textContent);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
    } catch {
      // No clipboard permission (or no HTTPS): select the text so the guest can
      // long-press → Copy, which is what they would do on a phone anyway.
      const range = document.createRange();
      range.selectNodeContents(body);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      copy.textContent = 'Selected — long-press to copy';
      setTimeout(() => { copy.textContent = 'Copy'; }, 2600);
    }
  });

  const destroy = () => {
    clearInterval(timer);
    camera.removeEventListener('ladderchange', onAny);
    camera.removeEventListener('magnificationchange', onAny);
    sheet.remove();
  };
  close.addEventListener('click', destroy);
  return { el: sheet, refresh, destroy };
}
