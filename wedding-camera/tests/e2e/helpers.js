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
  const res = await fetch(`http://127.0.0.1:5001/${PROJECT_ID}/us-central1/reconcileNow`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(`reconcileNow failed: ${JSON.stringify(body)}`);
  return body.result;
}
