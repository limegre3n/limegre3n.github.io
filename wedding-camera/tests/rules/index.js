/**
 * Aggregator so `node --test tests/rules/` works.
 *
 * The Node build used here (v22.22) resolves a directory argument as a module path
 * instead of recursively searching it for test files, so `node --test tests/rules/`
 * loads THIS file and every suite registers through the imports below. Bonus: one
 * process means the suites run sequentially, which is what we want against an emulator
 * shared with the other workstreams.
 *
 * `node --test tests/rules/*.test.mjs` also works and runs the files in parallel;
 * individual suites can be run directly, e.g. `node --test tests/rules/devices.test.mjs`.
 */
import './devices.test.mjs';
import './config.test.mjs';
import './photos.test.mjs';
import './results.test.mjs';
import './audit-counters.test.mjs';
import './storage.test.mjs';
// These two run against the shared `demo-wedding` project (see their headers).
import './storage-gallery.test.mjs';
import './functions.test.mjs';
