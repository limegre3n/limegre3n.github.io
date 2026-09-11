# Deployment Guide — from repo to live wedding camera

Follow these steps in order on your own computer (Mac/Windows/Linux). Time: ~45–60 min.
You need: a Google account, and Node.js 20+ installed (nodejs.org, LTS installer).

---

## Step 1 — Get the code

```bash
git clone https://github.com/limegre3n/limegre3n.github.io.git
cd limegre3n.github.io
git checkout claude/wedding-camera-discovery-nw1ze1   # or main after merging
cd wedding-camera
npm install
cd functions && npm install && cd ..
```

## Step 2 — Create the Firebase project

1. Go to https://console.firebase.google.com → **Add project**.
2. Name it (e.g. `alex-sam-wedding`). Disable Google Analytics when asked (we don't use it).
3. When the project opens, note the **Project ID** (e.g. `alex-sam-wedding-4f2a1`) — you'll
   need it several times below.
4. **Upgrade to the Blaze plan** (⚙️ Settings → Usage and billing → Modify plan).
   Cloud Functions require it. Expected spend is a few dollars total.
5. **Set a budget alert:** in the same billing area, open the linked Google Cloud billing
   account → Budgets & alerts → Create budget → $25/month, email alerts at 50/90/100%.

## Step 3 — Enable the services

In the Firebase console, left sidebar → **Build**:

1. **Authentication** → Get started → Sign-in method → enable **Anonymous** and
   **Email/Password**.
2. **Firestore Database** → Create database → **Production mode** → choose a region
   close to the wedding (e.g. `europe-west1` or `us-central1`) → Done.
   ⚠️ Remember the region — Storage should use the same one.
3. **Storage** → Get started → Production mode → same region as Firestore.
4. **Hosting** → Get started (you can skip its CLI instructions; we deploy below).

## Step 4 — Register the web app and configure the build

1. Console → ⚙️ Project settings → General → Your apps → **`</>` (Web)** → nickname
   "wedding-camera" → Register (skip Hosting checkbox here).
2. It shows a `firebaseConfig` object. Copy the values into a new file
   `app/.env.production` (create it inside the `wedding-camera/app/` folder):

```
VITE_FB_API_KEY=AIza...
VITE_FB_AUTH_DOMAIN=<project-id>.firebaseapp.com
VITE_FB_PROJECT_ID=<project-id>
VITE_FB_STORAGE_BUCKET=<project-id>.appspot.com   # use the exact value shown in the console
VITE_FB_APP_ID=1:1234567890:web:abcdef123456
```

3. Point the CLI at your project — edit `.firebaserc` (in `wedding-camera/`):

```json
{ "projects": { "default": "<project-id>" } }
```

## Step 5 — Deploy

```bash
npx firebase login          # opens a browser; sign in with the project's Google account
npm run build               # builds the frontend into app/dist
npx firebase deploy         # deploys hosting + rules + functions
```

First-time function deploys can take several minutes and may ask to enable APIs — answer yes.
When it finishes it prints your **Hosting URL**: `https://<project-id>.web.app`.

**One IAM grant for ZIP export** (signed download URLs): in Google Cloud console →
IAM & Admin → IAM → find the service account named like
`<project-id>@appspot.gserviceaccount.com` → Edit → add role
**Service Account Token Creator**. Without this, the admin "Download ZIP" button can
fail with a signing error.

## Step 6 — Create the real event configuration

In Firebase console → Firestore → **Start collection**:

**Document `config/event`** (collection id `config`, document id `event`):

| Field | Type | Value |
|---|---|---|
| slug | string | a random slug, e.g. `k3v9q2m7xw` (letters/digits, ~10 chars — this becomes the QR URL; don't make it guessable) |
| coupleNames | string | e.g. `Alex & Sam` |
| eventDateText | string | e.g. `Saturday, 12 September 2026` |
| startAt | timestamp | ~2 hours before the ceremony |
| endAt | timestamp | ~noon the day after |
| paused | boolean | `false` |
| defaultSnaps | number | `10` |
| galleryReleased | boolean | `false` |
| theme | map | see below |

`theme` map fields: `welcomeText` (string), `consentText` (string — keep the consent
sentence!), `font` (string: `system`, `serif`, `mono`, or `rounded`), `monogramText`
(string, e.g. `A♥S`), `heroImagePath` (null), and `colors` (map with `bg`, `accent`,
`text` — hex strings like `#141210`, `#e8b04b`, `#f5efe6`).

**Document `config/private`** (document id `private`, same collection):

| Field | Type | Value |
|---|---|---|
| eventCap | number | `2500` |
| galleryPinSalt | string | any random string, e.g. `x91h3` |
| galleryPinHash | string | see command below |
| deleteBy | timestamp | ~3 months after the wedding |

Generate the PIN hash (replace SALT and PIN — PIN is 4–6 digits you'll share with guests
after the wedding):

```bash
node -e "console.log(require('crypto').createHash('sha256').update('SALT'+'PIN').digest('hex'))"
```

**Document `counters/event`** (collection `counters`, document `event`):
one field `photoCount`, number, `0`.

## Step 7 — Create the couple's admin login

Custom claims can't be set from the console, so use the provided script once:

1. Console → ⚙️ Project settings → **Service accounts** → Generate new private key →
   save as `sa.json` inside `wedding-camera/` (it's git-ignored; delete it after this step).
2. Run:

```bash
GOOGLE_APPLICATION_CREDENTIALS=sa.json GCLOUD_PROJECT=<project-id> \
  node scripts/set-admin.js couple@example.com 'a-strong-password'
rm sa.json
```

3. Store the email+password in a password manager on **two** phones.

## Step 8 — Verify the live app (smoke test)

1. Open `https://<project-id>.web.app/e/<slug>/` on your phone → enter a name →
   take a test photo.
2. Open `https://<project-id>.web.app/admin/` → log in → the test photo appears
   (this proves upload → validation → quota → moderation all work in production).
   Hide the test photo.
3. Open `https://<project-id>.web.app/gallery/<slug>/` → should show "still developing".
4. Airplane-mode test: enable airplane mode, take a photo, watch the "1 sending…" badge,
   re-enable data → confirm it appears in admin.
5. Repeat step 1–2 on BOTH an iPhone (Safari) and an Android (Chrome). **This is the
   mandatory real-device test** — see acceptance criteria in `docs/PRD.md` §8.

## Step 9 — QR code and printing

1. The QR target is exactly: `https://<project-id>.web.app/e/<slug>/`
2. Generate a QR (any generator works, e.g. the `qrencode` CLI or a reputable site —
   the URL is not secret-sensitive beyond the slug, but prefer an offline tool):
   `npx qrcode -o wedding-qr.png "https://<project-id>.web.app/e/<slug>/"`
3. Print at ≥4×4 cm, test-scan from paper at arm's length in dim light with both phones.
4. Print table cards with one line of instructions plus: *"Before you leave, open the
   camera link once more so your last photos finish sending!"*

## Step 10 — Optional: custom domain

Firebase console → Hosting → Add custom domain → follow the DNS instructions
(~$12/yr at any registrar; allow up to 24h for certificates). The `<project-id>.web.app`
URL keeps working either way.

## Wedding day & after

- Day-of checklist: see "Wedding-day quick reference" in `README.md`.
- After the wedding: admin → review/hide → **Release gallery** → share
  `https://<project-id>.web.app/gallery/<slug>/` + the PIN → **Download ZIP** (store two copies).
- ≤3 months later: run the shutdown steps in `README.md` (export confirmed → delete
  Storage + Firestore data → delete the project). Put a calendar reminder in now.

## Troubleshooting

- **Deploy fails on functions:** re-run `npx firebase deploy --only functions` — first
  deploys sometimes race API enablement.
- **Photos upload but never appear in admin:** check Functions logs (console → Functions
  → Logs) for `onUploadFinalize` errors; usually a missing `config/event` field or
  `counters/event` doc.
- **"Download ZIP" errors:** the IAM grant in Step 5 is missing.
- **Guest page says "link doesn't look right":** the slug in the URL must exactly match
  `config/event.slug`.
- **Everything broken mid-event:** press Pause in admin; guests' photos queue on their
  phones and send after you resume. Photos are not lost.
