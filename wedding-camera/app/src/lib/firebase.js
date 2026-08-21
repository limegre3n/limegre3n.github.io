/**
 * Shared Firebase init (orchestrator-owned — see docs/CONTRACTS.md §11).
 * Connects to local emulators on localhost or when VITE_USE_EMULATORS=1.
 */
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import {
  initializeFirestore, connectFirestoreEmulator, persistentLocalCache,
} from 'firebase/firestore';
import { getStorage, connectStorageEmulator } from 'firebase/storage';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';

// Real values are injected at deploy time via app/.env.production (VITE_FB_*).
// The demo values keep local/emulator development working with zero setup.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY || 'demo-key',
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN || 'demo-wedding.firebaseapp.com',
  projectId: import.meta.env.VITE_FB_PROJECT_ID || 'demo-wedding',
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET || 'demo-wedding.appspot.com',
  appId: import.meta.env.VITE_FB_APP_ID || 'demo-app-id',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = initializeFirestore(app, { localCache: persistentLocalCache() });
export const storage = getStorage(app);
export const functions = getFunctions(app, 'us-central1');

const useEmulators = import.meta.env.VITE_USE_EMULATORS === '1'
  || ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname);

if (useEmulators) {
  const host = globalThis.location?.hostname || '127.0.0.1';
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  connectStorageEmulator(storage, host, 9199);
  connectFunctionsEmulator(functions, host, 5001);
}
