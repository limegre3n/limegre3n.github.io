/**
 * E2E suite for the persistent upload queue (workstream ②).
 *
 * Scope: `app/src/guest/queue.js` against the REAL emulator suite (auth /
 * firestore / storage / functions, project demo-wedding). Deliberately UI-free —
 * the module is driven from a blank page through `harness.js`, so workstream ①'s
 * guest DOM can change without touching these tests.
 *
 * Covers: UPLOAD-001..006 + CONTRACTS §6 (protocol) and §11 (event shape).
 */
import { test, expect } from '@playwright/test';
import {
  openHarness, waitForHarness, blockUploads, unblockUploads, assertStorageRulesLoaded,
  pending, events, pageErrors, snapsRemaining, setSnapsRemaining,
} from './helpers.js';

/**
 * Waits for the queue to drain (or reach `n`) without racing the pump.
 * On failure it dumps item states + emitted events, which is normally enough to
 * tell a queue bug apart from an emulator/environment problem.
 */
async function expectPending(page, n, timeout = 120_000) {
  try {
    await expect.poll(() => pending(page), {
      timeout,
      intervals: [200, 300, 500, 1000],
      message: `queue pendingCount should settle at ${n}`,
    }).toBe(n);
  } catch (err) {
    const dump = await page.evaluate(() => ({
      states: window.__h.states(), events: window.__h.events, errors: window.__h.errors,
    })).catch(() => null);
    throw new Error(`${err.message}\nqueue diagnostics: ${JSON.stringify(dump)}`);
  }
}

const confirmations = (evs) => evs.filter((e) => e.confirmedDelta === 1).length;

