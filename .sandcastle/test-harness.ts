// Shared harness for the Factory's standalone *.test.ts files.
//
// Each test file runs as its own process (`npx tsx .sandcastle/<x>.test.ts`), so the
// pass/fail counters below are per-process — no cross-file leakage. Extracted so the
// test files share one definition instead of N byte-identical copies; each file stays
// independently runnable. Run the whole suite with `npm test`.
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

/** Run one case; log ok/FAIL and tally. A thrown Error counts as a failure, not a crash. */
export function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL   ' + name + '\n        ' + (e as Error).message);
  }
}

/** Assert a synchronous fn throws. */
export function throws(fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert.ok(threw, 'expected the call to throw, but it did not');
}

/** Print the tally and exit non-zero on any failure. Call once, at the end of a file. */
export function finish(): void {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
