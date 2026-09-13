/**
 * Node-side helpers for the queue E2E suite (workstream ②).
 *
 * The suite never touches the guest UI. `harness.html` + `harness.js` are served
 * straight from the Vite dev server through its `/@fs/` prefix, so the page has
 * the real Vite origin (localhost:5173) — IndexedDB, the Firebase SDK and the
 * emulator wiring in `src/lib/firebase.js` all behave exactly as in the app.
 *
 * NOTE: the document must be served over the network, not via `route.fulfill`.
 * A fulfilled main document has no remote IP, so Chromium classifies it in the
 * `public` address space and Private Network Access silently stalls every
 * request to the loopback emulators.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const HARNESS_URL = `http://localhost:5173/@fs${path.join(HERE, 'harness.html')}`;

export const EMULATOR_FIRESTORE = '127.0.0.1:8080';
export const PROJECT_ID = 'demo-wedding';
const FS_BASE = `http://${EMULATOR_FIRESTORE}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const FS_HEADERS = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

/** Loads the harness page and waits for `window.__h`. Survives page.reload(). */
export async function openHarness(page) {
  await page.goto(HARNESS_URL);
  await waitForHarness(page);
}

export async function waitForHarness(page) {
  await page.waitForFunction(() => window.__h?.ready === true, null, { timeout: 30_000 });
}

// Stable references: page.unroute() matches the matcher/handler by identity.
const isStorageEmulator = (url) => url.port === '9199';
const abortRoute = (route) => route.abort('internetdisconnected');

/** Blocks only Storage-emulator traffic, leaving the app itself loadable. */
export async function blockUploads(page) {
  await page.route(isStorageEmulator, abortRoute);
}

export async function unblockUploads(page) {
  await page.unroute(isStorageEmulator, abortRoute);
}

/**
 * Preflight: the Storage emulator drops its ruleset if the rules file ever fails
 * to compile, and its rules runtime does not always recover — every guest upload
 * then 403s with "no loaded ruleset", which looks exactly like a queue bug.
 * Probing with an UNAUTHENTICATED request keeps this read-only: both states are
 * 403, only the message differs.
 */
export async function assertStorageRulesLoaded() {
  const url = `http://127.0.0.1:9199/v0/b/demo-wedding.appspot.com/o`
    + `?uploadType=media&name=uploads/preflight/preflight`;
  let res;
  let body = '';
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: 'x' });
    body = await res.text();
  } catch (err) {
    throw new Error(`Storage emulator unreachable on 127.0.0.1:9199 (${err.message}). `
      + 'Start it with: firebase emulators:start --project demo-wedding');
  }
  if (/no loaded ruleset/i.test(body)) {
    throw new Error('Storage emulator has NO loaded ruleset — every guest upload will 403 '
      + 'regardless of the queue. storage.rules failed to compile at some point and the '
      + 'emulator\'s rules runtime is wedged (PUT /internal/setRules hangs). '
      + 'Fix: restart the emulator suite, then re-seed with '
      + 'FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed.js');
  }
}

export const pending = (page) => page.evaluate(() => window.__h.pending());
export const events = (page) => page.evaluate(() => window.__h.events);
export const pageErrors = (page) => page.evaluate(() => window.__h.errors);

export async function firestoreGet(docPath) {
  const res = await fetch(`${FS_BASE}/${docPath}`, { headers: FS_HEADERS });
  if (!res.ok) throw new Error(`emulator GET ${docPath} → ${res.status}`);
  return res.json();
}

export async function snapsRemaining(uid) {
  const doc = await firestoreGet(`devices/${uid}`);
  return Number(doc.fields.snapsRemaining.integerValue);
}

/**
 * Sets snapsRemaining out-of-band (Firestore emulator REST, owner auth) — the
 * client is forbidden from writing quota fields by firestore.rules, so quota
 * exhaustion has to be arranged server-side.
 */
export async function setSnapsRemaining(uid, value) {
  const url = `${FS_BASE}/devices/${uid}?updateMask.fieldPaths=snapsRemaining`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: FS_HEADERS,
    body: JSON.stringify({ fields: { snapsRemaining: { integerValue: String(value) } } }),
  });
  if (!res.ok) throw new Error(`emulator PATCH devices/${uid} → ${res.status} ${await res.text()}`);
}

