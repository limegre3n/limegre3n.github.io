# CONTRACTS.md — Technical interfaces (frozen after PoC)

> Single source of truth for cross-workstream interfaces. **Only the orchestrator edits
> this file.** If your implementation needs a contract change, stop and report — do not
> unilaterally diverge. Version: v1 (post-PoC freeze pending).

## 0. Stack & layout

- Platform: **Firebase** — Hosting, Anonymous Auth + Email/Password (admin), Firestore,
  Cloud Storage, Cloud Functions (Node 20). Local dev/tests run entirely on the
  **Firebase Emulator Suite** with project id `demo-wedding` (offline, no account).
- Frontend: static multi-page **Vite** app, vanilla JS (ES modules), no framework.
  Firebase Web SDK v10 (modular). No other runtime dependencies without orchestrator approval.
- Repo layout:

```
wedding-camera/
  docs/PRD.md, CONTRACTS.md
  firebase.json, .firebaserc, firestore.rules, firestore.indexes.json, storage.rules
  app/                  # Vite root
    index.html          # guest camera (routes below)
    admin/index.html
    gallery/index.html
    src/
      lib/firebase.js   # SDK init + emulator wiring (shared)
      lib/theme.js      # EventConfig theme → CSS custom properties (shared)
      guest/            # workstream ① UI + ② engine
        camera.js       # capture pipeline (getUserMedia, canvas re-encode)
        queue.js        # IndexedDB queue + uploader (workstream ②)
        main.js         # guest state machine (workstream ①)
      admin/main.js     # workstream ④
      gallery/main.js   # workstream ④
  functions/            # workstream ③ (Node 20, JS)
    index.js
    package.json
  tests/
    rules/              # @firebase/rules-unit-testing suites (workstream ③)
    e2e/                # Playwright (integration phase)
  scripts/set-admin.js  # one-time admin-claim bootstrap (service account / emulator)
  README.md
```

## 1. URL scheme

- Guest camera: `/e/{eventSlug}/` (also the QR target). `eventSlug` = random 10-char base32.
- Admin: `/admin/` · Gallery: `/gallery/{eventSlug}/`.
- Any unknown slug → "Invalid link" state. Slug checked against `config/event.slug`.

## 2. Firestore document shapes

All timestamps are Firestore `Timestamp`. Collection names are literal.

### `config/event` — public event config (guest/gallery readable)
```js
{
  slug: string,
  coupleNames: string,          // "A & B"
  eventDateText: string,        // display string
  startAt: Timestamp, endAt: Timestamp,   // upload window (D17)
  paused: boolean,
  defaultSnaps: number,         // 10
  galleryReleased: boolean,
  theme: {
    welcomeText: string, consentText: string,
    colors: { bg: string, accent: string, text: string },  // hex
    font: 'system' | 'serif' | 'mono' | 'rounded',          // safe list only
    monogramText: string,       // e.g. "A♥B"
    heroImagePath: string|null  // storage path under theme/
  }
}
```

### `config/private` — server/admin only (NO guest/gallery read)
```js
{ eventCap: number /*2500*/, galleryPinHash: string /*sha256(salt+pin) hex*/, galleryPinSalt: string, deleteBy: Timestamp }
```

### `devices/{uid}` — uid = Anonymous Auth uid
```js
{ nickname: string /*1..30 chars*/, snapsRemaining: number, snapsGranted: number,
  createdAt: Timestamp, lastSeenAt: Timestamp, consentShownAt: Timestamp }
```
- **Create**: client, only own uid, **only while `startAt <= request.time <= endAt`**
  (joining is window-gated — the leaked-QR control), `snapsRemaining == config/event.defaultSnaps`,
  `snapsGranted == 0`, nickname length-validated. One-time (no client delete).
- **Update**: client may update `lastSeenAt` ONLY. Quota fields: functions/admin only.

### `photos/{uuid}` — created ONLY by the finalize function
```js
{ deviceUid: string, nickname: string /*denormalized*/, storagePath: string,
  byteSize: number, width: number, height: number,
  capturedAt: Timestamp /*client-claimed*/, receivedAt: Timestamp /*server*/,
  status: 'visible'|'hidden', rotation: 0|90|180|270 }
```
- Admin may update `status` and `rotation` only.

