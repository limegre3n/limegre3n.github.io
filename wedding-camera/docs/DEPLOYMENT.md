# Deployment Guide — from repo to live wedding camera

Follow these steps in order on your own computer (Mac/Windows/Linux). Time: ~60 min.
You need: a Google account, and Node.js 20+ installed (nodejs.org → "LTS" installer).
Every console instruction below names the exact menu, button, and dialog you will see.

> Order matters: do Step 2 (billing) before Step 3 — new Firebase projects need the
> Blaze plan before Storage can be enabled.

---

## Step 1 — Get the code

Open a terminal (Mac: Terminal app; Windows: PowerShell) and run:

```bash
git clone https://github.com/limegre3n/limegre3n.github.io.git
cd limegre3n.github.io
git checkout claude/wedding-camera-discovery-nw1ze1   # or main after merging
cd wedding-camera
npm install
cd functions && npm install && cd ..
```

If `git` is missing, install it from git-scm.com. Keep this terminal open — later steps
assume you are inside the `wedding-camera` folder.

## Step 2 — Create the Firebase project and enable billing

1. Go to https://console.firebase.google.com and sign in.
2. Click **Create a project** (or **Add project**).
   - Project name: e.g. `alex-sam-wedding`. Below the name field the console shows the
     generated **Project ID** (e.g. `alex-sam-wedding-4f2a1`) — you can click the pencil
     to shorten it. **Write this ID down**; it is used in Steps 4, 5, 7, 8 and 9.
   - Click **Continue**.
   - Google Analytics screen: switch **Enable Google Analytics** OFF (we do not use it,
     and the guest app must load no trackers). Click **Create project**, then **Continue**.
3. **Upgrade to Blaze (pay as you go):**
   - Bottom-left of the console, click **Spark plan → Upgrade** (or ⚙️ next to
     "Project Overview" → **Usage and billing** → **Details & settings** → **Modify plan**).
   - Choose **Blaze**, then **Select plan**.
   - Pick or create a **Cloud Billing account** and add a payment card. Blaze has no
     monthly fee — the free tier still applies; expected total for the wedding is a few dollars.
   - The upgrade dialog offers **"Set a budget alert"** → enter **25** (USD). Click **Continue**,
     then **Purchase/Confirm**.
4. **Double-check the budget alert** (in case the dialog skipped it): in the Firebase
   console → **Usage and billing** → click the linked billing account (opens Google Cloud
   console) → left menu **Budgets & alerts** → **Create budget** → name "Wedding camera",
   amount **25**, thresholds 50% / 90% / 100%, tick **Email alerts to billing admins** →
   **Finish**.

## Step 3 — Enable the four services

In the Firebase console, left sidebar → expand **Build**. Do all four:

### 3a. Authentication
1. **Build → Authentication → Get started**.
2. Open the **Sign-in method** tab → **Add new provider**.
3. Choose **Anonymous** → toggle **Enable** ON → **Save**.
   *(This is what guests use — invisible, no form. Without it nobody can upload.)*
