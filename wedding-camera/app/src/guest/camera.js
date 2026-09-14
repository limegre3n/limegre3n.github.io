/**
 * Camera capture pipeline (workstream ① — contract: docs/CONTRACTS.md §8).
 * getUserMedia acquisition, flip, torch detection, lens-aware step-less zoom
 * (CAMERA-006 / CAMERA-010), still-photo capture with a viewfinder fallback
 * (CAMERA-013), canvas re-encode to ≤2560px JPEG (strips all EXIF/GPS —
 * CAMERA-007/008).
 *
 * Public API (frozen): class Camera { start, stop, flip, setTorch, applyZoom,
 * setMagnification, capture, supportsTorch, supportsNativeZoom, facingMode }
 * and reencodeFile(file). `capture()` still resolves to a single JPEG Blob;
 * `lastCaptureSource` ('still' | 'frame') and `lastEncode` report how the most
 * recent shot was produced. `dispose()` stops the stream AND detaches the
 * lifecycle listeners so repeated mounts of the viewfinder cannot leak handlers.
 *
 * Camera is an EventTarget: 'ladderchange' fires once the lens ladder is known
 * (after the first permission grant, when device labels finally exist) and
 * 'magnificationchange' on every applied zoom. zoom-ui.js listens to both.
 */
import { buildLadder, resolve, describeLadder, describeMapping } from './lens.js';

const MAX_EDGE = 2560;
const JPEG_QUALITY = 0.86;
/** CAMERA-007 target size; we step quality down a little rather than resize. */
const TARGET_BYTES = 2_500_000;
const MIN_QUALITY = 0.72;
const QUALITY_STEP = 0.06;
/**
 * Belt and braces for the 8MB cap in storage.rules / functions finalize: a frame
 * that is still enormous at MIN_QUALITY gets resized instead of rejected.
 */
const SAFETY_BYTES = 6_000_000;
const SAFETY_SCALE = 0.85;
const MIN_SAFETY_EDGE = 640;

/** CAMERA-013: how long a still is allowed to take before we grab a frame. */
const STILL_TIMEOUT_MS = 2500;
/**
 * Preview resolution is a SEPARATE knob from MAX_EDGE: stills come from
 * ImageCapture now, so there is nothing to gain from asking phones for a 1440p
 * viewfinder (battery, heat, dropped frames) — 1080p-class is what they served
 * before and what the frame-grab fallback still works from.
 */
const PREVIEW_IDEAL_WIDTH = 1920;

/** Coalesce a drag into one applyConstraints per frame-ish (CAMERA-010). */
const ZOOM_DEBOUNCE_MS = 50;
/** Lens switch: freeze the last frame, swap streams, fade the still out. */
const CROSSFADE_MS = 250;
/** Opening a camera to read its capabilities costs ~300ms — strictly budgeted. */
const MAX_PROBES = 3;

