# Wedding Disposable Camera — Product Requirements (PRD)

> Source of truth for product behaviour. Agents: implement against the requirement IDs here
> and the technical interfaces in `CONTRACTS.md`. Do not invent product behaviour —
> anything ambiguous gets escalated to the orchestrator, not guessed.

## 1. Product summary

Guests at one wedding scan a QR code, which opens a mobile-browser web app (zero install).
They enter a nickname, get **10 snaps**, and shoot through a nostalgic 90s film-disposable
camera UI: **no preview, no retakes, no gallery during the event**. Photos upload
opportunistically (offline-queue resilient) into a collection the couple moderates and
releases after the wedding as a PIN-protected gallery. Everything is deleted ~3 months
after the event.

## 2. Confirmed decisions

| # | Decision |
|---|----------|
| D1 | One wedding now; all event-specific content/branding lives in EventConfig (theme block), never hardcoded. Multi-event admin is out of scope. |
| D2 | Timeline: 2–6 weeks to wedding day. Reliability is never traded for features. |
| D3 | 50–100 guests; plan for ~600–1,200 photos; hidden event cap 2,500. |
| D4 | Zero install: QR → mobile browser → camera. No install prompt, no app store. |
| D5 | Identity = nickname only. No accounts, no contact details, no PII beyond nickname. |
| D6 | 10 snaps **per phone/browser**, honour-system. Server-side count is authoritative; bypass via new device/incognito is accepted. |
| D7 | True disposable: no preview, no retake, no delete, guests never see any photo. Exposure counter only. |
| D8 | Gallery revealed after the wedding by the couple, after a moderation pass. |
| D9 | Assume patchy connectivity: local-first persistent queue, opportunistic upload. |
| D10 | Camera: front/rear switch, flash (capability-detected; screen-flash for front), zoom (native where supported, digital ≤2× fallback). **No video.** |
| D11 | Budget ≤ ~$25–50/month while active; budget alert at $25. |
| D12 | Owner is non-technical: post-launch operations are dashboard/admin-page only. |
| D13 | Admin scope: review/hide, ZIP download, pause uploads, grant snaps, release gallery. No stats dashboard. |
| D14 | Retention ~3 months post-wedding, then full deletion + shutdown. |
| D15 | Gallery = secret link + 4–6 digit PIN, rate-limited, noindexed. |
| D16 | Fresh design: nostalgic 90s film-disposable aesthetic. English only. |
| D17 | Uploads accepted only during event window (wedding day + next morning); friendly closed pages outside it. |
| D18 | One-line consent notice pre-camera; EXIF/GPS stripped on device; no facial recognition; supervised minors OK. |
| D19 | Per-event tailoring via structured theming config only (texts, palette, safe-list font, hero image, monogram). **Never admin-entered HTML/JS.** |
| A2 | A snap is consumed only on server-confirmed receipt. Failed uploads never consume a snap. |
| A4 | Guests see only the exposure counter (e.g. "07/10"), never thumbnails. |

## 3. User types

- **Guest** — anonymous-auth device with a nickname. Takes photos. Never sees photos.
- **Host (couple)** — one shared email+password admin login. Moderates, controls, releases, exports.
- **Gallery viewer** — anyone with gallery link + PIN after release. Read-only.

## 4. Functional requirements

### Guest access
- **GUEST-001**: Scanning the event QR opens the web app in the default mobile browser with no install step.
- **GUEST-002**: A first-time guest must enter a non-empty nickname (1–30 chars) and see the consent line before camera access is requested.
- **GUEST-003**: A returning device skips nickname entry and restores its remaining snap count from the server.
- **GUEST-004**: Outside the event window, the app shows "not started yet" / "camera closed" pages and uploads are rejected server-side.
- **GUEST-005**: When paused by admin, uploads are rejected server-side and the guest sees a gentle "camera resting" message.

### Camera
- **CAMERA-001**: Viewfinder shows a live camera stream on iOS Safari ≥16 and Android Chrome ≥110.
- **CAMERA-002**: Front/rear toggle in ≤1 tap.
- **CAMERA-003**: Shutter tap captures a still, plays shutter sound + wind-on animation, decrements the on-screen counter (optimistic allowed, must reconcile with server).
- **CAMERA-004**: No captured photo is ever displayed to the guest.
- **CAMERA-005**: Torch toggle appears only when the active track reports torch capability; front camera uses full-brightness white "screen flash".
- **CAMERA-006**: Zoom uses the native `zoom` constraint where supported, else center-crop digital zoom up to 2×.
- **CAMERA-007**: Photos re-encoded on device to JPEG, longest edge 2048px, target ≤1MB.
- **CAMERA-008**: Re-encode strips ALL source metadata (EXIF/GPS); only nickname, device uid, capture timestamp attach server-side.
- **CAMERA-009**: If getUserMedia is unavailable or denied, offer native-camera fallback (`<input type="file" accept="image/*" capture="environment">`) through the same compress/queue/upload pipeline and quota.

