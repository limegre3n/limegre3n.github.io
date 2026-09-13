/**
 * Aggregator so `node --test tests/unit/` works — same reason as tests/rules/index.js:
 * Node v22.22 resolves a directory argument as a module path instead of recursively
 * searching it, so this file is what gets loaded and every suite registers below.
 *
 * `node --test tests/unit/*.test.mjs` also works. These suites are pure (no emulator,
 * no browser) and run in milliseconds.
 */
import './lens.test.mjs';
