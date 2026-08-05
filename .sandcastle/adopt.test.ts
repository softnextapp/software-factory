// Contract tests for the in-place adoption script (`.sandcastle/adopt.ts`).
// Pure: no fs, no network, no spawned processes — every helper takes the primitive
// it would otherwise read from disk. main() (the side-effecting flow) is verified
// separately by running adopt against a scratch consumer dir, not here.
//
// Run: npx tsx .sandcastle/adopt.test.ts   (also part of `npm test`)
import assert from 'node:assert/strict';
import {
  detectPackageManager,
  pmAddArgs,
  consumerRootIsCjs,
  buildExcludePatch,
  engineRuntimeDeps,
  computeMissing,
  toSpecs,
  parseArgs,
  type PackageManager,
} from './adopt.ts';

import { test, finish } from './test-harness.ts';

// ---------------------------------------------------------------------------
// detectPackageManager — lockfile → pm, with npm as the fallback
// ---------------------------------------------------------------------------

test('pnpm-lock.yaml → pnpm', () => {
  assert.equal(detectPackageManager(['src', 'pnpm-lock.yaml', 'package.json']), 'pnpm');
});
test('yarn.lock → yarn', () => {
  assert.equal(detectPackageManager(['yarn.lock']), 'yarn');
});
test('bun.lockb → bun', () => {
  assert.equal(detectPackageManager(['bun.lockb']), 'bun');
});
test('bun.lock → bun (newer Bun lockfile name)', () => {
  assert.equal(detectPackageManager(['bun.lock']), 'bun');
});
test('package-lock.json → npm', () => {
  assert.equal(detectPackageManager(['package-lock.json']), 'npm');
});
test('no lockfile → npm (the default, never throws)', () => {
  assert.equal(detectPackageManager(['src', 'README.md']), 'npm');
  assert.equal(detectPackageManager([]), 'npm');
});
test('mixed lockfiles resolve to the non-npm one (npm is checked last)', () => {
  // A repo that somehow has both package-lock.json and pnpm-lock.yaml → pnpm.
  assert.equal(detectPackageManager(['package-lock.json', 'pnpm-lock.yaml']), 'pnpm');
  assert.equal(detectPackageManager(['package-lock.json', 'yarn.lock']), 'yarn');
});

// ---------------------------------------------------------------------------
// pmAddArgs — the install argv (subcommand + flags + specs, NO binary) for execFileSync(pm, …)
// ---------------------------------------------------------------------------

test('npm uses `install` (not `add`), -D for devDeps', () => {
  assert.deepEqual(pmAddArgs('npm', ['tsx@4'], false), ['install', 'tsx@4']);
  assert.deepEqual(pmAddArgs('npm', ['tsx@4'], true), ['install', '-D', 'tsx@4']);
});
test('pnpm/yarn/bun use `add`', () => {
  assert.deepEqual(pmAddArgs('pnpm', ['@ai-hero/sandcastle@0.12.0'], false), [
    'add',
    '@ai-hero/sandcastle@0.12.0',
  ]);
  assert.deepEqual(pmAddArgs('yarn', ['tsx@4'], true), ['add', '-D', 'tsx@4']);
  assert.deepEqual(pmAddArgs('bun', ['tsx@4'], false), ['add', 'tsx@4']);
});
test('multiple specs are passed through in order', () => {
  assert.deepEqual(pmAddArgs('pnpm', ['a@1', 'b@2', 'c@3'], true), ['add', '-D', 'a@1', 'b@2', 'c@3']);
});

// ---------------------------------------------------------------------------
// consumerRootIsCjs — is the consumer's ROOT package.json CJS?
// After issue #8 the shim ships as a tracked .sandcastle/package.json (step 1's copy
// lands it for every consumer), so this no longer decides whether the consumer *gets*
// a shim — it gates only adopt's step-3 REPAIR of a shim that is somehow missing. A
// CJS root is the only case a missing shim would actually break main.ts; an ESM root
// doesn't need it, so the gate stays idle there.
// ---------------------------------------------------------------------------

test('CJS consumer (no type field) → treated as CJS', () => {
  assert.equal(consumerRootIsCjs('{"name":"app"}'), true);
});
test('explicit "type":"commonjs" → CJS', () => {
  assert.equal(consumerRootIsCjs('{"type":"commonjs"}'), true);
});
test('ESM consumer ("type":"module") → NOT CJS', () => {
  assert.equal(consumerRootIsCjs('{"name":"app","type":"module"}'), false);
});
test('no package.json at all → treated as CJS (tsx defaults to CJS)', () => {
  assert.equal(consumerRootIsCjs(null), true);
});
test('malformed package.json → treated as CJS (a redundant repair is harmless)', () => {
  assert.equal(consumerRootIsCjs('{ not json'), true);
});

