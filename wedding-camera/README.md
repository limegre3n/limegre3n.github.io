# 📸 Wedding Disposable Camera

A zero-install web app: wedding guests scan a QR code, get 10 "exposures" on a
nostalgic film-disposable camera in their phone browser, and shoot candid photos —
no preview, no retakes. Photos upload resiliently (offline queue) into a collection
the couple moderates and later releases as a PIN-protected gallery.

**Docs:** product requirements in [`docs/PRD.md`](docs/PRD.md), technical contracts in
[`docs/CONTRACTS.md`](docs/CONTRACTS.md).

## Local development (no account needed)

Everything runs offline on the Firebase Emulator Suite (`demo-wedding` project):

```bash
npm install && (cd functions && npm install)
npm run emulators                 # auth 9099, firestore 8080, storage 9199, functions 5001
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed.js     # test fixture
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node scripts/set-admin.js admin@test.dev testpass123
npx vite app                      # dev server on 5173
```

Then open:
- Guest camera: http://localhost:5173/e/testslug123/
- Admin: http://localhost:5173/admin/ (admin@test.dev / testpass123)
- Gallery: http://localhost:5173/gallery/testslug123/ (PIN 2468, after release)

Tests:
```bash
node tests/poc/pipeline.mjs       # backend pipeline verification (emulators running)
node --test tests/rules/          # security-rules suite (emulators running)
npm run test:e2e                  # Playwright browser tests (fake camera)
```

## Production setup (one-time, ~30 minutes)

1. Create a Firebase project (console.firebase.google.com) on the **Blaze** plan
   (required for Cloud Functions; expected spend is a few dollars — set a **budget
   alert at $25** in Google Cloud Billing).
2. Enable: Authentication (Anonymous + Email/Password), Firestore, Storage, Hosting.
3. Create `app/.env.production` with the web app's config values:
   `VITE_FB_API_KEY`, `VITE_FB_AUTH_DOMAIN`, `VITE_FB_PROJECT_ID`,
   `VITE_FB_STORAGE_BUCKET`, `VITE_FB_APP_ID`.
4. Update `.firebaserc` with the real project id, then:
   ```bash
   npm run build
   npx firebase deploy
   ```
5. Set the real event config: copy the shapes from `scripts/seed.js` into
   `config/event` and `config/private` via the Firestore console — real couple names,
   dates, a fresh random `slug`, a real PIN hash
   (`node -e "console.log(require('crypto').createHash('sha256').update('SALT'+'PIN').digest('hex'))"`).
6. Create the couple's admin login:
   `GOOGLE_APPLICATION_CREDENTIALS=sa.json GCLOUD_PROJECT=<id> node scripts/set-admin.js couple@example.com <strong-password>`
7. Generate the QR code pointing at `https://<site>/e/<slug>/` and print it.
8. **Test on real phones** — one iPhone (Safari) and one Android (Chrome), per the
   acceptance criteria in `docs/PRD.md` §8. This is mandatory before the wedding.

## Wedding-day quick reference (for the couple)

- **Is it working?** Open the admin page — photos appearing means yes.
- **Hide a photo:** tap it in the admin grid.
- **Something's wrong:** tap **Pause** in admin (guests see "camera resting";
  their photos queue safely on their phones and send after resume).
- **Grandma wants more film:** admin → Devices → +10 next to her name.
- **End of night:** remind guests to open the camera link once more before leaving
  so queued photos finish sending.
- **Day after:** admin → Download ZIP (do this before reviewing — it's the backup).

## Shutdown (≤3 months after the wedding — required)

1. Confirm the final ZIP is downloaded and safely stored in two places.
2. Firebase console: delete the Storage bucket contents, then the Firestore data,
   then disable/delete the project. This deletes all guest data (PRIVACY-003).
