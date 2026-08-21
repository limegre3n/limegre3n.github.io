/**
 * Shared harness for the security-rules suites (CONTRACTS §2–§3, §10).
 *
 * Isolation contract — read before adding a suite:
 *   * Every suite runs under its OWN throwaway project id (`demo-r-*`), so it can seed
 *     and mutate `config/event` freely without touching the shared `demo-wedding` data
 *     other workstreams are developing against.
 *   * We NEVER call clearFirestore()/clearStorage() — the emulator suite is shared.
 *   * withSecurityRulesDisabled is used for fixture setup only (docs the rules
 *     deliberately make unwritable from a client: photos, results, counters, config).
 *   * Uids and uuids are unique per test so parallel suites cannot collide.
 *
 * Storage caveat: unlike Firestore rules (which are per project id), the Storage
 * emulator keeps ONE global ruleset for every bucket, loaded from `firebase.json` →
 * `storage.rules`. We therefore do NOT push storage rules from the tests: uploading
 * them would replace the ruleset every other workstream is testing against, and
 * concurrent pushes to the emulator's `/internal/setRules` endpoint are what wedge it.
 * The suites run against the ruleset the emulator loaded from the repo file, so after
 * editing `storage.rules` give the emulator a moment to pick the change up (and if the
 * storage suites suddenly fail wholesale, restart the emulator: its rules-reload path
 * is the thing that broke, not the rules).
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIRESTORE_RULES = readFileSync(join(ROOT, 'firestore.rules'), 'utf8');

/**
 * Emulator endpoints. Defaults are the firebase.json ports (CONTRACTS §10); the EMU_*
 * overrides exist so the suite can be pointed at a private emulator instance when the
 * shared one is busy or unhealthy.
 */
export const EMU = {
  host: process.env.EMU_HOST || '127.0.0.1',
  firestorePort: Number(process.env.EMU_FIRESTORE_PORT || 8080),
  storagePort: Number(process.env.EMU_STORAGE_PORT || 9199),
  authPort: Number(process.env.EMU_AUTH_PORT || 9099),
  functionsPort: Number(process.env.EMU_FUNCTIONS_PORT || 5001),
  projectId: process.env.EMU_PROJECT || 'demo-wedding',
};

export const DEFAULT_SNAPS = 10;
export const EVENT_CAP = 2500;

/** 1x1 white JPEG (valid FF D8 FF magic bytes + SOF0 header). */
export const TINY_JPEG = new Uint8Array(Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64'));

let counter = 0;
/** Unique uid per call — parallel suites share the emulator. */
export function uid(prefix = 'u') {
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
}

export const uuid = () => randomUUID();

const CONFIG_LOCK = join(tmpdir(), 'wedding-camera-shared-config.lock');

/**
 * Mutex for the few cases that must temporarily change the SHARED `demo-wedding`
 * `config/event` (release the gallery, close the window). `node --test <dir>` runs test
 * files in parallel, so without this two suites could flip the same flag and read each
 * other's state. Directory creation is the atomic primitive; a lock older than 60s is
 * treated as abandoned by a crashed run.
 */
export async function withSharedConfig(fn) {
  const deadline = Date.now() + 120000;
  for (;;) {
    try {
      mkdirSync(CONFIG_LOCK);
      break;
    } catch {
      try {
        if (Date.now() - statSync(CONFIG_LOCK).mtimeMs > 60000) {
          rmSync(CONFIG_LOCK, { recursive: true, force: true });
          continue;
        }
      } catch { /* lock vanished — retry immediately */ }
      if (Date.now() > deadline) throw new Error('timed out waiting for the shared config lock');
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(CONFIG_LOCK, { recursive: true, force: true });
  }
}

/** Canonical config/event fixture (mirrors scripts/seed.js). */
export function eventConfig(overrides = {}) {
  const now = Date.now();
  return {
    slug: 'testslug123',
    coupleNames: 'Alex & Sam',
    eventDateText: 'Saturday, 12 September 2026',
    startAt: new Date(now - 60 * 60 * 1000),
    endAt: new Date(now + 24 * 60 * 60 * 1000),
    paused: false,
    defaultSnaps: DEFAULT_SNAPS,
    galleryReleased: false,
    theme: {
      welcomeText: 'Grab the camera!',
      consentText: 'Photos are shared with the couple.',
      colors: { bg: '#141210', accent: '#e8b04b', text: '#f5efe6' },
      font: 'system',
      monogramText: 'A♥S',
      heroImagePath: null,
    },
    ...overrides,
  };
}

/** Fresh test environment on an isolated project id. */
export async function makeEnv(label) {
  return initializeTestEnvironment({
    projectId: `demo-r-${label}-${randomUUID().slice(0, 6)}`.slice(0, 30),
    firestore: { rules: FIRESTORE_RULES, host: EMU.host, port: EMU.firestorePort },
    // Storage rules intentionally not pushed — see the header note.
    storage: { host: EMU.host, port: EMU.storagePort },
  });
}

/** Seed config/event (+ private, counters) as the server would. */
export async function seedConfig(env, overrides = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'config', 'event'), eventConfig(overrides));
    await setDoc(doc(db, 'config', 'private'), {
      eventCap: EVENT_CAP,
      galleryPinSalt: 'test-salt',
      galleryPinHash: 'deadbeef',
      deleteBy: new Date(Date.now() + 90 * 86400000),
    });
    await setDoc(doc(db, 'counters', 'event'), { photoCount: 0 });
  });
}

