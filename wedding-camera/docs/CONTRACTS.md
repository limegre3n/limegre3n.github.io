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
  dateStamp: boolean,           // default true — burn the 90s date stamp into developed copies (§11)
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

### `config/galleryExport` — server only (NO client read/write, admin included)
```js
{ signature: string /*sha256 of the sorted visible photo uuids, ','-joined*/,
  path: string /*exports/{exportId}.zip*/, count: number, createdAt: Timestamp,
  building: boolean, buildingSince: Timestamp, buildingSignature: string }  // build lock
```
- Written ONLY by `exportGalleryZip`. Caches one shared archive for all gallery viewers;
  the signed URL is re-minted per call and deliberately never stored.

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
  status: 'visible'|'hidden', rotation: 0|90|180|270,
  caption?: string /*0..200 chars, GALLERY-007*/,
  // Film development (§11) — always written by the finalize function.
  filter: string,               // film-stock id, 'clean' when absent/unknown
  tzOffsetMinutes: number,      // guest's UTC offset in minutes, 0 when absent, clamped ±840
  developedPath: string|null,   // 'developed/{uuid}' once a developed copy exists
  developedAt: Timestamp|null,
  developPending: boolean }     // a developed copy is owed but not stored yet
```
- Admin may update `status`, `rotation` and `caption` only. The five development fields
  are **server-only** — written by the finalize function, `reconcileUploads` and
  `redevelopAll` (all Admin SDK, so no rules change was needed).
- **Readers (gallery + admin): show `developedPath` when it is a non-empty string,
  otherwise `storagePath`.** `developPending: true` means the developed copy is on its
  way; keep showing the original rather than a placeholder.
- `caption` is **optional**: the finalize function never writes it, so most docs simply
  lack the key. Absent and `''` both mean "no caption" — readers must treat them the
  same, and the admin client may clear one either way (`''` or a field delete).
  Validated only when the write carries it: `is string` and `size() <= 200`.
- Captions ride along in the photo doc, so gallery viewers get them through the existing
  read rule (gallery claim + released + `status == 'visible'`) — no separate rule.

#### "Your film" query (GALLERY-008)
A released gallery viewer lists the photos taken on their own device:
```js
query(collection(db, 'photos'),
      where('deviceUid', '==', auth.currentUser.uid),
      where('status', '==', 'visible'),
      orderBy('receivedAt', 'asc'))
```
- Requires the composite index in `firestore.indexes.json`: collection `photos`,
  `deviceUid ASC, status ASC, receivedAt ASC`.
- The `status == 'visible'` filter is **not optional**: the read rule is
  `resource.data.status == 'visible'`, so a query without it is rejected wholesale by
  the rules engine (it cannot be proven safe), not silently narrowed.
- The rule does not itself constrain `deviceUid` — a viewer is already allowed every
  visible photo. The filter is what makes the view "yours", not an access control.

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
{ action: 'hide'|'unhide'|'rotate'|'caption'|'pause'|'resume'|'grant'|'release'|'export',
  target: string|null /*photo uuid or device uid*/, actorUid: string, at: Timestamp }
```
- Create: admin only. No update/delete.
- The server also writes `action: 'gallery-export'` (Admin SDK, `exportGalleryZip`) and
  `action: 'redevelop'` (Admin SDK, `redevelopAll`, always `target: null`). Neither value
  is added to the rules enum above, which governs client writes only — no client may
  claim a gallery export or a re-development.

### `pinAttempts/{uid}` — function-managed rate limiting. No client access.

### `galleryExportAttempts/{uid}` — function-managed rate limiting for `exportGalleryZip`.
No client access.

## 3. Storage paths & rules behaviour

- `uploads/{uid}/{uuid}` — guest upload target (**no file extension** — the bare UUID is
  the object name so Storage rules can reference `photos/{uuid}` directly; contentType
  `image/jpeg` carries the type).
  - **Write**: `request.auth.uid == uid`, write-once (no overwrite/delete),
    `contentType == 'image/jpeg'`, `size <= 8MB` (UPLOAD-007 pre-filter; authoritative
    validation in finalize function).
  - **Read**: admin claim only, or gallery claim + released + Firestore
    `photos/{uuid}.status == 'visible'` (cross-service `firestore.get`).
