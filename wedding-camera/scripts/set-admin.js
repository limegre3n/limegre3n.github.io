/**
 * One-time admin bootstrap: creates (or finds) the admin email user and sets
 * the { admin: true } custom claim. Works against the Auth emulator or, with
 * GOOGLE_APPLICATION_CREDENTIALS set to a service-account key, against prod.
 *
 * Usage:
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node scripts/set-admin.js admin@example.com <password>
 *   GOOGLE_APPLICATION_CREDENTIALS=sa.json GCLOUD_PROJECT=<id> node scripts/set-admin.js couple@example.com <password>
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: node scripts/set-admin.js <email> <password>');
  process.exit(1);
}
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Set FIREBASE_AUTH_EMULATOR_HOST (emulator) or GOOGLE_APPLICATION_CREDENTIALS (prod).');
  process.exit(1);
}

initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-wedding' });
const auth = getAuth();

let user;
try {
  user = await auth.getUserByEmail(email);
} catch {
  user = await auth.createUser({ email, password, emailVerified: true });
}
await auth.setCustomUserClaims(user.uid, { admin: true });
console.log('Admin claim set for %s (uid %s)', email, user.uid);
process.exit(0);
