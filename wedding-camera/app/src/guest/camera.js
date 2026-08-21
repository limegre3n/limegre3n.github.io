/**
 * Camera capture pipeline (workstream ① — contract: docs/CONTRACTS.md §8).
 * getUserMedia acquisition, flip, torch/zoom capability detection,
 * canvas re-encode to ≤2048px JPEG (strips all EXIF/GPS — CAMERA-007/008).
 *
 * Public API (frozen): class Camera { start, stop, flip, setTorch, applyZoom,
 * capture, supportsTorch, supportsNativeZoom, facingMode } and reencodeFile(file).
 * `dispose()` is additive: it stops the stream AND detaches the lifecycle
 * listeners so repeated mounts of the viewfinder cannot leak handlers.
 */

const MAX_EDGE = 2048;
const JPEG_QUALITY = 0.8;
/** CAMERA-007 target size; we step quality down a little rather than resize. */
const TARGET_BYTES = 1_000_000;
const MIN_QUALITY = 0.55;

export class Camera {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.facingMode = 'environment';
    this.digitalZoom = 1;
    this.torchOn = false;
    this.cropAtCapture = false;
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

  get supportsTorch() { return this.capabilities.torch === true; }

  get supportsNativeZoom() {
    const zoom = this.capabilities.zoom;
    if (!zoom) return false;
    if (typeof zoom === 'number') return true;
    if (typeof zoom === 'object') return (zoom.max ?? 1) > (zoom.min ?? 1);
    return false;
  }

  async start() {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      const err = new Error('getUserMedia-unavailable');
      err.name = 'NotSupportedError';
      throw err;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: this.facingMode, width: { ideal: MAX_EDGE } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    this.video.dataset.facing = this.facingMode;
    await this.video.play().catch(() => {});
    // Wait briefly for real frame dimensions so the first capture can't race.
    await this._awaitDimensions();
    this.torchOn = false;
    await this.applyZoom(this.digitalZoom).catch(() => {});
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
    this.facingMode = previous === 'environment' ? 'user' : 'environment';
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

  /** zoom is a factor 1..2; native constraint where supported, else CSS + crop. */
  async applyZoom(zoom) {
    this.digitalZoom = Math.min(Math.max(Number(zoom) || 1, 1), 2);
    let native = false;
    if (this.track && this.supportsNativeZoom) {
      const cap = this.capabilities.zoom;
      const min = (typeof cap === 'object' ? cap.min : 1) ?? 1;
      const max = (typeof cap === 'object' ? cap.max : this.digitalZoom) ?? this.digitalZoom;
      const value = Math.min(Math.max(min * this.digitalZoom, min), max);
      try {
        await this.track.applyConstraints({ advanced: [{ zoom: value }] });
        native = true;
      } catch { native = false; }
    }
    // The stylesheet composes --zoom with the front-camera mirror.
    this.video.style.setProperty('--zoom', native ? '1' : String(this.digitalZoom));
    this.cropAtCapture = !native && this.digitalZoom > 1;
    return native;
  }

  /**
   * Capture the current frame → JPEG Blob ≤2048px longest edge.
   * Canvas re-encode discards every byte of source metadata (EXIF/GPS).
   * The frame is never shown to the guest (CAMERA-004).
   */
  async capture() {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) throw new Error('camera-not-ready');

    // Digital zoom: centered crop of 1/zoom of the frame.
    const crop = this.cropAtCapture ? this.digitalZoom : 1;
    const sw = Math.round(vw / crop);
    const sh = Math.round(vh / crop);
    const sx = Math.round((vw - sw) / 2);
    const sy = Math.round((vh - sh) / 2);

    const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d');
    // Front camera: mirror so the stored photo matches the mirrored preview.
    if (this.facingMode === 'user') {
      ctx.translate(dw, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, dw, dh);

    return encodeCanvas(canvas);
  }
}

/** JPEG-encode a canvas, stepping quality down until ≈≤1MB (CAMERA-007). */
async function encodeCanvas(canvas) {
  let quality = JPEG_QUALITY;
  let blob = await toBlob(canvas, quality);
  while (blob && blob.size > TARGET_BYTES && quality > MIN_QUALITY) {
    quality = Math.max(MIN_QUALITY, quality - 0.12);
    blob = await toBlob(canvas, quality);
  }
  if (!blob) throw new Error('encode-failed');
  return blob;
}

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

async function decodeFile(file) {
  if (globalThis.createImageBitmap) {
    try { return await createImageBitmap(file); } catch { /* fall through */ }
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