### `results/{uuid}` — upload outcome, created ONLY by finalize function
```js
{ deviceUid: string, ok: boolean,
  // 'paused' is retained for historical docs only — a pause now DEFERS (§5), so the
  // finalize function never writes it and clients never observe it.
  reason: null | 'quota'|'cap'|'window'|'invalid'|'duplicate',
  at: Timestamp }
```
- Readable only by the owning device (and admin). This is the client's confirmation signal.

### `counters/event` — maintained ONLY by finalize function
```js
{ photoCount: number }   // accepted photos, compared against config/private.eventCap
```

### `audit/{autoId}` — admin actions (ADMIN-008)
```js
{ action: 'hide'|'unhide'|'rotate'|'pause'|'resume'|'grant'|'release'|'export',
  target: string|null /*photo uuid or device uid*/, actorUid: string, at: Timestamp }
```
- Create: admin only. No update/delete.

### `pinAttempts/{uid}` — function-managed rate limiting. No client access.

## 3. Storage paths & rules behaviour

- `uploads/{uid}/{uuid}` — guest upload target (**no file extension** — the bare UUID is
  the object name so Storage rules can reference `photos/{uuid}` directly; contentType
  `image/jpeg` carries the type).
  - **Write**: `request.auth.uid == uid`, write-once (no overwrite/delete),
    `contentType == 'image/jpeg'`, `size <= 8MB` (UPLOAD-007 pre-filter; authoritative
    validation in finalize function).
  - **Read**: admin claim only, or gallery claim + released + Firestore
    `photos/{uuid}.status == 'visible'` (cross-service `firestore.get`).
- `theme/…` — hero/monogram images. Read: any signed-in user. Write: admin.
- `exports/{exportId}.zip` — ZIP outputs. Read: admin only (served via signed URL from fn).

## 4. Auth & claims

- Guests + gallery viewers: **Anonymous Auth** (`signInAnonymously` on first load).
- Admin: email+password user with custom claim `{ admin: true }`, set once via
  `scripts/set-admin.js` (documented in README; run against emulator or prod with SA key).
- Gallery: callable `verifyGalleryPin` sets `{ gallery: true }` claim on the caller's
  anonymous user; client must `getIdToken(true)` after success.

## 5. Cloud Functions (workstream ③)

### `processUpload({ bucketName, filePath, size, metadata })` — shared acceptance pipeline
Authoritative acceptance pipeline, used by BOTH the storage trigger and reconciliation.
Steps (order matters):
1. Parse `{uid, uuid}` from path; malformed → delete object, write `results/{uuid}` invalid (if uuid parseable).
2. **Idempotency**: in a Firestore transaction, if `photos/{uuid}` or `results/{uuid}` exists → exit (duplicate). 
3. Download head bytes; **magic-byte check** JPEG (`FF D8 FF`) (UPLOAD-007). Size ≤ 8MB.
4. Read `config/event`, `config/private`, `counters/event`, `devices/{uid}` in the transaction; then:
   - `now < startAt` → reject `window` (rules forbid creating a device this early, so
     nothing legitimate can be in flight);
   - `now > endAt + UPLOAD_GRACE_MS` (**7 days**, a code constant — no config field, no
     deployment change) → reject `window`;
   - between `endAt` and `endAt + UPLOAD_GRACE_MS` → **accept normally**. Joining is
     window-gated in `firestore.rules`, uploading is not: a phone that lost signal at the
     venue must still be able to deliver its queued film days later;
   - `paused` → **DEFER** (see below), never reject;
   - `photoCount >= eventCap` → `cap`; no device doc → `invalid`; `snapsRemaining <= 0` → `quota`.
5. Reject ⇒ delete storage object + write `results/{uuid}{ok:false,reason}` (never decrement).
6. **Defer** ⇒ write NOTHING and delete NOTHING. The object stays in the bucket, the client
   keeps waiting, and the upload is retried later (trigger retry + reconciliation). `paused`
   is therefore no longer a `results.reason` the client can ever observe.