// ---------------------------------------------------------------------------
// buildExcludePatch — idempotent append of `.sandcastle/` to .git/info/exclude
// ---------------------------------------------------------------------------

test('null exclude → append ".sandcastle/"', () => {
  const p = buildExcludePatch(null);
  assert.equal(p.append, true);
  assert.equal(p.content, '.sandcastle/\n');
});
test('empty exclude → append ".sandcastle/"', () => {
  assert.deepEqual(buildExcludePatch(''), { append: true, content: '.sandcastle/\n' });
});
test('exclude already listing ".sandcastle/" → do not append', () => {
  assert.deepEqual(buildExcludePatch('node_modules\n.sandcastle/\n'), { append: false, content: '' });
});
test('exclude listing ".sandcastle" (no slash) → treated as present, do not append', () => {
  assert.deepEqual(buildExcludePatch('.sandcastle'), { append: false, content: '' });
});
test('a line merely containing ".sandcastle/" as a substring is NOT treated as the ignore (no false negative)', () => {
  // e.g. a comment "# keep .sandcastle/ local" must not suppress the real append.
  const p = buildExcludePatch('# keep .sandcastle/ local\n');
  assert.equal(p.append, true);
  assert.equal(p.content, '.sandcastle/\n');
});
test('content ending without a newline gets a leading separator (no glueing onto an existing line)', () => {
  const p = buildExcludePatch('node_modules');
  assert.equal(p.content, '\n.sandcastle/\n');
});
test('content ending with a newline gets NO extra leading separator', () => {
  const p = buildExcludePatch('node_modules\n');
  assert.equal(p.content, '.sandcastle/\n');
});

// ---------------------------------------------------------------------------
// engineRuntimeDeps + computeMissing + toSpecs — what must be installed?
// ---------------------------------------------------------------------------

const FACTORY_PKG = JSON.stringify({
  dependencies: { '@ai-hero/sandcastle': '0.12.0' },
  devDependencies: { tsx: '^4.23.0', typescript: '^5.6.0', '@types/node': '^22.0.0' },
});

test('engineRuntimeDeps reads deps + devDeps from the Factory package.json', () => {
  const t = engineRuntimeDeps(FACTORY_PKG);
  assert.deepEqual(t.deps, { '@ai-hero/sandcastle': '0.12.0' });
  assert.deepEqual(t.devDeps, { tsx: '^4.23.0', typescript: '^5.6.0', '@types/node': '^22.0.0' });
});
test('engineRuntimeDeps: null/malformed → empty tables (never throws)', () => {
  assert.deepEqual(engineRuntimeDeps(null), { deps: {}, devDeps: {} });
  assert.deepEqual(engineRuntimeDeps('{ bad'), { deps: {}, devDeps: {} });
});
test('engineRuntimeDeps: missing devDependencies → empty devDeps, deps kept', () => {
  assert.deepEqual(engineRuntimeDeps('{"dependencies":{"@ai-hero/sandcastle":"0.12.0"}}'), {
    deps: { '@ai-hero/sandcastle': '0.12.0' },
    devDeps: {},
  });
});

test('computeMissing: consumer with none of the runtime → all of it missing', () => {
  const m = computeMissing(engineRuntimeDeps(FACTORY_PKG), '{"name":"app"}');
  assert.deepEqual(m.deps, { '@ai-hero/sandcastle': '0.12.0' });
  assert.deepEqual(m.devDeps, { tsx: '^4.23.0', typescript: '^5.6.0', '@types/node': '^22.0.0' });
});
test('computeMissing: a dep the consumer already has (any version, deps OR devDeps) is NOT re-added', () => {
  const consumer = JSON.stringify({
    dependencies: { '@ai-hero/sandcastle': '0.10.0' }, // older, but present → left alone
    devDependencies: { typescript: '^5.0.0' }, // present → left alone
  });
  const m = computeMissing(engineRuntimeDeps(FACTORY_PKG), consumer);
  assert.deepEqual(m.deps, {}); // engine already declared by the consumer
  assert.deepEqual(m.devDeps, { tsx: '^4.23.0', '@types/node': '^22.0.0' }); // only the missing two
});
test('computeMissing: a dep in the consumer devDeps still counts as "have" for a Factory dep', () => {
  // The consumer owns its versions; presence anywhere means "don't inject".
  const consumer = JSON.stringify({ devDependencies: { '@ai-hero/sandcastle': '0.12.0' } });
  const m = computeMissing(engineRuntimeDeps(FACTORY_PKG), consumer);
  assert.deepEqual(m.deps, {});
});
test('computeMissing: null consumer package.json → everything missing', () => {
  const m = computeMissing(engineRuntimeDeps(FACTORY_PKG), null);
  assert.deepEqual(m.deps, { '@ai-hero/sandcastle': '0.12.0' });
  assert.deepEqual(m.devDeps, { tsx: '^4.23.0', typescript: '^5.6.0', '@types/node': '^22.0.0' });
});