/** Patch config/event as the server/console would (bypassing rules). */
export async function patchConfig(env, patch) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'config', 'event'), patch);
  });
}

/** Write a photos/{uuid} doc the way onUploadFinalize would. Returns the uuid. */
export async function seedPhoto(env, { deviceUid, status = 'visible', id = randomUUID() } = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'photos', id), {
      deviceUid,
      nickname: 'Seeded',
      storagePath: `uploads/${deviceUid}/${id}`,
      byteSize: 1234,
      width: 100,
      height: 100,
      capturedAt: new Date(),
      receivedAt: new Date(),
      status,
      rotation: 0,
    });
  });
  return id;
}

/** Write a results/{uuid} doc the way onUploadFinalize would. */
export async function seedResult(env, { id = randomUUID(), deviceUid, ok = true, reason = null } = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'results', id), { deviceUid, ok, reason, at: new Date() });
  });
  return id;
}

/** Write a devices/{uid} doc bypassing rules (for update-path tests). */
export async function seedDevice(env, deviceUid, overrides = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'devices', deviceUid), {
      nickname: 'Seeded Guest',
      snapsRemaining: DEFAULT_SNAPS,
      snapsGranted: 0,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      consentShownAt: new Date(),
      ...overrides,
    });
  });
}

/**
 * Health probe: is a Storage ruleset actually loaded in the emulator?
 * The Storage emulator fails EVERY rules-evaluated request closed when its ruleset is
 * missing (it logs "Permission denied because no Storage ruleset is currently loaded"),
 * which otherwise looks exactly like a wholesale rules regression. Returns null when
 * healthy, or a human-readable reason to skip the storage suites.
 */
export async function storageRulesUnavailable(env) {
  const probe = `theme/_health-${randomUUID().slice(0, 8)}.jpg`;
  try {
    await uploadBytes(ref(env.authenticatedContext(uid('health'), { admin: true }).storage(), probe),
      TINY_JPEG, { contentType: 'image/jpeg' });
    return null;
  } catch (err) {
    if (err && (err.code === 'storage/unauthorized' || err.code === 'storage/unauthenticated')) {
      return 'Storage emulator has NO ruleset loaded (admin write to theme/ was denied). '
        + 'This is an emulator state problem, not a rules failure: the emulator\'s rules '
        + 'reload endpoint wedges after concurrent pushes. Restart the emulator suite '
        + '(then `node scripts/seed.js`) and re-run. If it persists, the theme/ write rule '
        + 'genuinely regressed.';
    }
    throw err;
  }
}

/** Seed a storage object bypassing rules. */
export async function seedObject(env, path, bytes = TINY_JPEG, contentType = 'image/jpeg') {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), path), bytes, { contentType });
  });
}

/** A well-formed device-create payload. */
export function devicePayload(overrides = {}) {
  return {
    nickname: 'Guest One',
    snapsRemaining: DEFAULT_SNAPS,
    snapsGranted: 0,
    createdAt: new Date(),
    lastSeenAt: new Date(),
    consentShownAt: new Date(),
    ...overrides,
  };
}