4. **Add new provider** again → **Email/Password** → toggle **Enable** ON. Leave
   "Email link (passwordless sign-in)" OFF → **Save**.
   *(Used only by the couple's admin page.)*
5. You should now see both providers listed as **Enabled**. Nothing else to do here;
   `<project-id>.web.app` and `.firebaseapp.com` are already authorized domains.
   (Only if you later add a custom domain: **Settings** tab → **Authorized domains** → add it.)

### 3b. Firestore Database
1. **Build → Firestore Database → Create database**.
2. Step "Select edition": keep **Standard edition** → **Next**.
3. Step "Database ID & location": leave Database ID as **(default)** — do NOT rename it,
   the app targets the default database. Location: pick a region near the wedding. **The
   code is configured for `asia-southeast1` (Singapore)** — choose that unless you have a
   reason not to. If you pick a different region, the Cloud Functions must run in the same
   region as the Storage bucket: change `REGION` at the top of `functions/index.js` and add
   `VITE_FB_FUNCTIONS_REGION=<region>` to `app/.env.production` before deploying (otherwise
   deploy fails with "A function in region X cannot listen to a bucket in region Y").
   **Write the region down** (Storage must match; it cannot be changed later). → **Next**.
4. Step "Configure": choose **Start in production mode** → **Create**.
   (Some console versions skip this screen and lock the database down automatically —
   that is fine. Our deploy in Step 5 replaces the rules anyway.)

### 3c. Storage
1. **Build → Storage → Get started**.
2. Dialog "Set up Cloud Storage": choose **Start in production mode** → **Next**.
3. Location: choose the **same region** as Firestore (it may already be fixed to the
   project's default location — that is fine) → **Done**.
4. The bucket appears with a name like `gs://<project-id>.firebasestorage.app`
   (older projects: `<project-id>.appspot.com`). **Copy the exact bucket name shown** —
   you need it in Step 4.
   If you see "Blaze plan required", finish Step 2 first and come back.

### 3d. Hosting
1. **Build → Hosting → Get started**.
2. A wizard shows CLI commands (`npm install -g firebase-tools`, `firebase login`,
   `firebase init`, `firebase deploy`). **Do not run them** — the repo already contains
   the hosting configuration and `firebase init` would overwrite it. Click **Next →
   Next → Continue to console** to dismiss the wizard.
3. That's it. The live site `https://<project-id>.web.app` is created automatically the
   first time you deploy in Step 5.

## Step 4 — Register the web app and configure the build

1. Console → ⚙️ (next to "Project Overview") → **Project settings** → **General** tab →
   scroll to **Your apps** → click the **`</>`** (Web) icon.
2. App nickname: `wedding-camera`. Leave **"Also set up Firebase Hosting"** unchecked →
   **Register app**.
3. The next screen shows a code block containing `const firebaseConfig = { ... }`.
   Copy the five values into a new file named exactly **`.env.production`** inside the
   `wedding-camera/app/` folder (create it with any text editor; on Mac, TextEdit →
   Format → Make Plain Text first):

   Mapping: `apiKey` → `VITE_FB_API_KEY`, `authDomain` → `VITE_FB_AUTH_DOMAIN`,
   `projectId` → `VITE_FB_PROJECT_ID`, `storageBucket` → `VITE_FB_STORAGE_BUCKET`
   (must match the bucket name from Step 3c), `appId` → `VITE_FB_APP_ID`.
   The file must contain exactly five lines like these — no quotes, no comments:

```
VITE_FB_API_KEY=AIza...
VITE_FB_AUTH_DOMAIN=<project-id>.firebaseapp.com
VITE_FB_PROJECT_ID=<project-id>
VITE_FB_STORAGE_BUCKET=<project-id>.firebasestorage.app
VITE_FB_APP_ID=1:1234567890:web:abcdef123456
```

   Click **Continue to console**. (To see these values again later: Project settings →
   Your apps → your app → **SDK setup and configuration → Config**.)

   ⚠️ Copy only the five **values** (the text inside the quotes) — do not paste the whole
   JavaScript snippet, and put the file in `wedding-camera/app/`, not in `wedding-camera/`.
   Ignore `messagingSenderId` and `measurementId`; the app does not use them.
4. Point the CLI at your project: open `wedding-camera/.firebaserc` in a text editor and
   replace `demo-wedding` with your Project ID — it must be **exactly** the `projectId`
   value from the same snippet (not the display name you typed when creating the project):

```json
{ "projects": { "default": "<project-id>" } }
```

## Step 5 — Deploy

In the terminal (inside `wedding-camera/`):

```bash
npx firebase login
```
A browser tab opens → choose the Google account that owns the project → **Allow**.
The terminal prints "Success! Logged in as …".

> **If you see `npm error could not determine executable to run`:** the Firebase CLI
> isn't installed in this folder yet — usually because Step 1's `npm install` was skipped
> or failed. Run `npm install` (inside `wedding-camera/`) and retry. If it still fails,
> use the unambiguous package name instead: `npx firebase-tools login`, and later
> `npx firebase-tools deploy`. (The plain `firebase` npm package is the web SDK, which
> has no command-line tool — that's what the error is complaining about.)

```bash
npm run build          # compiles the frontend into app/dist
npx firebase deploy    # hosting + Firestore rules + Storage rules + Cloud Functions
```

What to expect:
- The first deploy asks to **enable APIs** (Cloud Functions, Cloud Build, Artifact
  Registry, Eventarc, Pub/Sub, Cloud Scheduler) — answer **Y**. It can take 5–10 minutes.
- If it fails with a message about **Eventarc / service agent permissions not yet
  propagated**, wait two minutes and run `npx firebase deploy` again — this is a
  known first-deploy race, not a real error.
- If it asks to **delete functions that exist in the project but not locally**, answer
  **N** (there should be none on a fresh project anyway).
- On success it prints **Hosting URL: https://<project-id>.web.app**.

**Required IAM grant for ZIP downloads** (signed URLs need it):
1. Open https://console.cloud.google.com → select your project (top bar).
2. ☰ menu → **IAM & Admin → IAM**.
3. Find the principal ending in **`-compute@developer.gserviceaccount.com`** (the "Default
   compute service account" — this is the identity 2nd-generation Cloud Functions run as)
   → click the **pencil** (Edit principal).
4. **Add another role** → search **Service Account Token Creator** → select → **Save**.
   Without this, the admin **Download ZIP** button fails with a signing error.
   (Granting it to the `@appspot.gserviceaccount.com` account as well does no harm.)

## Step 6 — Enter the real event configuration

**Recommended: run the provisioning script** (it needs the service-account key from Step 7,
so do Step 7's key download first, then come back):

```bash
GOOGLE_APPLICATION_CREDENTIALS=sa.json GCLOUD_PROJECT=<project-id> node scripts/setup-event.js
```
(PowerShell: `$env:GOOGLE_APPLICATION_CREDENTIALS="sa.json"; $env:GCLOUD_PROJECT="<project-id>"; node scripts/setup-event.js`)

It asks for the couple's names, date text, opening/closing times, slug, PIN, colours and
texts — validating each answer — computes the PIN hash itself, shows a summary, and on
`yes` writes all three documents with the correct types. Re-running it later (e.g. to
change the closing time) is safe: current values are offered as defaults. It prints the
guest, admin and gallery URLs at the end. **If you used the script, skip to Step 7.**

**Manual alternative** — Firebase console → **Build → Firestore Database → Data** tab. You
will create three documents. In the Firestore editor, a field is added with **+ Add field**:
type the field name, pick the **Type** from the dropdown, enter the value, and for `map`
fields click the small **+** inside the map to add nested fields.

### 6a. Document `config/event`
1. Click **+ Start collection** → Collection ID: `config` → **Next**.
2. Document ID: type `event` (do not use Auto-ID) → add these fields → **Save**:

| Field | Type | Value |
|---|---|---|
| slug | string | random letters/digits, ~10 chars, e.g. `k3v9q2m7xw` — becomes part of the QR URL; must not be guessable |
| coupleNames | string | e.g. `Alex & Sam` |
| eventDateText | string | e.g. `Saturday, 12 September 2026` |
| startAt | timestamp | ~2 hours before the ceremony (date+time picker; it uses your local time zone) |
| endAt | timestamp | ~noon the day after the wedding |
| paused | boolean | `false` |
| defaultSnaps | number | `10` |
| galleryReleased | boolean | `false` |
| theme | map | add the nested fields below |

Inside the **theme** map add:

| Nested field | Type | Value |
|---|---|---|
| welcomeText | string | e.g. `Grab the camera and catch the moments we'll miss!` |
| consentText | string | `Photos you take will be shared with the couple and may appear in the wedding gallery.` (keep a consent sentence — it is the guests' notice) |
| font | string | one of `system`, `serif`, `mono`, `rounded` |
| monogramText | string | e.g. `A♥S` (max 16 characters) |
| heroImagePath | null | (Type: null) |
| colors | map | nested: `bg` string `#141210`, `accent` string `#e8b04b`, `text` string `#f5efe6` — any hex colours you like |

Behaviour notes: guests can **join** (enter their name) only between `startAt` and
`endAt`; devices that joined can keep uploading for **7 days after `endAt`** so late
phones still deliver their photos. `slug` and `defaultSnaps` can only be changed here in
the console, never from the admin page.

### 6b. Document `config/private`
Click the `config` collection → **+ Add document** → Document ID `private`:

| Field | Type | Value |
|---|---|---|
| eventCap | number | `2500` |
| galleryPinSalt | string | any random text, e.g. `x91h3pq` |
| galleryPinHash | string | see the command below |
| deleteBy | timestamp | ~3 months after the wedding (your shutdown date) |

Generate the PIN hash in your terminal — replace `SALT` with the exact salt above and
`PIN` with a 4–6 digit PIN you will share with guests after the wedding:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('SALT'+'PIN').digest('hex'))"
```
Paste the printed 64-character string as `galleryPinHash`.

### 6c. Document `counters/event`
**+ Start collection** → Collection ID `counters` → Document ID `event` → one field:
`photoCount`, type **number**, value `0` → **Save**.

## Step 7 — Create the couple's admin login

Admin rights are a "custom claim" that the console cannot set, so run the provided script once:

1. Console → ⚙️ **Project settings → Service accounts** tab → **Generate new private key**
   → **Generate key**. A JSON file downloads. Rename it `sa.json` and move it into the
   `wedding-camera/` folder (it is git-ignored). Treat it like a password.
2. In the terminal:

```bash
GOOGLE_APPLICATION_CREDENTIALS=sa.json GCLOUD_PROJECT=<project-id> \
  node scripts/set-admin.js couple@example.com 'a-strong-password'
```
(Windows PowerShell: `$env:GOOGLE_APPLICATION_CREDENTIALS="sa.json"; $env:GCLOUD_PROJECT="<project-id>"; node scripts/set-admin.js couple@example.com 'a-strong-password'`)

   It prints "Admin claim set for couple@example.com".
3. **Delete the key:** `rm sa.json` (PowerShell: `del sa.json`). You can also revoke it
   later under Project settings → Service accounts → Manage service account permissions.
4. Save the email + password in a password manager on **two** phones.

## Step 8 — Verify the live app (smoke test — mandatory)

**8a. Backend check from your computer** (no phone needed; uses only the public web config):

```bash
node scripts/smoke-test.js
```
It signs in as an anonymous guest, registers a device called "Smoke Test", uploads a tiny
photo, waits for the finalize function's verdict and checks the quota decrement — every
line prints ✓ or ✗ with a hint. It requires the event window to be **open** (opening time
≤ now ≤ closing time); to test before the wedding, temporarily widen the window with
`scripts/setup-event.js`, then set it back. Afterwards, hide the "Smoke Test" photo in admin.

**8b. Real phones:**

1. On your phone, open `https://<project-id>.web.app/e/<slug>/` (your slug from 6a) →
   enter a name → take a test photo.
2. Open `https://<project-id>.web.app/admin/` → sign in → the test photo appears within
   ~30 seconds. This proves upload → validation → quota → moderation work in production.
   Tap it to **hide** it.
3. Open `https://<project-id>.web.app/gallery/<slug>/` → shows "Still developing…".
4. Airplane-mode test: enable airplane mode → take a photo → the badge says "1 sending…"
   → disable airplane mode → the photo appears in admin.
5. Pause test: in admin press **Pause uploads**, take a photo on the phone, press
   **Resume** → the photo appears within ~15 minutes (deferred, never lost).
6. Repeat steps 1–2 on BOTH an iPhone (Safari) and an Android phone (Chrome). This is the
   mandatory real-device test — acceptance criteria are in `docs/PRD.md` §8.

If photos never appear: Firebase console → **Build → Functions → Logs** and look for
`onUploadFinalize` errors (usually a missing field in 6a or a missing `counters/event`).

## Step 9 — QR code and printing

1. The QR target is exactly `https://<project-id>.web.app/e/<slug>/` (trailing slash included).
2. Generate the image in the terminal — it reads the slug from your live config:
   `node scripts/make-qr.js`
   This writes `wedding-qr.png` (1200 px, high error-correction) and `wedding-qr.svg`
   (for a designer/printer) into the `wedding-camera` folder.
3. Print at ≥ 4 × 4 cm. Test-scan from the printed card at arm's length in dim light with
   both phones before printing the full batch.
4. Add one line of copy: *"Scan → type your name → snap 10 photos. Before you leave, open
   the link once more so your last photos finish sending!"*

## Step 10 — Optional: custom domain

Console → **Build → Hosting → Add custom domain** → enter the domain → follow the DNS
records shown (add them at your registrar) → wait for **Connected** (up to 24 h for the
certificate). Then also add the domain under **Authentication → Settings → Authorized
domains**. The `<project-id>.web.app` address keeps working regardless.

## Wedding day & after

- Day-of checklist: "Wedding-day quick reference" in `README.md`.
- If anything looks wrong during the event, press **Pause** in admin — guest photos queue
  safely (on phones and in storage) and are delivered after **Resume**. Nothing is deleted.
- Emergency "make everything appear now": the admin page's reconciliation runs every 15
  minutes automatically; a technical helper can trigger it instantly via the `reconcileNow`
  function.
- After the wedding: admin → review/hide → **Release gallery** → share
  `https://<project-id>.web.app/gallery/<slug>/` + the PIN → **Download ZIP** (store two copies).
- ≤ 3 months later (your `deleteBy` date): run the shutdown steps in `README.md`.
  Put the calendar reminder in now.

## Troubleshooting

- **`firebase deploy` fails on functions the first time:** wait 2 minutes, re-run
  `npx firebase deploy --only functions` (API/permission propagation race).
- **Photos upload but never appear in admin:** Functions → Logs → `onUploadFinalize`.
  Check 6a field names/types exactly, and that `counters/event` exists.
- **"Download ZIP" errors:** the IAM grant in Step 5 is missing.
- **Guest page says "link doesn't look right":** the slug in the URL must exactly match
  `config/event.slug` (case-sensitive), with the trailing slash.
- **Guests get "camera isn't open yet / closed":** check `startAt`/`endAt` — the console
  date picker uses *your* computer's time zone.
- **Admin page says "Not authorized":** Step 7 was not run for that email, or you signed
  in with a different address.