- `developed/{uuid}` — the DEVELOPED copy of `photos/{uuid}` (film stock baked in, plus
  the optional date stamp). Bare uuid, **no file extension**, contentType `image/jpeg`,
  exactly like `uploads/`.
  - **Write**: `if false`. Only the develop pipeline (Admin SDK) ever writes here; a
    forged "developed" copy would otherwise be shown to the whole gallery in place of
    the real photo.
  - **Read**: identical to `uploads/` — admin claim, or gallery claim + released +
    Firestore `photos/{uuid}.status == 'visible'`. Hiding a photo therefore revokes the
    original and the developed copy in one move.
- `theme/…` — hero/monogram images. Read: any signed-in user. Write: admin.
- `exports/{exportId}.zip` — ZIP outputs from `exportZip` / `exportGalleryZip`.
  Read: admin only — gallery viewers get at the archive through the signed URL the
  callable returns, which bypasses rules; the objects stay unreadable otherwise.

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
ever produce one photo and one decrement. The same run then sweeps film development:
up to **25** photos with `developPending == true`, **3** at a time (a single-field
equality query — no composite index).

### `reconcileNow` — callable `{ minAgeMs?: number, prefix?: string }` → `{ scanned, accepted, rejected, deferred, developed, developFailed, developCleared }`
Admin claim required (`request.auth.token.admin === true`). Runs the same sweep immediately:
the emergency "send everything now" button, and the only way tests can exercise
reconciliation (the emulator never fires schedules). `minAgeMs` (default 5 min) and `prefix`
(must start with `uploads/`) are call-scoped knobs, **not** configuration.

### `verifyGalleryPin` — callable `{ pin: string }` → `{ ok: boolean, retryAfterSec?: number }`
- Requires auth. Rate limit via `pinAttempts/{uid}`: max 5 fails / 15 min → `retryAfterSec`.
- `sha256(salt + pin) == galleryPinHash` and `galleryReleased` ⇒ set `gallery` claim.

### `exportZip` — callable `{ includeHidden?: boolean, developed?: boolean }` → `{ url: string, count: number }`
- Admin claim required. Streams one object per matching `photos` doc into
  `exports/{exportId}.zip` (filename per photo: `YYYYMMDD-HHMMSS_{nickname}_{uuid8}.jpg`),
  returns a signed URL (24h). Writes `audit` entry.
- `developed` defaults to **true**: the developed copy is packed wherever
  `developedPath` is set, the original otherwise (a developed path whose object has
  vanished falls back to the original rather than dropping the photo). `developed:false`
  packs the untouched originals — the couple's archival copy. **Filenames are identical
  either way**, so the two archives are drop-in replacements for each other.

### `redevelopAll` — callable `{ startAfter?: uuid, limit?: 1..200 }` → `{ processed, remaining, lastUuid }`
- Admin claim required (`request.auth.token.admin === true`); anything else →
  `permission-denied`. `{ region: asia-southeast1, memory: '1GiB', timeoutSeconds: 540 }`.
- Re-develops accepted photos in `receivedAt` order (single-field index) using the
  **current** `config/event.dateStamp` and each photo's own stored `filter`. One page per
  call — the admin UI loops while `remaining` is true, passing the previous `lastUuid`
  back as `startAfter`. `limit` defaults to 100.
- A photo that no longer needs a developed copy (stock `clean` and the stamp switched
  off) has its `developed/{uuid}` object deleted and its three fields nulled.
- Writes one `audit` doc `{ action: 'redevelop', target: null, actorUid, at }` per call.

### `exportGalleryZip` — callable `{}` → `{ url: string, count: number }`
- Requires auth **and** `request.auth.token.gallery === true` (an `admin` claim also
  passes); anything else → `permission-denied`.
- `config/event.galleryReleased !== true` → `failed-precondition`
  ("The gallery is not open yet."), so a claim minted before a re-lock stops working.
- **Only `status == 'visible'` photos**, always. There is no `includeHidden` switch —
  a gallery viewer must never reach a moderated-away photo.
- Always packs the **developed** copy where one exists (same rule as `exportZip`'s
  `developed:true`): guests download the pictures they were shown. There is no switch.
- **Cached** (many guests tap "Download all"): `config/galleryExport` holds the last
  build keyed by a signature over the sorted visible photo uuids **and their
  `developedPath`s**, so a `redevelopAll` invalidates the cache instead of serving stale
  looks. Same signature and
  younger than 20h and the object still exists ⇒ the stored `path` is re-signed and
  returned without rebuilding; otherwise a fresh ZIP is built and the doc overwritten.
  Signed URLs are never persisted.
