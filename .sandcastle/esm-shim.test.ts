// Regression test for the Factory's self-contained ESM shim (`.sandcastle/package.json`).
//
// `main.ts` uses top-level `await`; tsx/esbuild transpiles that as ESM only when the
// nearest `package.json` has `"type": "module"`. Under adoption (or a manual copy) the
// nearest `package.json` to `.sandcastle/*.ts` is the consumer's root — so a CJS
// consumer (no `"type":"module"`, common e.g. for Next.js apps) cannot even transpile
// `main.ts`. Issue #8.
//
// The fix ships a tracked `.sandcastle/package.json = {"type":"module"}` so the
// ESM-ness is self-contained and independent of any root `package.json`. These tests
// pin the three properties that make that fix actually land under adoption:
//   1. the file exists and declares `"type":"module"`;
//   2. it is tracked-able — NOT matched by `.gitignore`, so `adopt.ts`'s
//      `git archive HEAD -- .sandcastle/` ships it (the copy is the shim's vehicle);
//   3. it carries nothing but the `type` field (a nested package.json that declares
//      dependencies would confuse the consumer's package manager into treating
//      `.sandcastle/` as a workspace).
//
// Run: npx tsx .sandcastle/esm-shim.test.ts   (also part of `npm test`)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { test, finish } from './test-harness.ts';

/** The shipped shim under test (repo root is process.cwd() under `npm test`). */
const SHIM_PATH = join(process.cwd(), '.sandcastle', 'package.json');

/** Read + parse the shim, asserting it exists first (so a missing file fails with the
 * regression message rather than an opaque ENOENT). Shared by the content assertions. */
function loadShim(): Record<string, unknown> {
  assert.ok(existsSync(SHIM_PATH), `${SHIM_PATH} is missing — issue #8 regressed`);
  return JSON.parse(readFileSync(SHIM_PATH, 'utf8')) as Record<string, unknown>;
}

test('`.sandcastle/package.json` exists (the ESM shim ships with the Factory)', () => {
  assert.equal(existsSync(SHIM_PATH), true, `${SHIM_PATH} is missing — issue #8 regressed`);
});

test('the shim declares `"type":"module"` (the field tsx keys the output format off)', () => {
  assert.equal(loadShim().type, 'module', 'shim must declare "type":"module" for top-level await');
});

test('the shim is the ONLY field: { "type": "module" }', () => {
  // A nested package.json with deps/name would make some package managers treat
  // `.sandcastle/` as a workspace root. The shim exists solely to set the module
  // system — keep it minimal.
  assert.deepEqual(Object.keys(loadShim()).sort(), ['type'], 'shim must carry only the "type" field');
});

test('the shim is NOT gitignored (so adopt.ts ships it via `git archive HEAD`)', () => {
  // This is the suite's only cross-process probe: we shell out to `git check-ignore`
  // (exits 0 when the path IS ignored, non-zero when it is not) rather than reimplement
  // gitignore matching — `.gitignore` semantics (+ nested negate rules) are not worth
  // re-deriving, and `git` is already a Factory prerequisite. We want NOT ignored so
  // the tracked-file copy in adopt.ts step 1 actually includes it.
  assert.ok(existsSync(SHIM_PATH), 'shim missing — cannot assert its ignore state');
  let ignored = false;
  try {
    execFileSync('git', ['-C', process.cwd(), 'check-ignore', '--quiet', SHIM_PATH]);
    ignored = true; // exit 0 → ignored
  } catch {
    ignored = false; // non-zero → not ignored (what we want)
  }
  assert.equal(ignored, false, `${SHIM_PATH} is gitignored — adoption would not ship it`);
});

finish();