/** Admin-only pause switch on the SHARED config/event — always restore in a finally. */
export async function setPaused(value) {
  const url = `${FS_BASE}/config/event?updateMask.fieldPaths=paused`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: FS_HEADERS,
    body: JSON.stringify({ fields: { paused: { booleanValue: !!value } } }),
  });
  if (!res.ok) throw new Error(`emulator PATCH config/event → ${res.status} ${await res.text()}`);
}

export async function resultExists(uuid) {
  const res = await fetch(`${FS_BASE}/results/${uuid}`, { headers: FS_HEADERS });
  return res.status === 200;
}

const AUTH_BASE = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';

/**
 * Mints a throwaway admin user in the auth emulator and returns a fresh ID token
 * carrying `{admin:true}`. The `Bearer owner` credential is the emulator's built-in
 * privileged identity, so no service-account key is needed.
 */
async function adminIdToken() {
  const email = `e2e-admin-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const password = 'pw123456';
  const signUp = await fetch(`${AUTH_BASE}/accounts:signUp?key=demo-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  }).then((r) => r.json());
  await fetch(`${AUTH_BASE}/projects/${PROJECT_ID}/accounts:update`, {
    method: 'POST',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ localId: signUp.localId, customAttributes: JSON.stringify({ admin: true }) }),
  });
  // Re-sign-in so the token actually carries the freshly written claim.
  const signIn = await fetch(`${AUTH_BASE}/accounts:signInWithPassword?key=demo-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  }).then((r) => r.json());
  return signIn.idToken;
}

/** Runs the admin reconciliation sweep (CONTRACTS §5) against the functions emulator. */
export async function reconcileNow(data = {}) {
  const token = await adminIdToken();
  const res = await fetch(`http://127.0.0.1:5001/${PROJECT_ID}/asia-southeast1/reconcileNow`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(`reconcileNow failed: ${JSON.stringify(body)}`);
  return body.result;
}

/* ==========================================================================
   Fake camera for the zoom suite (CAMERA-006 / CAMERA-010).

   Chromium's own `--use-fake-device-for-media-stream` gives one camera with no
   zoom capability and no useful label, which is exactly the ONE case the lens
   ladder does not need to reason about. `installFakeCamera` replaces
   navigator.mediaDevices with a scripted one so a test can pose as an iPhone
   with a virtual multi-lens device, a phone with several fixed lenses, or a
   plain single camera — and can then read back every applyConstraints call the
   app made. The tracks are real (canvas.captureStream), so <video> really plays
   and `Camera.capture()` really re-encodes pixels.
   ========================================================================== */

/** Device/capability fixtures mirroring tests/unit/lens.test.mjs. */
export const CAMERA_FIXTURES = {
  /** iPhone 12-class: one virtual device whose native 1.0 IS the ultra-wide. */
  dualWide: [
    {
      deviceId: 'back-dual-wide',
      label: 'Back Dual Wide Camera',
      caps: { facingMode: ['environment'], zoom: { min: 1, max: 8, step: 0.1 } },
    },
    { deviceId: 'front-cam', label: 'Front Camera', caps: { facingMode: ['user'] } },
  ],
  /** Single back camera, no zoom capability — the digital 1–2× fallback. */
  single: [
    { deviceId: 'back-plain', label: 'Back Camera', caps: { facingMode: ['environment'] } },
  ],
  /** Two fixed back lenses, neither zoomable — stream-switching ladder. */
  discrete: [
    { deviceId: 'back-ultra', label: 'Back Ultra Wide Camera', caps: { facingMode: ['environment'] } },
    { deviceId: 'back-wide', label: 'Back Camera', caps: { facingMode: ['environment'] } },
  ],
};

/**
 * Installs the fake before any page script runs. Exposes `window.__cam`:
 *   .applied  — [{ deviceId, constraints }] every applyConstraints call, in order
 *   .opened   — [deviceId | facingMode] every getUserMedia call, in order
 *   .zooms(deviceId?) — just the zoom values, newest last
 */
