/**
 * Playwright config for the E2E suite (CONTRACTS §10).
 *
 * Assumes the Firebase Emulator Suite (auth 9099 / firestore 8080 / storage 9199 /
 * functions 5001, project demo-wedding) is ALREADY RUNNING and seeded:
 *   firebase emulators:start --project demo-wedding
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed.js
 * The Vite dev server is started automatically (reused if already up).
 */
import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

export default defineConfig({
  testDir: HERE,
  // Upload confirmation goes through the real functions emulator (cold start on
  // the first call) plus retry backoff, so per-test budgets are generous.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          executablePath: '/opt/pw-browsers/chromium',
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'npx vite app --port 5173',
    cwd: REPO_ROOT,
    url: 'http://localhost:5173/',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