- **Build lock** (same doc: `building`, `buildingSince`, `buildingSignature`): a cold
  cache would otherwise have every guest in the burst build their own archive. One
  caller claims the lock and builds; the others poll every 3s for up to 8 minutes and
  are served the finished archive — waiting costs no rate-limit attempt. The lock is
  released in a `finally`, and a lock older than 8 minutes is treated as abandoned.
- The superseded archive is deleted best-effort, but only once it is over an hour old —
  a guest may still be mid-download on its (24h-valid) URL.
- **Rate limit**: max 3 *fresh* builds per uid per rolling hour
  (`galleryExportAttempts/{uid}`); exceeding it → `resource-exhausted`
  ("Please wait a little before downloading again."). Cache hits are free.
- Writes an `audit` record `{ action: 'gallery-export', target: exportId, actorUid, at }`.
- ZIP building (entry names, developed-copy preference, missing-object skipping) is
  shared with `exportZip` via `buildZipFromPhotos(photoDocs, exportId, name, { developed })`.

Admin actions hide/unhide/rotate/caption/pause/resume/grant/release are **direct Firestore
writes** (rules-gated to admin claim) + an `audit` doc written by the admin client in a batch.
Caption = set/clear `photos/{uuid}.caption` (≤200 chars) + `audit{action:'caption', target:uuid}`.
Grant = `snapsRemaining += N`, `snapsGranted += N` — allowed for admin via rules.

## 6. Client upload protocol (workstream ②)

1. Capture → canvas re-encode (JPEG, 2560px longest edge, q 0.86 stepping to ≥0.72 for a ≤2.5 MB target; canvas strips EXIF/GPS. Where the browser offers ImageCapture.takePhoto the still is used instead of a preview frame (CAMERA-013))
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

- Acquire: `getUserMedia({ video: { facingMode, width: {ideal: 1920} }, audio: false })`.
- Flip: stop tracks, re-acquire with toggled `facingMode` (`user`/`environment`).
- Torch: show button iff `track.getCapabilities().torch === true`
  (Android Chrome yes / iOS Safari no); apply via
  `track.applyConstraints({ advanced: [{ torch: on }] })`. Front camera: screen-flash
  (white overlay 300ms at max brightness) — always available.
- Zoom: if `capabilities.zoom` exists → `applyConstraints({ advanced: [{ zoom }] })`;
  else digital: CSS scale on `<video>` + matching centered crop at capture (≤2×).
- Capture: draw current frame to canvas at native resolution (respect digital crop),
  `canvas.toBlob('image/jpeg', 0.86)` (stepping down to 0.72 if over 2.5 MB) after downscale to 2560px longest edge.
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

## 11. Film development (film stocks + date stamp)

Guests pick a **film stock** on the camera. The upload itself stays the **clean
original** and only carries the stock id; the server then "develops" a second copy with
the real look. **Originals are never modified.** The gallery shows the developed copy
when one exists.

### The stock catalogue — `functions/film-stocks.json`

Canonical, single source of truth, imported by the app **by relative path** (it is not
served from Firestore and never changes at runtime):

```js
{ version: 1, stocks: [ {
    id: string,                 // 'clean' | 'golden' | 'seaside' | 'portrait' | 'silver' | 'faded'
    name: string,               // guest-facing label
    css: { filter: string,      // CSS filter string approximating the recipe, for the LIVE viewfinder
           grain: number,       // 0..1 opacity of a grain overlay
           vignette: number },  // 0..1
    recipe: null | {            // what the SERVER applies with sharp; null == clean
      bw: boolean,
      modulate: { brightness: number, saturation: number, hue: number /*degrees*/ },
      tint: [r, g, b] | null,   // colour cast, normalised against its strongest channel
      gamma: 1..3 | null,       // midtone lift
      linear: [a, b] | null,    // extra affine pass
      contrast: number,         // 1 = none; applied about mid-grey
      lift: 0..40,              // adds to the blacks
      grain: 0..30,             // gaussian grain sigma, resolution-independent
      vignette: 0..1 } } ] }
```

The six ids are fixed: `clean` (Clean), `golden` (Golden Hour), `seaside` (Seaside),
`portrait` (Portrait Soft), `silver` (Silver), `faded` (Faded).

