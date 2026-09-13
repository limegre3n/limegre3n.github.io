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
- **GUEST-004**: Outside the event window, the app shows "not started yet" / "camera closed" pages and a new device cannot be registered (enforced in `firestore.rules` — this is the leaked-QR control). Uploads are judged separately: an upload before `startAt` is rejected server-side, and an upload from an *already registered* device is still accepted for 7 days after `endAt` so a phone that lost signal can deliver its queued film. Uploads keep running in the background while the "camera closed" page is shown.
- **GUEST-005**: When paused by admin, uploads are rejected server-side and the guest sees a gentle "camera resting" message.

### Camera
- **CAMERA-001**: Viewfinder shows a live camera stream on iOS Safari ≥16 and Android Chrome ≥110.
- **CAMERA-002**: Front/rear toggle in ≤1 tap.
- **CAMERA-003**: Shutter tap captures a still, plays shutter sound + wind-on animation, decrements the on-screen counter (optimistic allowed, must reconcile with server).
- **CAMERA-004**: No captured photo is ever displayed to the guest.
- **CAMERA-005**: Torch toggle appears only when the active track reports torch capability; front camera uses full-brightness white "screen flash".
- **CAMERA-006**: Zoom is a **step-less** control (slider + pinch), not fixed steps. It uses the native `zoom` constraint where supported, switches between separate back cameras where that is the only lens control available, and falls back to center-crop digital zoom up to 2× otherwise. Displayed magnification is always a **true** magnification (see CAMERA-010), and the capture is cropped by exactly the digital factor in play.
- **CAMERA-007**: Photos re-encoded on device to JPEG, longest edge 2048px, target ≤1MB.
- **CAMERA-008**: Re-encode strips ALL source metadata (EXIF/GPS); only nickname, device uid, capture timestamp attach server-side.
- **CAMERA-009**: If getUserMedia is unavailable or denied, offer native-camera fallback (`<input type="file" accept="image/*" capture="environment">`) through the same compress/queue/upload pipeline and quota.
- **CAMERA-010**: **1× means the phone's main wide lens, on every handset.** The app builds a *lens ladder* from `enumerateDevices()` labels plus the active track's `getCapabilities()`, and shows the guest a magnification, never a raw constraint value:
  - iOS `facingMode: environment` often returns a virtual multi-lens device ("Back Dual Wide Camera", "Back Triple Camera") whose native zoom `1.0` is the **ultra-wide**; WebKit does not normalise this, so the app calibrates `oneX = 2` for those labels and displays `native / oneX`. Shipping `1.0` as "1×" is the defect this requirement exists to prevent.
  - Android logical cameras that already normalise (capability `min < 0.95`, e.g. Samsung `0.5–10`) use `oneX = 1`; a plain `Back Camera` / `camera2 0, facing back` uses `oneX = min`.
  - Where no back camera exposes a zoom range but several exist, they are treated as fixed lenses (Ultra Wide → 0.5×, default → 1×, Telephoto → 2× or its stated factor) and the stream switches as the guest crosses a rung, cropping the lower lens in between. Capability probing of non-active cameras costs ~300 ms each, so at most 3, once per page view.
  - Ticks are shown at the rungs the hardware actually supports (0.5×/1×/2×/3×/5×); anything past the last real lens is drawn dimmed/hatched so guests can see where quality drops. The slider stops at 8×.
  - The camera **opens at 1×** every time, including after a front↔rear flip (which restores the last magnification for that side).
  - `?diag=1` shows a dismissible, copyable text sheet with the UA, every device + capability range, the resolved ladder and the live mapping — for tuning the heuristics against real handsets.
- **CAMERA-011**: The guest picks a **film stock** on a dial under the viewfinder — a snap-scrolling strip of swatches (`clean`, `golden`, `seaside`, `portrait`, `silver`, `faded`), the centred one being the loaded film. Tap, swipe or arrow keys move it, it is a `radiogroup`, it vibrates lightly on change and the pick is remembered on the phone (`wc.filter`, default `clean`). The live viewfinder previews that stock (CSS filter + grain + vignette), but the **upload is always the clean re-encoded original**: only the stock id and the phone's UTC offset ride along as metadata, and the server develops the look into a second copy (CONTRACTS §11). The dial stays usable in the landscape grip layout and never covers the frame centre or the shutter.
- **CAMERA-012**: When the event has the date stamp switched on (`config/event.dateStamp`, ADMIN-011), the viewfinder shows a **90s quartz date-back preview** in the bottom-right corner — orange seven-segment-style `'YY M D` from the phone's own clock. It is a preview only: the capture draws the video, never the DOM, so nothing is burned into the JPEG on the phone.

### Upload
- **UPLOAD-001**: Every capture is written to IndexedDB before any upload attempt.
- **UPLOAD-002**: Automatic retry with exponential backoff (2s→60s cap, jitter) while the page is open; `online` event triggers immediate retry.
- **UPLOAD-003**: Client-generated UUID per photo; server stores at most one photo per UUID (idempotent retries).
- **UPLOAD-004**: A failed/rejected upload never consumes a snap.
- **UPLOAD-005**: Pending-count indicator always visible when queue non-empty; `beforeunload` warning when leaving with a non-empty queue.
- **UPLOAD-006**: Queued photos survive browser close and resume on next open. Private-browsing (ephemeral storage) is detected and messaged.
- **UPLOAD-007**: Server rejects: non-image content (magic-byte check, not extension), files >8MB, uploads beyond device quota, event cap, or event window (before `startAt`, or more than 7 days after `endAt`). A **pause never rejects** — it defers: the object is kept, no verdict is written, and the photo is accepted once the admin resumes. No photo that reaches the bucket is ever destroyed for a reason that may later stop applying.
- **UPLOAD-009**: A photo that reaches the bucket but gets no verdict (finalize crash, exhausted retries, pause deferral) is recovered by a reconciliation sweep every 15 minutes, and on demand by an admin. Recovery is idempotent: one photo, one snap, however many paths process the object.
- **UPLOAD-008**: Guest can keep shooting while earlier photos upload.