7. Accept ⇒ atomically: `snapsRemaining -= 1`, `photoCount += 1`, create `photos/{uuid}`
   (status `visible`, dims read from JPEG header), create `results/{uuid}{ok:true}`.

### `onUploadFinalize` — Storage `onObjectFinalized` on `uploads/{uid}/{uuid}`, `retry: true`
Thin wrapper around `processUpload`. A `deferred` outcome is re-thrown as a tagged error so
Eventarc redelivers the event with exponential backoff (bounded at 24h in production; the
emulator does not retry at all — reconciliation is the durable safety net either way).

### `reconcileUploads` — scheduled, `every 15 minutes`
Lists objects under `uploads/`, and for each object older than 5 minutes that has **no**
`results/{uuid}` doc, runs `processUpload`. Covers a crashed finalize, an exhausted retry
budget, and objects deferred while the event was paused (accepted on the first sweep after
an admin resumes). Idempotent by construction — the `results/{uuid}` check inside
`processUpload` and again inside its transaction means a sweep racing the trigger can only
ever produce one photo and one decrement.

### `reconcileNow` — callable `{ minAgeMs?: number, prefix?: string }` → `{ scanned, accepted, rejected, deferred }`
Admin claim required (`request.auth.token.admin === true`). Runs the same sweep immediately:
the emergency "send everything now" button, and the only way tests can exercise
reconciliation (the emulator never fires schedules). `minAgeMs` (default 5 min) and `prefix`
(must start with `uploads/`) are call-scoped knobs, **not** configuration.

### `verifyGalleryPin` — callable `{ pin: string }` → `{ ok: boolean, retryAfterSec?: number }`
- Requires auth. Rate limit via `pinAttempts/{uid}`: max 5 fails / 15 min → `retryAfterSec`.
- `sha256(salt + pin) == galleryPinHash` and `galleryReleased` ⇒ set `gallery` claim.

### `exportZip` — callable `{ includeHidden?: boolean }` → `{ url: string, count: number }`
- Admin claim required. Streams all matching `photos` originals into
  `exports/{exportId}.zip` (filename per photo: `YYYYMMDD-HHMMSS_{nickname}_{uuid8}.jpg`),
  returns a signed URL (24h). Writes `audit` entry.

Admin actions hide/unhide/rotate/pause/resume/grant/release are **direct Firestore writes**
(rules-gated to admin claim) + an `audit` doc written by the admin client in a batch.
Grant = `snapsRemaining += N`, `snapsGranted += N` — allowed for admin via rules.

## 6. Client upload protocol (workstream ②)

1. Capture → canvas re-encode (JPEG, 2048px longest edge, q≈0.8; canvas strips EXIF/GPS)
   → record in IndexedDB (db `wedding-camera`, store `queue`, key `uuid`):
   `{ uuid, blob, capturedAt, attemptCount, state }`, `uuid = crypto.randomUUID()`.
2. State machine per item: `queued → uploading → awaitingResult → confirmed | rejected`.
   Failures return to `queued` with backoff `min(2^attempt * 2s, 60s) + jitter`, resumed
   immediately on `online` event or page reopen.
3. Upload: Firebase Storage `uploadBytes` to `uploads/{uid}/{uuid}`
   (contentType `image/jpeg`).
4. Confirmation: `onSnapshot(doc('results', uuid))` (plus a poll fallback every 10s).
   `ok:true` → delete queue item, reconcile counter from `devices/{uid}` snapshot.
   `ok:false` → delete queue item, restore optimistic counter, surface reason state
   (quota/window per PRD §5; `invalid`/`duplicate` are silent + logged).
   **An item is NEVER removed without a verdict.** No verdict is not a failure: an upload
   made while the event is paused is *deferred* server-side (§5), so the doc can be a long
   time coming. After the 2-minute give-up the item is re-pumped; if the re-PUT is refused
   by the write-once storage rule AND the item's own earlier PUT is known to have landed,
   the item returns to `awaitingResult` (the bytes are safe in the bucket — keep watching)
   and a `change` is emitted so the UI keeps showing "N sending…". Only a write-once
   refusal for bytes we never stored is treated as an error and backed off.
   `paused` is no longer a reachable `results.reason`.