test('toSpecs: name@version in insertion order', () => {
  assert.deepEqual(toSpecs({ '@ai-hero/sandcastle': '0.12.0', tsx: '^4.23.0' }), [
    '@ai-hero/sandcastle@0.12.0',
    'tsx@^4.23.0',
  ]);
});
test('toSpecs: empty table → empty list', () => {
  assert.deepEqual(toSpecs({}), []);
});

// ---------------------------------------------------------------------------
// parseArgs — the CLI surface
// ---------------------------------------------------------------------------

test('parseArgs: a bare consumer path', () => {
  const r = parseArgs(['node', 'adopt.ts', '/home/me/app']);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.consumerPath, '/home/me/app');
    assert.equal(r.force, false);
  }
});
test('parseArgs: --force', () => {
  const r = parseArgs(['node', 'adopt.ts', '/home/me/app', '--force']);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.force, true);
});
test('parseArgs: -f short flag, anywhere', () => {
  const r = parseArgs(['node', 'adopt.ts', '-f', '/home/me/app']);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.force, true);
});
test('parseArgs: missing path → usage error', () => {
  const r = parseArgs(['node', 'adopt.ts']);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.error.includes('usage'));
});
test('parseArgs: --force with no path → still a usage error (not a silent force-noop)', () => {
  const r = parseArgs(['node', 'adopt.ts', '--force']);
  assert.equal(r.ok, false);
});
test('parseArgs: two positional paths → usage error', () => {
  const r = parseArgs(['node', 'adopt.ts', '/a', '/b']);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// Integration of the helpers — one full "what would we install?" decision
// ---------------------------------------------------------------------------

test('end-to-end decision: a pnpm CJS consumer missing only the engine', () => {
  // Mirrors the captable-manager case: has tsx/typescript/@types/node already,
  // CJS (no "type":"module"), pnpm. Only @ai-hero/sandcastle should be installed;
  // the CJS root also arms the shim-repair gate (the shim itself ships in step 1).
  const consumer = JSON.stringify({
    name: 'captable-manager',
    devDependencies: { tsx: '^4.19.0', typescript: '^5.6.0', '@types/node': '^22.0.0' },
  });
  const runtime = engineRuntimeDeps(FACTORY_PKG);
  const missing = computeMissing(runtime, consumer);
  const pm: PackageManager = detectPackageManager(['pnpm-lock.yaml', 'package.json', 'src']);
  assert.equal(pm, 'pnpm');
  assert.deepEqual(toSpecs(missing.deps), ['@ai-hero/sandcastle@0.12.0']);
  assert.deepEqual(toSpecs(missing.devDeps), []); // all three dev tools already present
  assert.equal(consumerRootIsCjs(consumer), true); // CJS root → repair gate fires
  assert.deepEqual(pmAddArgs(pm, toSpecs(missing.deps), false), ['add', '@ai-hero/sandcastle@0.12.0']);
});

test('end-to-end decision: an npm ESM greenfield-style consumer needs nothing installed', () => {
  // Already has the full runtime and is ESM → no installs; ESM root, so the
  // shim-repair gate is idle (the shim still ships, via step 1's tracked-file copy).
  const consumer = JSON.stringify({
    type: 'module',
    dependencies: { '@ai-hero/sandcastle': '0.12.0' },
    devDependencies: { tsx: '^4.23.0', typescript: '^5.6.0', '@types/node': '^22.0.0' },
  });
  const missing = computeMissing(engineRuntimeDeps(FACTORY_PKG), consumer);
  assert.deepEqual(toSpecs(missing.deps), []);
  assert.deepEqual(toSpecs(missing.devDeps), []);
  assert.equal(consumerRootIsCjs(consumer), false);
});

finish();