### Admin
- **ADMIN-001**: Admin routes require the admin account; every admin action denied without it (rules-enforced).
- **ADMIN-002**: Admin sees all photos (incl. hidden) with nickname + time, newest first, live-updating.
- **ADMIN-003**: Hide/unhide any photo; hidden photos never appear in the gallery.
- **ADMIN-004**: Pause/resume all uploads with one toggle, server-enforced within ≤10s.
- **ADMIN-005**: Grant additional snaps to a specific device (listed by nickname).
- **ADMIN-006**: One-click ZIP of all visible (optionally all) photos at stored quality, filenames = timestamp + nickname. The ZIP packs the **developed** copies by default (what the gallery shows); an **“Originals (no film look, no stamp)”** checkbox packs the untouched originals instead — the couple's archival copy, with identical filenames either way.
- **ADMIN-007**: Release the gallery (one-way in UI; reversible in console). 
- **ADMIN-008**: Every admin action (hide/unhide/caption/pause/resume/grant/release/export) writes an audit record.
- **ADMIN-009**: The couple can write a short note (caption) on any photo — visible or hidden — edited in place on the photo card: ≤200 characters with a live counter, Enter saves, Escape cancels, clearing it stores an empty string. The caption and its audit record are written in one batch.
- **ADMIN-010**: The couple can put a **live wall** on a TV or laptop at the venue: a
  full-screen, auto-advancing slideshow of the photos as they land, newest frames
  joining the rotation by themselves and a frame they hide leaving it within seconds.
  Only `status: 'visible'` photos ever appear. A persistent corner card carries a QR
  code for the **guest camera** link (`/e/{slug}/`) with "Scan to take photos" and
  **never a gallery PIN**. Same controls and keyboard as GALLERY-009.
- **ADMIN-011**: The couple control the film development from the darkroom: a **“90s date stamp”** switch writes `config/event.dateStamp`, and **“Redevelop all photos”** re-applies every photo's own stock plus the current stamp setting across the whole album, paging through the album with live progress (“Redeveloping… 200 done”) and a completion toast. Originals are never touched; a failure surfaces as a toast and nothing is lost.

### Gallery
- **GALLERY-001**: Before release, gallery URL shows a "still developing" page.
- **GALLERY-002**: After release, correct PIN (4–6 digits) shows approved photos with attribution; PIN attempts rate-limited (5 per 15 min per identity).
- **GALLERY-003**: Viewers can download individual photos at stored quality.
- **GALLERY-004**: Gallery/admin pages send `noindex` and are excluded via robots.txt.
- **GALLERY-005**: Viewers can download all visible photos as a single ZIP, prepared server-side and handed over as a link to tap.
- **GALLERY-006**: Viewers can multi-select photos and download the selection — one photo saves directly, several are zipped in the browser (max 60).
- **GALLERY-007**: A photo the couple captioned (ADMIN-009) shows that note in the full-screen view, above the attribution line and in the photo's accessible name; on the wall the tile carries a small quote mark so notes are discoverable. Photos with no caption look exactly as before.
- **GALLERY-008**: A viewer who took photos on this device sees a "Your film" strip of their own frames above the wall, opening into the same full-screen view; a viewer who took none sees nothing. A "Photos by" chip row lists each guest with their frame count and filters the wall to one guest, with "All" resetting it. Both are live views of the released photos and nothing about them is persisted; "Download all" always means the whole album.
- **GALLERY-009**: After release, a viewer can play the album as a **slideshow** on a
  TV or laptop: full screen, black, one frame at a time over a blurred copy of itself,
  advancing every 7 s with a crossfade and a slow Ken Burns move (plain crossfade when
  the viewer prefers reduced motion). The couple's note and the "nickname · time" line
  sit bottom-left; a white corner card bottom-right carries a QR code for **this
  gallery's** link with "Scan to see the album". The PIN is shown in large digits only
  when someone in the room typed it this session, or answered the one-off
  "Show the PIN on screen?" sheet — the PIN is never stored on the device, and
  "Skip, no PIN" leaves the card without one. The show always runs over the whole
  album, never the "Photos by" filter. Controls (pause, prev/next, shuffle, QR toggle,
  exit) appear on movement and fade after 3 s; Space/←/→/S/Q/Esc do the same from a
  keyboard, and the screen is kept awake while it plays.

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

**Admin**: Login · Grid (live, hide/unhide, inline caption editor) · Devices (grant snaps) · Controls (pause, release, ZIP + originals option, date stamp, redevelop all, live wall) · Live wall / TV mode · confirmation modals for pause/release.

**Gallery**: Developing (locked) · PIN entry (+ rate-limit error) · Photo wall (+ "Your film" strip and "Photos by" chips) · Photo detail/download (+ the couple's caption) · Slideshow / TV mode (+ "Show the PIN on screen?" sheet) · Empty state.

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
guest-written captions/likes/comments · participation stats · admin-entered HTML/JS theming.