5. Counter: optimistic decrement at shutter; authoritative value = `devices/{uid}.snapsRemaining`
   minus in-flight queue items. Never show negative.
6. `beforeunload` guard while queue non-empty (UPLOAD-005). Persistence probe on boot:
   `navigator.storage.persist()` best-effort; detect ephemeral/private mode and show notice.

## 7. Guest state machine (workstream ①)

States (PRD §5): `loading → welcome → viewfinder ⇄ capturing`, overlays: `pendingBadge,
offlineBadge`, terminals: `noSnaps, notStarted, ended, paused, invalidLink, permissionDenied,
cameraUnavailable`. Config-driven gates evaluated in order:
slug valid? → window? (notStarted/ended) → paused? → device exists? (skip welcome) → snaps>0?
`paused/notStarted/ended` re-evaluate live via `onSnapshot(config/event)`.
Cap-reached renders as `ended` (guests never see the cap).

## 8. Camera capability contract (workstream ①)

- Acquire: `getUserMedia({ video: { facingMode, width: {ideal: 2048} }, audio: false })`.
- Flip: stop tracks, re-acquire with toggled `facingMode` (`user`/`environment`).
- Torch: show button iff `track.getCapabilities().torch === true`
  (Android Chrome yes / iOS Safari no); apply via
  `track.applyConstraints({ advanced: [{ torch: on }] })`. Front camera: screen-flash
  (white overlay 300ms at max brightness) — always available.
- Zoom: if `capabilities.zoom` exists → `applyConstraints({ advanced: [{ zoom }] })`;
  else digital: CSS scale on `<video>` + matching centered crop at capture (≤2×).
- Capture: draw current frame to canvas at native resolution (respect digital crop),
  `canvas.toBlob('image/jpeg', 0.8)` after downscale to 2048px longest edge.
- Re-acquire stream on `visibilitychange → visible` if track ended (iOS backgrounding).
- Any acquisition failure → `permissionDenied`/`cameraUnavailable` states with native
  `<input type="file" accept="image/*" capture="environment">` fallback into the same queue.

## 9. Theming contract (workstream ① + ④)

`lib/theme.js` maps `config/event.theme` → CSS custom properties on `:root`:
`--c-bg, --c-accent, --c-text, --font-stack` (from safe list), plus injects
`welcomeText/consentText/coupleNames/eventDateText/monogramText` into `data-theme-*` slots.
All rendered text is inserted via `textContent` (never innerHTML) — XSS guard per plan §11.

## 10. Emulator & test contract

- `firebase.json` emulators: auth 9099, firestore 8080, storage 9199, functions 5001,
  hosting 5000. Project `demo-wedding`. `app/src/lib/firebase.js` connects to emulators
  when `location.hostname` is localhost or `VITE_USE_EMULATORS=1`.
- Rules tests: `@firebase/rules-unit-testing` in `tests/rules/` — every Allow/Deny in §2–§3.
- E2E: Playwright, Chromium flags `--use-fake-device-for-media-stream
  --use-fake-ui-for-media-stream`; executablePath `/opt/pw-browsers/chromium`.
- Seed script provides a canonical `config/event` + `config/private` fixture
  (slug `testslug123`, PIN `2468`).

## 11. Cross-workstream ownership

| Area | Owner |
|---|---|
| `app/src/guest/main.js`, camera.js, all guest UI/CSS | ① Guest UI |
| `app/src/guest/queue.js`, persistence probe, retry/backoff | ② Upload engine |
| `functions/`, `firestore.rules`, `storage.rules`, `tests/rules/` | ③ Backend |
| `app/admin/`, `app/gallery/`, `app/src/{admin,gallery}/` | ④ Admin+Gallery |
| `lib/firebase.js`, `lib/theme.js`, `firebase.json`, this file | Orchestrator (pre-built) |

Interface between ① and ②: ① calls `queue.enqueue(blob, capturedAt)` and subscribes to
`queue.on('change', ({pending, confirmedDelta, rejection}) => …)`; ② owns everything below.