### Upload
- **UPLOAD-001**: Every capture is written to IndexedDB before any upload attempt.
- **UPLOAD-002**: Automatic retry with exponential backoff (2s→60s cap, jitter) while the page is open; `online` event triggers immediate retry.
- **UPLOAD-003**: Client-generated UUID per photo; server stores at most one photo per UUID (idempotent retries).
- **UPLOAD-004**: A failed/rejected upload never consumes a snap.
- **UPLOAD-005**: Pending-count indicator always visible when queue non-empty; `beforeunload` warning when leaving with a non-empty queue.
- **UPLOAD-006**: Queued photos survive browser close and resume on next open. Private-browsing (ephemeral storage) is detected and messaged.
- **UPLOAD-007**: Server rejects: non-image content (magic-byte check, not extension), files >8MB, uploads beyond device quota, event cap, event window, or pause.
- **UPLOAD-008**: Guest can keep shooting while earlier photos upload.

### Admin
- **ADMIN-001**: Admin routes require the admin account; every admin action denied without it (rules-enforced).
- **ADMIN-002**: Admin sees all photos (incl. hidden) with nickname + time, newest first, live-updating.
- **ADMIN-003**: Hide/unhide any photo; hidden photos never appear in the gallery.
- **ADMIN-004**: Pause/resume all uploads with one toggle, server-enforced within ≤10s.
- **ADMIN-005**: Grant additional snaps to a specific device (listed by nickname).
- **ADMIN-006**: One-click ZIP of all visible (optionally all) photos at stored quality, filenames = timestamp + nickname.
- **ADMIN-007**: Release the gallery (one-way in UI; reversible in console). 
- **ADMIN-008**: Every admin action (hide/unhide/pause/resume/grant/release/export) writes an audit record.

### Gallery
- **GALLERY-001**: Before release, gallery URL shows a "still developing" page.
- **GALLERY-002**: After release, correct PIN (4–6 digits) shows approved photos with attribution; PIN attempts rate-limited (5 per 15 min per identity).
- **GALLERY-003**: Viewers can download individual photos at stored quality.
- **GALLERY-004**: Gallery/admin pages send `noindex` and are excluded via robots.txt.

### Privacy
- **PRIVACY-001**: Consent line shown before the first photo can be taken.
- **PRIVACY-002**: No stored photo contains GPS/EXIF from the source device.
- **PRIVACY-003**: Documented shutdown deletes all photos, nicknames, device records ≤3 months post-event.
- **PRIVACY-004**: Zero analytics/tracking scripts; no third-party requests beyond Firebase.
- **PRIVACY-005**: Storage objects not publicly listable/readable; access only via rules (see CONTRACTS).

## 5. Screen & state map

**Guest app** (single page, state machine):
Loading → Welcome/name+consent → (permission prompt) → Viewfinder.
Error/edge states: Permission denied (per-platform help + native fallback) · Camera unavailable (native fallback) · Capturing (~0.8s lockout, blackout+sound+wind-on) · Pending badge ("N sending…") · Offline badge ("will send when signal returns") · Retry badge · Leave-with-queue warning · No snaps ("film used up" end card + final upload status) · Event not started · Event ended · Paused ("camera resting") · Invalid link · Cap reached (renders as Event ended — guests never see the cap).

**Admin**: Login · Grid (live, hide/unhide) · Devices (grant snaps) · Controls (pause, release, ZIP) · confirmation modals for pause/release.

**Gallery**: Developing (locked) · PIN entry (+ rate-limit error) · Photo wall · Photo detail/download · Empty state.

## 6. Snap allowance (summary — full design in plan §8)

Owner = phone-browser pair via Firebase Anonymous Auth uid. Server-side `snapsRemaining` is
authoritative, decremented atomically only by the finalize function on confirmed receipt.
Client never writes quota fields. Bypass by identity reset is accepted (honour system);
real backstops = event cap, per-device upload spacing, window, pause, size/type validation.

## 7. Non-functional targets

- iOS Safari 16+, Android Chrome 110+; graceful native-capture fallback below.
- First load ≤3s on 4G; initial payload ≤500KB.
- QR-scan → camera-ready ≤30s first time, ≤10s returning.
- ≥99.5% of captured photos stored server-side by event end +12h.
- Stored JPEG ≤1MB typical, 8MB hard cap, 2048px longest edge.
- Shutter ≥64px touch target; WCAG AA contrast; dark-venue friendly; one-handed use.
- Capture+queue keep working during a total backend outage.
- 100 concurrent guests; burst ~50 uploads/min.

## 8. Acceptance criteria (P0)

1. Fresh iPhone (iOS 16+) Safari: QR → camera ≤30s → 10 photos → all in admin ≤2min; stored files EXIF/GPS-free.
2. Same on Android Chrome; torch + zoom visibly work.
3. Camera permission denied → guidance + native fallback submits a photo that consumes a snap normally.
4. Airplane mode, take 3 photos → "3 sending", no crash → back online → all 3 arrive, zero duplicates, exactly 3 snaps consumed.
5. Close browser, reopen 2h later → same nickname, correct count, queued photos upload.
6. 10th confirmed photo → end card; forged 11th upload rejected server-side.
7. Two racing retries of one UUID → exactly one stored photo.
8. Admin ZIP contains every visible photo, filenames timestamp+nickname.
9. Link opened before start → "not started"; after end → "closed"; direct API upload outside window → rejected; pause propagates ≤10s.
10. Hidden photo never appears in released gallery; audit record exists.
11. Wrong PIN ×5 → rate-limited; correct PIN → approved photos; page noindexed.

## 9. Out of scope (do not build)

Native/installed apps · video/GIF/live photos · guest accounts/contact capture ·
facial recognition · strict per-person enforcement · multi-event admin · push/email/SMS ·
likes/comments · participation stats · admin-entered HTML/JS theming.
