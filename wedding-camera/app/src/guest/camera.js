/**
 * Camera capture pipeline (workstream ① — contract: docs/CONTRACTS.md §8).
 * getUserMedia acquisition, flip, torch/zoom capability detection,
 * canvas re-encode to ≤2048px JPEG (strips all EXIF/GPS — CAMERA-007/008).
 */

const MAX_EDGE = 2048;
const JPEG_QUALITY = 0.8;

export class Camera {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.facingMode = 'environment';
    this.digitalZoom = 1;
    this.torchOn = false;

    document.addEventListener('visibilitychange', () => {
      // iOS Safari kills tracks on backgrounding — re-acquire when visible (CONTRACTS §8).
      if (document.visibilityState === 'visible' && this.stream) {
        const track = this.stream.getVideoTracks()[0];
        if (!track || track.readyState === 'ended') this.start().catch(() => {});
      }
    });
  }

  get track() {
    return this.stream?.getVideoTracks()[0] || null;
  }

  get capabilities() {
    try { return this.track?.getCapabilities?.() || {}; } catch { return {}; }
  }

  get supportsTorch() { return this.capabilities.torch === true; }
  get supportsNativeZoom() { return typeof this.capabilities.zoom === 'object' || typeof this.capabilities.zoom === 'number' || !!this.capabilities.zoom; }

  async start() {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: this.facingMode, width: { ideal: MAX_EDGE } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play().catch(() => {});
    this.torchOn = false;
    await this.applyZoom(this.digitalZoom).catch(() => {});
  }

  stop() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
  }

  async flip() {
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
    await this.start();
    return this.facingMode;
  }

  async setTorch(on) {
    if (!this.supportsTorch) return false;
    await this.track.applyConstraints({ advanced: [{ torch: on }] });
    this.torchOn = on;
    return true;
  }

  /** zoom is a factor 1..2; native constraint where supported, else CSS+crop. */
  async applyZoom(zoom) {
    this.digitalZoom = Math.min(Math.max(zoom, 1), 2);
    if (this.track && this.supportsNativeZoom) {
      const cap = this.capabilities.zoom;
      const min = cap.min ?? 1;
      const max = cap.max ?? 2;
      const value = Math.min(Math.max(min * this.digitalZoom, min), max);
      await this.track.applyConstraints({ advanced: [{ zoom: value }] }).catch(() => {});
      this.video.style.transform = '';
      this.cropAtCapture = false;
    } else {
      this.video.style.transform = this.digitalZoom > 1 ? `scale(${this.digitalZoom})` : '';
      this.cropAtCapture = this.digitalZoom > 1;
    }
  }

  /**
   * Capture the current frame → JPEG Blob ≤2048px longest edge.
   * Canvas re-encode discards every byte of source metadata (EXIF/GPS).
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
    const dw = Math.round(sw * scale);
    const dh = Math.round(sh * scale);

    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d');
    // Front camera: mirror back so the stored photo matches reality.
    if (this.facingMode === 'user') {
      ctx.translate(dw, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, dw, dh);

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) throw new Error('encode-failed');
    return blob;
  }
}

/**
 * Native-camera fallback path (CAMERA-009): re-encode a picked file through the
 * same canvas pipeline so EXIF is stripped and size normalized.
 */
export async function reencodeFile(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const dw = Math.round(bitmap.width * scale);
  const dh = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, dw, dh);
  bitmap.close?.();
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error('encode-failed');
  return blob;
}