export class Camera extends EventTarget {
  constructor(videoEl) {
    super();
    this.video = videoEl;
    this.stream = null;
    this.facingMode = 'environment';
    this.digitalZoom = 1;
    this.torchOn = false;
    this.cropAtCapture = false;

    /** CAMERA-013: how the last shot was produced — 'still' | 'frame' | null. */
    this.lastCaptureSource = null;
    /** CAMERA-007: { width, height, quality, bytes, steps } of the last encode. */
    this.lastEncode = null;

    /** Displayed magnification — ALWAYS starts at 1×, the main wide lens. */
    this.magnification = 1;
    this.ladder = null;
    this.devices = [];
    this.capsById = {};
    this.labelsById = {};

    this._deviceId = null;        // device we asked for, null = pick by facingMode
    this._probed = false;         // capability probing is a one-shot budget
    this._lastMag = { environment: 1, user: 1 };
    this._zoomTimer = null;
    this._zoomTarget = null;
    this._zoomPending = null;
    this._swapping = null;
    this._abort = new AbortController();

    // iOS Safari kills tracks on backgrounding — re-acquire when visible (CONTRACTS §8).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !this.stream) return;
      const track = this.track;
      if (!track || track.readyState === 'ended') this.start().catch(() => {});
    }, { signal: this._abort.signal });
  }

  get track() {
    return this.stream?.getVideoTracks()[0] || null;
  }

  get capabilities() {
    try { return this.track?.getCapabilities?.() || {}; } catch { return {}; }
  }

  get settings() {
    try { return this.track?.getSettings?.() || {}; } catch { return {}; }
  }

  get supportsTorch() { return this.capabilities.torch === true; }

  get supportsNativeZoom() {
    const zoom = this.capabilities.zoom;
    if (!zoom) return false;
    if (typeof zoom === 'number') return true;
    if (typeof zoom === 'object') return (zoom.max ?? 1) > (zoom.min ?? 1);
    return false;
  }

  /* ------------------------------------------------------------ lifecycle */

  async start() {
    this.stop();
    this.stream = await this._openStream(this._deviceId);
    await this._attach(this.stream);
    this.torchOn = false;
    await this._refreshLadder();
    await this.setMagnification(this.magnification).catch(() => {});
  }

  async _openStream(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      const err = new Error('getUserMedia-unavailable');
      err.name = 'NotSupportedError';
      throw err;
    }
    const video = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: PREVIEW_IDEAL_WIDTH } }
      : { facingMode: this.facingMode, width: { ideal: PREVIEW_IDEAL_WIDTH } };
    return navigator.mediaDevices.getUserMedia({ video, audio: false });
  }

  async _attach(stream) {
    this.video.srcObject = stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    this.video.dataset.facing = this.facingMode;
    await this.video.play().catch(() => {});
    // Wait briefly for real frame dimensions so the first capture can't race.
    await this._awaitDimensions();
  }

  async _awaitDimensions(timeoutMs = 1500) {
    if (this.video.videoWidth) return;
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, timeoutMs);
      this.video.addEventListener('loadedmetadata', done, { once: true });
    });
  }

  stop() {
    clearTimeout(this._zoomTimer);
    this._zoomTimer = null;
    // Never leave an awaited setMagnification() hanging on a cancelled timer.
    this._zoomResolve?.();
    this._zoomResolve = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.torchOn = false;
    if (this.video) this.video.srcObject = null;
  }

  /** Stop the stream and detach lifecycle listeners (call when unmounting). */
  dispose() {
    this.stop();
    this._abort.abort();
  }

  async flip() {
    const previous = this.facingMode;
    this._lastMag[previous] = this.magnification;
    this.facingMode = previous === 'environment' ? 'user' : 'environment';
    // A per-side ladder: the front camera has no lenses to switch between, and
    // coming back to the rear restores the magnification the guest had chosen.
    this._deviceId = null;
    this.ladder = null;
    this.magnification = this._lastMag[this.facingMode] ?? 1;
    try {
      await this.start();
    } catch {
      // The just-released device can report busy for a moment — retry once…
      await new Promise((r) => setTimeout(r, 220));
      try {
        await this.start();
      } catch (err) {
        // …then fall back to the side that worked rather than losing the viewfinder.
        this.facingMode = previous;
        this.ladder = null;
        this.magnification = this._lastMag[previous] ?? 1;
        await this.start().catch(() => {});
        throw err;
      }
    }
    return this.facingMode;
  }

  async setTorch(on) {
    if (!this.supportsTorch) { this.torchOn = false; return false; }
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
    } catch {
      this.torchOn = false;
      return false;
    }
    this.torchOn = !!on;
    return true;
  }

  /* ---------------------------------------------------- CAMERA-010: ladder */

  /**
   * Build the lens ladder from whatever the browser will tell us. Device LABELS
   * are empty until the first permission grant, which is why this runs after
   * start() and not before: the whole iOS heuristic hangs off the label.
   */
  async _refreshLadder() {
    await this._collectDevices();
    const active = this.settings.deviceId || null;
    if (active) this.capsById[active] = this.capabilities;

    let ladder = this._build();
    // Only pay for probing when the active camera has nothing to zoom with and
    // there is more than one back camera to choose between — one of the others
    // may be the zoomable logical device, or they may be fixed lenses to switch.
    if (this.facingMode === 'environment' && ladder.mode !== 'native' && !this._probed) {
      const probed = await this._probeBackDevices(active);
      if (probed) ladder = this._build();
    }
    this.ladder = ladder;
    this.magnification = Math.min(Math.max(this.magnification, ladder.min), ladder.max);
    this.dispatchEvent(new CustomEvent('ladderchange', { detail: { ladder } }));
    return ladder;
  }

  _build() {
    return buildLadder({
      devices: this.devices,
      capsById: this.capsById,
      labelsById: this.labelsById,
      facing: this.facingMode,
    });
  }

  async _collectDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices = all
        .filter((d) => d.kind === 'videoinput')
        .map((d) => ({ deviceId: d.deviceId, kind: d.kind, label: d.label, groupId: d.groupId }));
      for (const d of this.devices) if (d.label) this.labelsById[d.deviceId] = d.label;
    } catch {
      this.devices = [];
    }
  }

  /**
   * Open → getCapabilities() → stop, for the other back cameras. Costs ~300ms
   * each, so: at most MAX_PROBES, and never more than once per page view.
   */
  async _probeBackDevices(activeId) {
    this._probed = true;
    const targets = this.devices
      .filter((d) => d.deviceId && d.deviceId !== activeId)
      .filter((d) => /back|rear|environment|camera2 \d+, facing back/i.test(d.label || ''))
      .slice(0, MAX_PROBES);
    let learned = false;
    for (const d of targets) {
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: d.deviceId } }, audio: false,
        });
        const track = stream.getVideoTracks()[0];
        this.capsById[d.deviceId] = track?.getCapabilities?.() || {};
        learned = true;
      } catch {
        this.capsById[d.deviceId] = this.capsById[d.deviceId] || {};
      } finally {
        if (stream) for (const t of stream.getTracks()) t.stop();
      }
    }
    return learned;
  }

  /* ------------------------------------------------------- CAMERA-006/010 */

  /**
   * Set the DISPLAYED magnification (1× always means the phone's main wide
   * lens). Resolves through the ladder into: which camera streams, what native
   * zoom constraint to apply, and what digital crop sits on top.
   */
  async setMagnification(mag) {
    const ladder = this.ladder || (this.ladder = this._build());
    const wanted = Math.min(Math.max(Number(mag) || 1, ladder.min), ladder.max);
    const plan = resolve(ladder, wanted);
    this.magnification = wanted;
    this._lastMag[this.facingMode] = wanted;

    // Discrete ladders change LENS, not zoom: swap the stream behind a crossfade.
    // Native/digital ladders never change device, so they never pay for this.
    const current = this.settings.deviceId || this._deviceId || null;
    if (ladder.mode === 'discrete' && plan.deviceId && plan.deviceId !== current) {
      await this._switchDevice(plan.deviceId);
    }

    let native = false;
    if (plan.nativeZoom != null && this.track && this.supportsNativeZoom) {
      await this._applyNativeZoom(plan.nativeZoom);
      native = true;
    }

    this._applyDigital(plan.digital);
    this.dispatchEvent(new CustomEvent('magnificationchange', {
      detail: { magnification: wanted, plan, native },
    }));
    return native;
  }

  /** Back-compat shim: the old 1–2× factor is just a magnification (CAMERA-006). */
  async applyZoom(zoom) {
    return this.setMagnification(zoom);
  }

  /** The CSS scale and the capture crop are the same number, always ≥ 1. */
  _applyDigital(digital) {
    const factor = Math.max(1, Number(digital) || 1);
    this.digitalZoom = factor;
    // The stylesheet composes --zoom with the front-camera mirror.
    this.video.style.setProperty('--zoom', String(factor));
    this.cropAtCapture = factor > 1;
  }

  /** Debounced so a drag issues one constraint per 50ms, not one per pointermove. */
  _applyNativeZoom(value) {
    this._zoomTarget = value;
    if (this._zoomTimer) return this._zoomPending;
    this._zoomPending = new Promise((done) => {
      this._zoomResolve = done;
      this._zoomTimer = setTimeout(async () => {
        this._zoomTimer = null;
        this._zoomResolve = null;
        const cap = this.capabilities.zoom;
        const lo = (typeof cap === 'object' ? cap.min : 1) ?? 1;
        const hi = (typeof cap === 'object' ? cap.max : this._zoomTarget) ?? this._zoomTarget;
        const clamped = Math.min(Math.max(this._zoomTarget, lo), hi);
        try {
          await this.track?.applyConstraints({ advanced: [{ zoom: clamped }] });
        } catch { /* the range moved under us; the CSS scale still holds the frame */ }
        done();
      }, ZOOM_DEBOUNCE_MS);
    });
    return this._zoomPending;
  }

  /** Swap to another physical lens, hiding the black gap behind the last frame. */
  async _switchDevice(deviceId) {
    if (this._swapping) await this._swapping.catch(() => {});
    this._swapping = (async () => {
      const overlay = this._freezeFrame();
      const previous = this.stream;
      const wasTorch = this.torchOn;
      try {
        const next = await this._openStream(deviceId);
        if (previous) for (const t of previous.getTracks()) t.stop();
        this.stream = next;
        this._deviceId = deviceId;
        await this._attach(next);
        const active = this.settings.deviceId;
        if (active) this.capsById[active] = this.capabilities;
        if (wasTorch) await this.setTorch(true).catch(() => {});
      } catch {
        // Keep the guest shooting on the lens that still works.
        this.stream = previous;
      } finally {
        fadeOut(overlay);
      }
    })();
    return this._swapping;
  }

  /** Draw the current frame into an overlay canvas pinned over the <video>. */
  _freezeFrame() {
    const parent = this.video?.parentElement;
    const vw = this.video?.videoWidth;
    if (!parent || !vw) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = vw;
      canvas.height = this.video.videoHeight;
      canvas.getContext('2d').drawImage(this.video, 0, 0);
      canvas.setAttribute('aria-hidden', 'true');
      // Inline styles: camera.js must not depend on any stylesheet being loaded.
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;'
        + 'object-fit:cover;z-index:6;pointer-events:none;opacity:1;'
        + `transition:opacity ${CROSSFADE_MS}ms ease-out`;
      if (this.facingMode === 'user') canvas.style.transform = 'scaleX(-1)';
      parent.append(canvas);
      return canvas;
    } catch {
      return null;
    }
  }

  /* --------------------------------------------------------- diagnostics */

  /** Plain text for the ?diag=1 sheet — the couple screenshots this for us. */
  diagnosticsReport() {
    const lines = [
      `UA: ${navigator.userAgent}`,
      `facingMode: ${this.facingMode}   magnification: ${this.magnification.toFixed(2)}×`,
      `active device: ${String(this.settings.deviceId || 'unknown').slice(0, 6)}`,
      `video: ${this.video?.videoWidth || 0}×${this.video?.videoHeight || 0}`,
      `torch capable: ${this.supportsTorch}`,
      // CAMERA-013: which path the last shot actually used, and what it encoded to.
      `still API: ${!!globalThis.ImageCapture}   last capture: ${this.lastCaptureSource || 'none yet'}`,
      `last encode: ${describeEncode(this.lastEncode)}`,
      '',
      `devices (${this.devices.length}):`,
    ];
    for (const d of this.devices) {
      const caps = this.capsById[d.deviceId];
      const zoom = caps?.zoom && typeof caps.zoom === 'object'
        ? `zoom ${caps.zoom.min}–${caps.zoom.max}${caps.zoom.step ? ` step ${caps.zoom.step}` : ''}`
        : (caps ? 'zoom none' : 'not probed');
      const facing = Array.isArray(caps?.facingMode) ? caps.facingMode.join('/') : (caps?.facingMode || '?');
      lines.push(`  ${String(d.deviceId).slice(0, 6)}  "${d.label || '(no label)'}"  facing ${facing}  ${zoom}`);
    }
    lines.push('', describeLadder(this.ladder), '', describeMapping(this.ladder, this.magnification));
    return lines.join('\n');
  }

  /* -------------------------------------------------------------- capture */

  /**
   * Take a photo → JPEG Blob, longest edge ≤MAX_EDGE (CAMERA-007).
   *
   * Two sources, in order of quality (CAMERA-013):
   *   1. `ImageCapture.takePhoto()` — the full-sensor, noise-reduced still the
   *      platform camera app would take. The viewfinder stream is video-quality
   *      (~1080p, heavy temporal denoise, grainy in dim venues); a still is not.
   *   2. A frame grab off the live <video>, exactly as before, whenever the
   *      still API is missing, refuses, or takes too long.
   * Either way the pixels go through the SAME canvas draw, so framing, digital
   * zoom and the front-camera mirror are identical, and the canvas re-encode
   * discards every byte of source metadata — EXIF/GPS included (CAMERA-008).
   * The frame is never shown to the guest (CAMERA-004).
   */
  async capture() {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) throw new Error('camera-not-ready');

    // Torch and native zoom are track constraints that are already applied; on
    // Android they carry into the still as-is, so there is nothing to set here
    // (deliberately no fillLightMode: it would fire the LED a second time).
    const still = await this._takeStill();
    if (still) {
      this.lastCaptureSource = 'still';
      try {
        return await this._encode(this._drawStill(still, vw / vh));
      } finally {
        still.close?.();
      }
    }
    this.lastCaptureSource = 'frame';
    return this._encode(this._drawFrame(vw, vh));
  }

  /**
   * CAMERA-013: a decoded still, or null to fall back. Never throws — every
   * failure mode (no API, dead track, rejection, timeout) means "grab a frame".
   */
  async _takeStill() {
    const track = this.track;
    if (!globalThis.ImageCapture || !track || track.readyState !== 'live') return null;
    try {
      const blob = await withTimeout(takePhoto(track), STILL_TIMEOUT_MS, 'still-timeout');
      if (!blob || !blob.size) throw new Error('still-empty');
      return await decodeStill(blob);
    } catch (err) {
      noteStillFallback(err);
      return null;
    }
  }

  /** The pre-CAMERA-013 path: the live preview frame, cropped by digital zoom. */
  _drawFrame(vw, vh) {
    // Digital zoom: centered crop of 1/factor of the frame, for any factor ≥ 1
    // (CAMERA-010 — between-lens and beyond-the-top-lens ranges both land here).
    const rect = cropByZoom({ sx: 0, sy: 0, sw: vw, sh: vh }, this._captureCrop);
    return drawCrop(this.video, rect, this.facingMode === 'user');
  }

  /**
   * CAMERA-013: a still can be a different shape (and much larger) than the
   * preview, so it is centre-cropped back to what the viewfinder framed before
   * the digital-zoom crop is applied on top of it.
   */
  _drawStill(decoded, previewAspect) {
    const source = decoded.source || decoded;
    const { width, height } = decoded;
    if (!width || !height) throw new Error('still-decode-failed');
    const framed = cropToAspect(width, height, matchOrientation(previewAspect, width / height));
    return drawCrop(source, cropByZoom(framed, this._captureCrop), this.facingMode === 'user');
  }

  /** The digital-zoom factor that applies to a capture right now (≥ 1). */
  get _captureCrop() {
    return this.cropAtCapture ? this.digitalZoom : 1;
  }

  async _encode(canvas) {
    const stats = {};
    const blob = await encodeCanvas(canvas, stats);
    this.lastEncode = stats;
    return blob;
  }
}