test.describe('upload queue', () => {
  // Fail fast (and legibly) when the shared emulator suite is unhealthy.
  test.beforeAll(assertStorageRulesLoaded);

  test('a) happy path: enqueue → confirmed, one snap consumed', async ({ page }) => {
    await openHarness(page);
    const { uid, defaultSnaps } = await page.evaluate(() => window.__h.signIn('Happy Path'));

    const init = await page.evaluate(() => window.__h.initQueue());
    expect(init).toEqual({ pending: 0, persistent: true });

    await page.evaluate(() => window.__h.shoot(1));
    expect(await pending(page)).toBe(1); // queued before any network attempt

    await expectPending(page, 0);

    const evs = await events(page);
    // CONTRACTS §11 event shape.
    expect(evs.some((e) => e.pending === 1)).toBe(true);
    expect(confirmations(evs)).toBe(1);
    expect(evs.at(-1)).toEqual({ pending: 0, confirmedDelta: 1 });
    expect(evs.some((e) => 'rejection' in e)).toBe(false);

    // Server-side quota is authoritative (A2 / UPLOAD-004).
    expect(await snapsRemaining(uid)).toBe(defaultSnaps - 1);
    expect(await pageErrors(page)).toEqual([]);
  });

  test('b) offline: two photos stay pending, both confirm after reconnect', async ({ page, context }) => {
    await openHarness(page);
    const { uid, defaultSnaps } = await page.evaluate(() => window.__h.signIn('Airplane Mode'));
    await page.evaluate(() => window.__h.initQueue());

    await context.setOffline(true);
    await page.evaluate(() => window.__h.shoot(2));
    expect(await pending(page)).toBe(2);

    // Ride out a couple of backoff cycles: nothing may drain or crash (PRD §8.4).
    await page.waitForTimeout(6_000);
    expect(await pending(page)).toBe(2);
    expect(await pageErrors(page)).toEqual([]);
    const offlineStates = await page.evaluate(() => window.__h.states());
    expect(offlineStates).toHaveLength(2);
    expect(offlineStates.every((s) => ['queued', 'uploading'].includes(s.state))).toBe(true);

    await context.setOffline(false);
    await expectPending(page, 0);

    const evs = await events(page);
    expect(confirmations(evs)).toBe(2);
    expect(evs.at(-1).pending).toBe(0);
    // Exactly two snaps consumed, zero duplicates.
    expect(await snapsRemaining(uid)).toBe(defaultSnaps - 2);

    const onlineEvents = await page.evaluate(() => window.__h.onlineEvents);
    // eslint-disable-next-line no-console
    console.log(`[queue e2e] 'online' events observed in-page: ${onlineEvents} (UPLOAD-002 fast retry)`);
    expect(await pageErrors(page)).toEqual([]);
  });

  test('c) persistence: a queued photo survives a reload and then uploads', async ({ page, context }) => {
    await openHarness(page);
    const { uid, defaultSnaps } = await page.evaluate(() => window.__h.signIn('Reloader'));
    await page.evaluate(() => window.__h.initQueue());

    await context.setOffline(true);
    await page.evaluate(() => window.__h.shoot(1));
    expect(await pending(page)).toBe(1);

    // UPLOAD-001: the payload is in IndexedDB before any upload attempt.
    const records = await page.evaluate(() => window.__h.idbRecords());
    expect(records).toHaveLength(1);
    expect(records[0].hasBlob).toBe(true);
    expect(records[0].state).toBe('queued');

    // Reload needs the network, so keep only the Storage path blocked across it.
    await blockUploads(page);
    await context.setOffline(false);
    await page.reload();
    await waitForHarness(page);

    const restoredUid = await page.evaluate(() => window.__h.waitAuth());
    expect(restoredUid).toBe(uid);

    const init = await page.evaluate(() => window.__h.initQueue());
    expect(init.pending).toBe(1); // UPLOAD-006: resumed from IndexedDB
    expect(init.persistent).toBe(true);

    await unblockUploads(page);
    await expectPending(page, 0);

    const evs = await events(page);
    expect(confirmations(evs)).toBe(1);
    expect(await snapsRemaining(uid)).toBe(defaultSnaps - 1);
    expect(await page.evaluate(() => window.__h.idbRecords())).toEqual([]);
    expect(await pageErrors(page)).toEqual([]);
  });

  test('d) rejection: exhausted quota surfaces rejection "quota" and clears the item', async ({ page }) => {
    await openHarness(page);
    const { uid } = await page.evaluate(() => window.__h.signIn('No Film Left'));
    await page.evaluate(() => window.__h.initQueue());

    // Quota fields are server-owned (firestore.rules) — set out-of-band.
    await setSnapsRemaining(uid, 0);

    await page.evaluate(() => window.__h.shoot(1));
    expect(await pending(page)).toBe(1);

    await expectPending(page, 0);

    const evs = await events(page);
    expect(evs.at(-1)).toEqual({ pending: 0, rejection: 'quota' });
    expect(confirmations(evs)).toBe(0);
    // UPLOAD-004: a rejected upload never consumes a snap (stays at 0, no negative).
    expect(await snapsRemaining(uid)).toBe(0);
    expect(await pageErrors(page)).toEqual([]);
  });

  test('e) memory-only fallback when IndexedDB is unavailable', async ({ page }) => {
    // Only the queue's own database is blocked; Firebase's own stores keep working.
    await page.addInitScript(() => {
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (name, ...rest) => {
        if (name === 'wedding-camera') throw new DOMException('blocked by test', 'SecurityError');
        return open(name, ...rest);
      };
    });
    await openHarness(page);
    const { uid, defaultSnaps } = await page.evaluate(() => window.__h.signIn('Private Mode'));

    const init = await page.evaluate(() => window.__h.initQueue());
    // UPLOAD-006: ephemeral storage is detectable by workstream ①.
    expect(init).toEqual({ pending: 0, persistent: false });

    await page.evaluate(() => window.__h.shoot(1));
    expect(await pending(page)).toBe(1);
    await expectPending(page, 0);

    expect(confirmations(await events(page))).toBe(1);
    expect(await snapsRemaining(uid)).toBe(defaultSnaps - 1);
    expect(await pageErrors(page)).toEqual([]);
  });

  test('f) blob loss: a corrupted persisted record is dropped, not retried forever', async ({ page }) => {
    await openHarness(page);
    const { uid, defaultSnaps } = await page.evaluate(() => window.__h.signIn('Corrupt Record'));

    await page.evaluate(() => window.__h.seedBlobLossRecord());
    const init = await page.evaluate(() => window.__h.initQueue());
    expect(init.pending).toBe(0);
    expect(await page.evaluate(() => window.__h.idbRecords())).toEqual([]);

    // …and the queue is still fully functional afterwards.
    await page.evaluate(() => window.__h.shoot(1));
    await expectPending(page, 0);
    expect(confirmations(await events(page))).toBe(1);
    expect(await snapsRemaining(uid)).toBe(defaultSnaps - 1);
    expect(await pageErrors(page)).toEqual([]);
  });
});