`css.filter` is the **preview** contract: the guest camera applies it to the live
viewfinder so the shot looks roughly like the developed result. It is an approximation,
never the authority — the server recipe is. The two halves are deliberately separate so
the look can be re-graded later (`redevelopAll`) without re-shooting anything.

### Grain

`recipe.grain` is the standard deviation the developed picture actually receives, not a
per-pixel noise amplitude. The server draws one gaussian sample per **grain cell**, with
1400 cells across the longer edge whatever the capture size, then enlarges that layer
bicubically to full resolution and softens it by ~0.4 px — so a clump is ~1 px on a
1400 px capture and ~1.8 px on a 2560 px one, and the grain looks the same at a given
display size instead of getting finer as uploads get bigger. The sigma is divided back
out by how much of it the enlargement and the blur average away, so the recipe number
holds at any size. The layer is `overlay`-blended (mid-grey is a no-op) and additionally
weighted towards the mid-tones, so crushed blacks and blown highlights stay clean, the
way they do on film. Nothing in the develop assumes a capture size.

`scripts/develop-samples.js` renders one sample per stock offline (no emulator) so a
recipe change can be eyeballed before it ships — over a clean synthetic scene and over
the same scene carrying sensor noise, which is the test that matters: film grain has to
stay distinguishable from the noise a phone already put in the frame.

### Upload custom metadata (set by the guest app)

| key | type | meaning |
|---|---|---|
| `capturedAt` | string (epoch ms) | existing |
| `filter` | string | film-stock id; absent or unknown → `'clean'` |
| `tzOffsetMinutes` | string integer | minutes to **ADD** to UTC for the guest's local time, i.e. `-new Date().getTimezoneOffset()`; absent → `0`; clamped to `[-840, 840]` |

Both new keys are advisory: an unknown stock and a nonsense offset degrade quietly and
can never cost a snap or reject a photo.

### When a photo is developed

```js
needsDevelop = filter !== 'clean' || config/event.dateStamp === true
```

- Not needed → `developedPath: null`, `developedAt: null`, `developPending: false`.
- Needed → `developPending: true` is written **inside the acceptance transaction**, and
  the develop itself runs in `processUpload` **after** the transaction has accepted the
  photo — never before it, never inside it. On success:
  `{ developedPath: 'developed/{uuid}', developedAt, developPending: false }`.
  On failure: log and leave `developPending: true` for the next sweep.
- **A develop failure must never reject the photo**, undo the snap, or touch the
  original. Development is a second, optional artefact.

### The date stamp

A 90s quartz-date-back stamp burned into the bottom-right corner when
`config/event.dateStamp === true`.

- Text: `'YY M D` — apostrophe, 2-digit year, then month and day **without zero
  padding**, space separated (e.g. `'26 9 13`).
- Computed from `capturedAt + tzOffsetMinutes` — the guest's local date, not the
  server's.
- Rendered as **hand-written seven-segment SVG paths** (digits 0–9 plus the
  apostrophe). No fonts, no fontconfig — neither is available in the Functions runtime.
- `#ff9a2e` fill with a soft glow (a second blurred layer at 60–70% alpha) and a slight
  italic skew; height ≈ 3.2 % of the image's longer edge; margins ≈ 3 % of width and
  3.5 % of height; composited with `composite()`.

### Output

`sharp(buffer).rotate()` (honours EXIF orientation even though the guest app already
strips EXIF) → recipe → grain → vignette → stamp → JPEG **quality 88**, **no
`withMetadata()`** so the developed copy carries no EXIF at all.

## 12. Cross-workstream ownership

| Area | Owner |
|---|---|
| `app/src/guest/main.js`, camera.js, all guest UI/CSS | ① Guest UI |
| `app/src/guest/queue.js`, persistence probe, retry/backoff | ② Upload engine |
| `functions/` (incl. `film-stocks.json`), `firestore.rules`, `storage.rules`, `tests/rules/` | ③ Backend |
| `app/admin/`, `app/gallery/`, `app/src/{admin,gallery}/` | ④ Admin+Gallery |
| `lib/firebase.js`, `lib/theme.js`, `firebase.json`, this file | Orchestrator (pre-built) |

Interface between ① and ②: ① calls `queue.enqueue(blob, capturedAt)` and subscribes to
`queue.on('change', ({pending, confirmedDelta, rejection}) => …)`; ② owns everything below.