/* ------------------------------------------------------- CAMERA-013 stills */

let stillFallbackLogged = false;

/** One line per session, not per shot — the shutter path stays quiet. */
function noteStillFallback(reason) {
  if (stillFallbackLogged) return;
  stillFallbackLogged = true;
  console.info('camera: still capture unavailable, using viewfinder frames', reason);
}

/**
 * `takePhoto()` with no photo settings — the defaults are what the platform
 * camera app uses. A few Androids reject the bare call complaining about
 * constraints; those get exactly one retry with an explicit empty bag.
 */
async function takePhoto(track) {
  const capturer = new ImageCapture(track);
  try {
    return await capturer.takePhoto();
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    return capturer.takePhoto({});
  }
}

function isConstraintError(err) {
  const name = err?.name || '';
  if (name === 'OverconstrainedError' || name === 'NotSupportedError') return true;
  return /constraint|settings/i.test(err?.message || '');
}

/** Reject once the budget is spent so a wedged takePhoto() cannot hold the shutter. */
function withTimeout(promise, ms, label) {
  let timer = null;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** `from-image` so a sensor-orientation EXIF tag is baked into the pixels. */
function decodeStill(blob) {
  return decodeFile(blob, { imageOrientation: 'from-image' });
}

/* ------------------------------------------------------------ canvas maths */

/**
 * A still and the preview can disagree about orientation (a sensor-native
 * portrait still behind a landscape track). Matching the preview's aspect
 * literally would then throw most of the photo away, so the aspect is taken in
 * the still's own orientation — the same framing, read the right way up.
 */
function matchOrientation(previewAspect, sourceAspect) {
  if (!previewAspect || !isFinite(previewAspect)) return sourceAspect;
  const disagree = (previewAspect >= 1) !== (sourceAspect >= 1);
  return disagree ? 1 / previewAspect : previewAspect;
}

/** Largest centred rect of `width`×`height` with the given aspect (w/h). */
function cropToAspect(width, height, aspect) {
  if (!aspect || !isFinite(aspect)) return { sx: 0, sy: 0, sw: width, sh: height };
  const current = width / height;
  let sw = width;
  let sh = height;
  if (current > aspect) sw = Math.max(1, Math.round(height * aspect));
  else if (current < aspect) sh = Math.max(1, Math.round(width / aspect));
  return { sx: Math.round((width - sw) / 2), sy: Math.round((height - sh) / 2), sw, sh };
}

/** Shrink a rect around its own centre by the digital-zoom factor (CAMERA-006). */
function cropByZoom(rect, factor) {
  const f = Math.max(1, Number(factor) || 1);
  if (f === 1) return rect;
  const sw = Math.max(1, Math.round(rect.sw / f));
  const sh = Math.max(1, Math.round(rect.sh / f));
  return {
    sx: rect.sx + Math.round((rect.sw - sw) / 2),
    sy: rect.sy + Math.round((rect.sh - sh) / 2),
    sw,
    sh,
  };
}

/** Draw one crop rect down to ≤MAX_EDGE, mirroring for the front camera. */
function drawCrop(source, rect, mirror) {
  const scale = Math.min(1, MAX_EDGE / Math.max(rect.sw, rect.sh));
  const dw = Math.max(1, Math.round(rect.sw * scale));
  const dh = Math.max(1, Math.round(rect.sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Front camera: mirror so the stored photo matches the mirrored preview.
  if (mirror) {
    ctx.translate(dw, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, dw, dh);
  return canvas;
}

/** One line of encoder telemetry for the ?diag=1 sheet (CAMERA-007/013). */
function describeEncode(stats) {
  if (!stats) return 'none yet';
  const kb = Math.round(stats.bytes / 1024);
  return `${stats.width}×${stats.height}  q${stats.quality}  ${kb}KB  (${stats.steps} step${stats.steps === 1 ? '' : 's'})`;
}

function fadeOut(node) {
  if (!node) return;
  requestAnimationFrame(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), CROSSFADE_MS + 60);
  });
}

/**
 * JPEG-encode a canvas at ≥2560px-friendly quality, stepping down towards
 * ≈2.5MB but never below MIN_QUALITY — grain is worse than bytes (CAMERA-007).
 * This encode is also what strips EXIF/GPS: nothing but pixels reaches the
 * blob (CAMERA-008). `stats` is filled in for the ?diag=1 sheet and the tests.
 */
async function encodeCanvas(canvas, stats = {}) {
  let quality = JPEG_QUALITY;
  let surface = canvas;
  let blob = await toBlob(surface, quality);
  let steps = 0;
  while (blob && blob.size > TARGET_BYTES && quality > MIN_QUALITY) {
    quality = Math.max(MIN_QUALITY, round2(quality - QUALITY_STEP));
    blob = await toBlob(surface, quality);
    steps += 1;
  }
  // Hard floor on quality means a pathological frame could still be huge, and
  // the upload cap is 8MB — resize rather than let it 403 at the bucket.
  while (blob && blob.size > SAFETY_BYTES && Math.max(surface.width, surface.height) > MIN_SAFETY_EDGE) {
    surface = downscale(surface, SAFETY_SCALE);
    blob = await toBlob(surface, quality);
    steps += 1;
  }
  if (!blob) throw new Error('encode-failed');
  stats.width = surface.width;
  stats.height = surface.height;
  stats.quality = quality;
  stats.bytes = blob.size;
  stats.steps = steps;
  return blob;
}

const round2 = (n) => Math.round(n * 100) / 100;

function downscale(canvas, factor) {
  const next = document.createElement('canvas');
  next.width = Math.max(1, Math.round(canvas.width * factor));
  next.height = Math.max(1, Math.round(canvas.height * factor));
  const ctx = next.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, next.width, next.height);
  return next;
}

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

async function decodeFile(file, options) {
  if (globalThis.createImageBitmap) {
    try {
      return options ? await createImageBitmap(file, options) : await createImageBitmap(file);
    } catch { /* fall through */ }
  }
  // Safari/lockdown fallback: decode through an <img> + object URL.
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'sync';
    img.src = url;
    await (img.decode ? img.decode() : new Promise((res, rej) => {
      img.onload = res; img.onerror = rej;
    }));
    return { width: img.naturalWidth, height: img.naturalHeight, source: img };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Native-camera fallback path (CAMERA-009): re-encode a picked file through the
 * same canvas pipeline so EXIF is stripped and size normalized.
 */
export async function reencodeFile(file) {
  const decoded = await decodeFile(file);
  const source = decoded.source || decoded;
  const { width, height } = decoded;
  if (!width || !height) throw new Error('decode-failed');
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const dw = Math.max(1, Math.round(width * scale));
  const dh = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  canvas.getContext('2d').drawImage(source, 0, 0, dw, dh);
  decoded.close?.();
  return encodeCanvas(canvas);
}
