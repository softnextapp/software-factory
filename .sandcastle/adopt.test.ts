// Contract tests for the in-place adoption script (`.sandcastle/adopt.ts`).
// Pure: no fs, no network, no spawned processes — every helper takes the primitive
// it would otherwise read from disk. main() (the side-effecting flow) is verified
// separately by running adopt against a scratch consumer dir, not here.
//
// Run: npx tsx .sandcastle/adopt.test.ts   (also part of `npm test`)
import assert from 'node:assert/strict';
import {
  detectPackageManager,
  hasPnpmWorkspace,
  pmAddArgs,
  consumerRootIsCjs,
  buildExcludePatch,
  engineRuntimeDeps,
  computeMissing,
  toSpecs,
  shouldClearEngineLink,
  parseArgs,
  isConsumerRuntimeFile,
  engineManifestPath,
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
// hasPnpmWorkspace — does the consumer root declare a pnpm workspace?
// Issue #23: pnpm v10 reads workspace config from `pnpm-workspace.yaml`, so its mere
// presence at the consumer root makes the root a workspace root. A `pnpm add` in a
// subdir (adopt installs the Engine with cwd:.sandcastle/) then adopts that subdir as a
// workspace member and writes into the SHARED root `pnpm-lock.yaml` — the lockfile leak
// #22's out-of-tree install was meant to prevent. Detecting the file gates the
// `--ignore-workspace` flag that makes .sandcastle/ a standalone install instead.
// ---------------------------------------------------------------------------

test('pnpm-workspace.yaml at the consumer root → true', () => {
  assert.equal(hasPnpmWorkspace(['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml']), true);
});
test('no pnpm-workspace.yaml → false (the common non-workspace pnpm consumer)', () => {
  assert.equal(hasPnpmWorkspace(['pnpm-lock.yaml', 'package.json', 'src']), false);
});
test('an empty directory listing → false', () => {
  assert.equal(hasPnpmWorkspace([]), false);
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
test('opts omitted → unchanged argv (backward compatible — existing call sites)', () => {
  // main() step 2a (dev tools at root) and any pre-#23 caller pass no opts.
  assert.deepEqual(pmAddArgs('pnpm', ['tsx@4'], true), ['add', '-D', 'tsx@4']);
  assert.deepEqual(pmAddArgs('pnpm', ['@ai-hero/sandcastle@0.12.0'], false), [
    'add',
    '@ai-hero/sandcastle@0.12.0',
  ]);
});
test('pnpm + ignoreWorkspace → --ignore-workspace flag (.sandcastle/ standalone install; #23)', () => {
  assert.deepEqual(pmAddArgs('pnpm', ['@ai-hero/sandcastle@0.12.0'], false, { ignoreWorkspace: true }), [
    'add',
    '--ignore-workspace',
    '@ai-hero/sandcastle@0.12.0',
  ]);
});
test('pnpm + dev + ignoreWorkspace → -D then --ignore-workspace', () => {
  assert.deepEqual(pmAddArgs('pnpm', ['tsx@4'], true, { ignoreWorkspace: true }), [
    'add',
    '-D',
    '--ignore-workspace',
    'tsx@4',
  ]);
});
test('pnpm + ignoreWorkspace:false → no flag (the gated-off non-workspace case)', () => {
  assert.deepEqual(pmAddArgs('pnpm', ['@ai-hero/sandcastle@0.12.0'], false, { ignoreWorkspace: false }), [
    'add',
    '@ai-hero/sandcastle@0.12.0',
  ]);
});
test('--ignore-workspace is pnpm-only: npm with ignoreWorkspace:true gets NO flag', () => {
  // `--ignore-workspace` is a pnpm concept; npm/yarn/bun never receive it.
  assert.deepEqual(pmAddArgs('npm', ['@ai-hero/sandcastle@0.12.0'], false, { ignoreWorkspace: true }), [
    'install',
    '@ai-hero/sandcastle@0.12.0',
  ]);
  assert.deepEqual(pmAddArgs('yarn', ['tsx@4'], false, { ignoreWorkspace: true }), ['add', 'tsx@4']);
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
// shouldClearEngineLink — must adopt clear a stale node_modules/@ai-hero before install?
// Issue #11: linkEngine (adopt's offline fallback) or a manual workaround leaves a
// foreign @ai-hero SYMLINK pointing at another tree; a later `<pm> add` then writes
// *through* it into that tree, leaving the Engine declared yet unresolvable. Clearing
// the symlink before the install lets the package manager write into the consumer's own
// node_modules.
// ---------------------------------------------------------------------------

test('foreign @ai-hero symlink → clear it before install', () => {
  // The linkEngine fallback (or a manual workaround) symlinks the whole @ai-hero scope
  // at another tree — lstat sees a symlink, so this entry must be cleared (issue #11).
  assert.equal(shouldClearEngineLink({ isSymbolicLink: () => true }), true);
});
test('package-manager-owned @ai-hero directory → leave it alone', () => {
  // npm's real dir, or pnpm's @ai-hero scope dir (which itself contains a store
  // symlink) — lstat sees a directory, not a link; the package manager owns it.
  assert.equal(shouldClearEngineLink({ isSymbolicLink: () => false }), false);
});
test('no @ai-hero entry yet → nothing to clear', () => {
  assert.equal(shouldClearEngineLink(null), false);
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
// isConsumerRuntimeFile — should this `.sandcastle/` file ship to a consumer?
// Issue #22: step 1's `git archive HEAD -- .sandcastle/` copied the Factory's OWN
// contract tests (*.test.ts) + their harness into the consumer. A consumer's test
// runner (vitest/jest, default glob `**/*.test.ts`) then collects and runs them in
// the wrong context → 11 red files that look like the implementer left work behind.
// Runtime files (sources, prompts, Dockerfiles, the ESM shim, tsconfig) always ship.
// ---------------------------------------------------------------------------

test('a Factory contract test does NOT ship — *.test.ts', () => {
  assert.equal(isConsumerRuntimeFile('.sandcastle/host.test.ts'), false);
  assert.equal(isConsumerRuntimeFile('.sandcastle/adopt.test.ts'), false);
});
test('a *.test.tsx contract test does NOT ship either', () => {
  assert.equal(isConsumerRuntimeFile('.sandcastle/foo.test.tsx'), false);
});
test('a *.spec.ts / *.spec.tsx contract test does NOT ship (vitest/jest default glob)', () => {
  // The Factory has none today, but the consumer's runner would collect them just like
  // *.test.ts — match the spec's stated intent (the runner's default glob), not just
  // today's layout (issue #22).
  assert.equal(isConsumerRuntimeFile('.sandcastle/host.spec.ts'), false);
  assert.equal(isConsumerRuntimeFile('.sandcastle/foo.spec.tsx'), false);
});
test('the shared test harness does NOT ship — only tests import it', () => {
  assert.equal(isConsumerRuntimeFile('.sandcastle/test-harness.ts'), false);
});
test('runtime sources DO ship', () => {
  assert.equal(isConsumerRuntimeFile('.sandcastle/main.ts'), true);
  assert.equal(isConsumerRuntimeFile('.sandcastle/host.ts'), true);
  assert.equal(isConsumerRuntimeFile('.sandcastle/config.ts'), true);
});
test('prompts, Dockerfiles, the ESM shim and tsconfig all ship', () => {
  assert.equal(isConsumerRuntimeFile('.sandcastle/plan-prompt.md'), true);
  assert.equal(isConsumerRuntimeFile('.sandcastle/Dockerfile'), true);
  assert.equal(isConsumerRuntimeFile('.sandcastle/Dockerfile.base'), true);
  assert.equal(isConsumerRuntimeFile('.sandcastle/package.json'), true);
  assert.equal(isConsumerRuntimeFile('.sandcastle/tsconfig.json'), true);
});
test('a nested *.test.ts / harness (future layout) is still caught — basename match', () => {
  assert.equal(isConsumerRuntimeFile('.sandcastle/sub/foo.test.ts'), false);
  assert.equal(isConsumerRuntimeFile('.sandcastle/sub/test-harness.ts'), false);
});
test('a name merely ending in "test.ts" without the .test. delimiter DOES ship', () => {
  // `latest.ts` must not be caught by a naive /test\.ts$/ regex.
  assert.equal(isConsumerRuntimeFile('.sandcastle/latest.ts'), true);
});
test('a name containing "test-harness" as a substring still ships (exact match only)', () => {
  assert.equal(isConsumerRuntimeFile('.sandcastle/test-harness-config.ts'), true);
});

// ---------------------------------------------------------------------------
// engineManifestPath — WHERE the Engine resolves in an adopted consumer
// Issue #22: the Engine installs OUT-OF-TREE under .sandcastle/node_modules (its
// manifest is the .sandcastle/package.json ESM shim), NOT the consumer's root, so
// `<pm> add` never touches the consumer's tracked package.json / lockfile. This path
// is the single source of truth for engineResolves / linkEngine.
// ---------------------------------------------------------------------------

test('the Engine resolves under .sandcastle/node_modules, not the consumer root', () => {
  const p = engineManifestPath('/home/me/app');
  assert.equal(p, '/home/me/app/.sandcastle/node_modules/@ai-hero/sandcastle/package.json');
});
test('it does NOT point at the consumer root node_modules (the pre-#22 location)', () => {
  const p = engineManifestPath('/home/me/app');
  assert.ok(!p.endsWith('/app/node_modules/@ai-hero/sandcastle/package.json'));
  assert.ok(p.includes('.sandcastle/node_modules'));
});
test('no trailing slash on the consumer root is tolerated', () => {
  assert.equal(
    engineManifestPath('/home/me/app/'),
    '/home/me/app/.sandcastle/node_modules/@ai-hero/sandcastle/package.json',
  );
});

// ---------------------------------------------------------------------------
// Integration of the helpers — one full "what would we install?" decision
// ---------------------------------------------------------------------------

test('end-to-end decision: a pnpm CJS consumer missing only the engine', () => {
  // A fresh consumer (tsx/typescript/@types/node already present, CJS, pnpm) that
  // resolves the Engine nowhere. Only @ai-hero/sandcastle is installed — OUT-OF-TREE
  // at .sandcastle/ now (issue #22), so these specs run with `cwd: .sandcastle/`, not
  // at the root; the argv shape below is unchanged. main() takes the spec from
  // `runtime.deps` (the Factory's declared version), gated on `engineResolves` — which
  // for this consumer is false, so it coincides with `missing.deps` here. The CJS root
  // also arms the shim-repair gate (the shim itself ships in step 1).
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

test('end-to-end decision: a pnpm-WORKSPACE consumer installs the Engine standalone (#23)', () => {
  // captable-manager: pnpm + a root pnpm-workspace.yaml. Without --ignore-workspace,
  // `pnpm add` run with cwd:.sandcastle/ adopts .sandcastle/ as a workspace member and
  // writes the @ai-hero/sandcastle dep into the SHARED root pnpm-lock.yaml — the leak.
  // Detection of pnpm-workspace.yaml must arm --ignore-workspace on the Engine argv so
  // the install stays scoped to .sandcastle/ (its own .sandcastle/pnpm-lock.yaml), and
  // the root lockfile stays byte-identical. (Dev tools at root, step 2a, are unaffected —
  // they keep the plain argv since they SHOULD land at the workspace root.)
  const rootEntries = ['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', 'src'];
  const pm: PackageManager = detectPackageManager(rootEntries);
  assert.equal(pm, 'pnpm');
  const ignoreWorkspace = hasPnpmWorkspace(rootEntries);
  assert.equal(ignoreWorkspace, true);
  const engineArgv = pmAddArgs(pm, ['@ai-hero/sandcastle@0.12.0'], false, { ignoreWorkspace });
  assert.deepEqual(engineArgv, ['add', '--ignore-workspace', '@ai-hero/sandcastle@0.12.0']);
  // Dev tools (step 2a, cwd:consumerRoot) keep the plain argv — they belong at the root.
  assert.deepEqual(pmAddArgs(pm, ['tsx@^4.23.0'], true), ['add', '-D', 'tsx@^4.23.0']);
});

test('end-to-end decision: a pnpm NON-workspace consumer keeps the plain argv (#23)', () => {
  // No pnpm-workspace.yaml → no leak vector → --ignore-workspace stays off. This is the
  // #22 scratch-consumer case: argv unchanged, root lockfile clean, .sandcastle/pnpm-lock.yaml.
  const rootEntries = ['pnpm-lock.yaml', 'package.json', 'src'];
  const pm: PackageManager = detectPackageManager(rootEntries);
  assert.equal(hasPnpmWorkspace(rootEntries), false);
  assert.deepEqual(
    pmAddArgs(pm, ['@ai-hero/sandcastle@0.12.0'], false, {
      ignoreWorkspace: hasPnpmWorkspace(rootEntries),
    }),
    ['add', '@ai-hero/sandcastle@0.12.0'],
  );
});

finish();