export async function installFakeCamera(page, devices) {
  await page.addInitScript((fixture) => {
    const log = { applied: [], opened: [], granted: false };
    log.zooms = (deviceId) => log.applied
      .filter((a) => (!deviceId || a.deviceId === deviceId))
      .map((a) => a.constraints?.advanced?.[0]?.zoom)
      .filter((z) => z !== undefined);
    window.__cam = log;

    const SIZE = { width: 1280, height: 720 };

    /** A canvas that keeps painting, so the track really delivers frames. */
    function makeTrack(dev) {
      const canvas = document.createElement('canvas');
      canvas.width = SIZE.width;
      canvas.height = SIZE.height;
      const ctx = canvas.getContext('2d');
      let frame = 0;
      const paint = () => {
        // A frame-filling border plus a centred block: cropping at capture is
        // visible in the output dimensions AND in the pixels.
        ctx.fillStyle = '#8c1f1f';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#2f6d3a';
        ctx.fillRect(120, 68, canvas.width - 240, canvas.height - 136);
        ctx.fillStyle = '#e8b04b';
        ctx.fillRect(canvas.width / 2 - 60, canvas.height / 2 - 60 + (frame % 3), 120, 120);
        frame += 1;
      };
      paint();
      const timer = setInterval(paint, 66);
      const stream = canvas.captureStream(15);
      const track = stream.getVideoTracks()[0];
      const caps = Object.assign({ deviceId: dev.deviceId }, dev.caps || {});
      track.getCapabilities = () => JSON.parse(JSON.stringify(caps));
      track.getSettings = () => ({ deviceId: dev.deviceId, width: SIZE.width, height: SIZE.height });
      track.applyConstraints = async (constraints) => {
        log.applied.push({ deviceId: dev.deviceId, constraints: JSON.parse(JSON.stringify(constraints || {})) });
      };
      try { Object.defineProperty(track, 'label', { get: () => dev.label, configurable: true }); } catch { /* ignore */ }
      const stopAll = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stopAll(); };
      return stream;
    }

    function pick(constraints) {
      const video = constraints?.video || {};
      const exact = video.deviceId?.exact || video.deviceId;
      if (typeof exact === 'string') {
        const hit = fixture.find((d) => d.deviceId === exact);
        if (hit) return hit;
        const err = new Error('device not found');
        err.name = 'OverconstrainedError';
        throw err;
      }
      const want = video.facingMode?.exact || video.facingMode || 'environment';
      return fixture.find((d) => (d.caps?.facingMode || []).includes(want)) || fixture[0];
    }

    const fake = {
      async getUserMedia(constraints) {
        const dev = pick(constraints);
        log.granted = true;
        log.opened.push(dev.deviceId);
        return makeTrack(dev);
      },
      async enumerateDevices() {
        // Labels are empty until permission is granted — the real behaviour the
        // lens heuristics have to survive.
        return fixture.map((d) => ({
          deviceId: d.deviceId,
          kind: 'videoinput',
          label: log.granted ? d.label : '',
          groupId: 'grp',
          toJSON() { return this; },
        }));
      },
      getSupportedConstraints: () => ({ zoom: true, torch: true, facingMode: true }),
      addEventListener() {},
      removeEventListener() {},
    };
    Object.defineProperty(navigator, 'mediaDevices', { value: fake, configurable: true });
  }, devices);
}

/**
 * Drives the guest page to a live viewfinder: registers the phone if the
 * welcome card appears, then waits for the stream. Returns nothing; throws on
 * any terminal card (closed window, denied camera) so failures are legible.
 */
export async function openViewfinder(page, nickname = 'Zoom Tester') {
  const app = page.locator('#app');
  await page.waitForFunction(
    () => document.getElementById('app')?.dataset.state
      && document.getElementById('app').dataset.state !== 'loading',
    null,
    { timeout: 30_000 },
  );
  const state = await app.getAttribute('data-state');
  if (state === 'welcome') {
    await page.fill('#guest-nickname', nickname);
    await page.click('.btn--primary');
  }
  await page.waitForFunction(
    () => document.getElementById('app')?.dataset.camera === 'live',
    null,
    { timeout: 45_000 },
  );
}
