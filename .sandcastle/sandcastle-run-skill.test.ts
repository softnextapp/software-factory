// Contract test for the operator skill `skills/sandcastle-run/SKILL.md`: the set of
// `SANDCASTLE_*` variables the skill documents must be exactly the set `loadRunConfig`
// reads. Pure: reads two committed static files + feeds synthetic strings to the two
// extractors — no network, no secrets, no process.env.
// Run: npx tsx .sandcastle/sandcastle-run-skill.test.ts
//
// Why a bijection and not a containment check: the expensive direction is OMISSION.
// A `SANDCASTLE_FORCE` added to loadRunConfig and never written into the skill is a
// knob Claude cannot see — the operator says "refais-le" and gets a no-op round. The
// other direction (a variable documented but read nowhere) is a lie in the table, and
// just as cheap to catch here.
//
// The skill lives OUTSIDE `.claude/skills/` on purpose — it is ours, it has no
// upstream, and nothing hashes it. See docs/adr/0006-own-skills-live-outside-the-lock-scan.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, finish } from './test-harness.ts';

/** The two committed files under test (repo root is process.cwd() under `npm test`). */
const SKILL_PATH = join(process.cwd(), 'skills', 'sandcastle-run', 'SKILL.md');
const CONFIG_PATH = join(process.cwd(), '.sandcastle', 'config.ts');

/** Any `SANDCASTLE_<NAME>` token. A bare `SANDCASTLE_*` (the wildcard in prose) is not one. */
const VAR = /\bSANDCASTLE_[A-Z0-9_]+/g;

/**
 * The `SANDCASTLE_*` variables a source text READS off an env record — `env.X`, the
 * shape loadRunConfig uses throughout. Matching the read (not any mention) is what
 * keeps the error messages inside loadRunConfig, which name `SANDCASTLE_FORCE` and
 * `SANDCASTLE_ONLY` in prose, from counting twice or standing in for a real read.
 */
function envKeysRead(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/\benv\.(SANDCASTLE_[A-Z0-9_]+)/g)) out.add(m[1]!);
  return out;
}

/**
 * Narrow a source file to one function's body, so `envKeysRead` reports the run-config
 * surface rather than every env read in the file. Brace-free on purpose: the body ends
 * at the first column-0 `}`, which is exactly how this repo formats a top-level
 * function. Throws when the function is gone — a rename must break this test loudly,
 * not silently reduce it to scanning an empty string.
 */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `expected to find \`${signature}\` in the source`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `expected \`${signature}\` to end at a column-0 brace`);
  return source.slice(start, end);
}

/** Every `SANDCASTLE_*` variable the skill body mentions, anywhere (table, prose, examples). */
function documentedVars(skill: string): Set<string> {
  return new Set(skill.match(VAR) ?? []);
}

/**
 * The two real sides of the bijection, read at TEST time rather than module scope: a
 * renamed `skills/` directory or a moved config.ts must surface as a named failing case
 * the harness reports, not an exception thrown before it prints a single line.
 */
function runKnobsRead(): Set<string> {
  const config = readFileSync(CONFIG_PATH, 'utf8');
  return envKeysRead(functionBody(config, 'export function loadRunConfig'));
}

function skillVars(): Set<string> {
  return documentedVars(readFileSync(SKILL_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------
// The extractors themselves — synthetic inputs, so a green bijection below can
// never be the result of both sides extracting nothing.
// ---------------------------------------------------------------------------

test('envKeysRead picks up an `env.SANDCASTLE_X` read and ignores a prose mention', () => {
  const src = 'const a = env.SANDCASTLE_ALPHA;\nthrow new Error("SANDCASTLE_BETA is required");';
  assert.deepEqual([...envKeysRead(src)], ['SANDCASTLE_ALPHA']);
});

test('envKeysRead ignores a non-SANDCASTLE env read', () => {
  assert.deepEqual([...envKeysRead('env.HOME + env.SANDCASTLE_ALPHA')], ['SANDCASTLE_ALPHA']);
});

test('documentedVars collects every mention and dedupes', () => {
  const body = 'Use `SANDCASTLE_ONLY=42`; SANDCASTLE_ONLY restricts. Also SANDCASTLE_CHAIN=1.';
  assert.deepEqual([...documentedVars(body)].sort(), ['SANDCASTLE_CHAIN', 'SANDCASTLE_ONLY']);
});

test('documentedVars does not count a bare `SANDCASTLE_*` wildcard as a variable', () => {
  assert.deepEqual([...documentedVars('les variables SANDCASTLE_* du run')], []);
});

test('functionBody stops at the next column-0 brace — a later env read does not leak in', () => {
  const src = [
    'export function loadRunConfig(env) {',
    '  return { a: env.SANDCASTLE_ALPHA };',
    '}',
    'export function other(env) {',
    '  return env.SANDCASTLE_OMEGA;',
    '}',
  ].join('\n');
  const body = functionBody(src, 'export function loadRunConfig');
  assert.deepEqual([...envKeysRead(body)], ['SANDCASTLE_ALPHA']);
});

test('functionBody throws when the function was renamed away', () => {
  assert.throws(() => functionBody('export function somethingElse() {\n}\n', 'export function loadRunConfig'));
});

// ---------------------------------------------------------------------------
// Non-vacuity — both sides must actually have found the real surface.
// ---------------------------------------------------------------------------

test('loadRunConfig reads a non-trivial set of SANDCASTLE_* variables', () => {
  const read = runKnobsRead();
  assert.ok(read.size >= 5, `expected loadRunConfig to read ≥5 variables, got ${read.size}`);
  // An anchor: the profile selector has been the run surface since ADR-0004.
  assert.ok(read.has('SANDCASTLE_PROFILE'), 'expected SANDCASTLE_PROFILE among the reads');
});

test('the skill documents a non-trivial set of SANDCASTLE_* variables', () => {
  const documented = skillVars();
  assert.ok(documented.size >= 5, `expected the skill to name ≥5 variables, got ${documented.size}`);
});

// ---------------------------------------------------------------------------
// The bijection — the point of the file.
// ---------------------------------------------------------------------------

test('every variable loadRunConfig reads is documented in the skill (no omission)', () => {
  const documented = skillVars();
  const missing = [...runKnobsRead()].filter((k) => !documented.has(k)).sort();
  assert.deepEqual(
    missing,
    [],
    `run knobs invisible to the operator skill: ${missing.join(', ')} — ` +
      'add them to the frontier table in skills/sandcastle-run/SKILL.md.',
  );
});

test('every variable the skill documents is read by loadRunConfig (nothing invented)', () => {
  const read = runKnobsRead();
  const invented = [...skillVars()].filter((k) => !read.has(k)).sort();
  assert.deepEqual(
    invented,
    [],
    `the skill names variables loadRunConfig does not read: ${invented.join(', ')}.`,
  );
});

finish();
