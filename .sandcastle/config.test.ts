// Contract tests for the Factory's canonical config surface.
// Pure: no network, no secrets, no process.env (env is passed explicitly).
// Run: npx tsx .sandcastle/config.test.ts
//
// See docs/adr/0004-converged-config-driven-orchestration.md for the contract.
import assert from 'node:assert/strict';
import {
  loadRunConfig,
  resolveConfig,
  loadConfig,
  DEFAULT_PROJECT_CONFIG,
  type ProjectConfig,
} from './config.ts';

import { test, throws, finish } from './test-harness.ts';

// ---------------------------------------------------------------------------
// loadRunConfig — the env contract
// ---------------------------------------------------------------------------

test('empty env → split profile and default knobs', () => {
  const r = loadRunConfig({});
  assert.equal(r.profile, 'split');
  assert.equal(r.maxIterations, 10);
  assert.equal(r.maxParallel, 4);
  assert.equal(r.chain, false);
  assert.equal(r.dryRun, false);
  assert.equal(r.only, null);
  assert.equal(r.force, false);
});

test('SANDCASTLE_PROFILE=opus → opus', () => {
  assert.equal(loadRunConfig({ SANDCASTLE_PROFILE: 'opus' }).profile, 'opus');
});

test('unknown SANDCASTLE_PROFILE throws and names the valid profiles', () => {
  try {
    loadRunConfig({ SANDCASTLE_PROFILE: 'bogus' });
    assert.fail('should have thrown');
  } catch (e) {
    const msg = (e as Error).message;
    assert.ok(msg.includes('SANDCASTLE_PROFILE'), `message should name the var: ${msg}`);
    assert.ok(msg.includes('split') && msg.includes('opus'), `message should list profiles: ${msg}`);
  }
});

test('maxIterations parses', () => {
  assert.equal(loadRunConfig({ SANDCASTLE_MAX_ITERATIONS: '5' }).maxIterations, 5);
});

test('maxIterations rejects 0 and non-integers', () => {
  throws(() => loadRunConfig({ SANDCASTLE_MAX_ITERATIONS: '0' }));
  throws(() => loadRunConfig({ SANDCASTLE_MAX_ITERATIONS: 'abc' }));
  throws(() => loadRunConfig({ SANDCASTLE_MAX_ITERATIONS: '-3' }));
});

test('maxParallel parses and rejects 0', () => {
  assert.equal(loadRunConfig({ SANDCASTLE_MAX_PARALLEL: '3' }).maxParallel, 3);
  throws(() => loadRunConfig({ SANDCASTLE_MAX_PARALLEL: '0' }));
});

test('chain/dryRun: 1|true → true, 0|false|empty|absent → false (strict, not Boolean())', () => {
  assert.equal(loadRunConfig({ SANDCASTLE_CHAIN: '1' }).chain, true);
  assert.equal(loadRunConfig({ SANDCASTLE_CHAIN: 'true' }).chain, true);
  assert.equal(loadRunConfig({ SANDCASTLE_CHAIN: 'TRUE' }).chain, true);
  assert.equal(loadRunConfig({ SANDCASTLE_CHAIN: '0' }).chain, false);
  assert.equal(loadRunConfig({ SANDCASTLE_CHAIN: 'false' }).chain, false);
  assert.equal(loadRunConfig({ SANDCASTLE_CHAIN: '' }).chain, false);
  assert.equal(loadRunConfig({}).chain, false);
  assert.equal(loadRunConfig({ SANDCASTLE_DRYRUN: '0' }).dryRun, false);
  assert.equal(loadRunConfig({ SANDCASTLE_DRYRUN: '1' }).dryRun, true);
});

test('only: parses a comma list, trims, drops empties', () => {
  assert.deepEqual(loadRunConfig({ SANDCASTLE_ONLY: '29, 31 ,' }).only, [29, 31]);
});

test('only: empty/absent → null', () => {
  assert.equal(loadRunConfig({ SANDCASTLE_ONLY: '' }).only, null);
  assert.equal(loadRunConfig({}).only, null);
});

test('only: non-numeric entry throws', () => {
  throws(() => loadRunConfig({ SANDCASTLE_ONLY: '29,x' }));
});

test('force=1 requires only', () => {
  throws(() => loadRunConfig({ SANDCASTLE_FORCE: '1' }));
  const r = loadRunConfig({ SANDCASTLE_FORCE: '1', SANDCASTLE_ONLY: '7' });
  assert.equal(r.force, true);
});

// ---------------------------------------------------------------------------
// resolveConfig — project identity × run config
// ---------------------------------------------------------------------------

const humanProject: ProjectConfig = DEFAULT_PROJECT_CONFIG;

const agentProject: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
  gitHost: 'gh',
  mergeStrategy: 'agent',
  profiles: {
    split: { planner: 'zai', implementer: 'zai', reviewer: 'anthropic', merger: 'zai' },
    opus: { planner: 'anthropic', implementer: 'anthropic', reviewer: 'anthropic', merger: 'anthropic' },
  },
};

test('DEFAULT_PROJECT_CONFIG.queueLabels accepts sandcastle OR ready-for-agent out of the box', () => {
  // The Factory's own repo uses `sandcastle`; captable-manager uses `ready-for-agent`.
  // Both must queue with zero per-consumer config (issue #15); any consumer can narrow it.
  assert.deepEqual(DEFAULT_PROJECT_CONFIG.queueLabels, ['sandcastle', 'ready-for-agent']);
});

test('DEFAULT_PROJECT_CONFIG ships no install hook and copies node_modules', () => {
  // Repo-specific (yarn 4 / npm / pnpm / none): the Factory ships NO install hook and
  // copies node_modules as the only host→sandbox path (a no-op in a repo that has none).
  // These are consumer knobs now, so the defaults must be the values main.ts used to
  // hardcode — a consumer who does nothing gets the same behaviour (issue #19).
  assert.deepEqual(DEFAULT_PROJECT_CONFIG.hooks, {});
  assert.deepEqual(DEFAULT_PROJECT_CONFIG.copyToWorktree, ['node_modules']);
});

test('DEFAULT_PROJECT_CONFIG ships the report phase OFF', () => {
  // `adopt --force` copies config.ts into every consumer, and most have no report skill
  // and no platform to publish to. This one default travels the furthest of any in this
  // file, so it is pinned here rather than inferred from shouldRunReport (ADR-0004).
  assert.equal(DEFAULT_PROJECT_CONFIG.report, null);
});

test('DEFAULT_PROJECT_CONFIG ignores the pnpm local store in worktrees', () => {
  // A pnpm consumer's `pnpm install` materializes `.pnpm-store/`; untracked it trips the
  // Engine's "uncommitted changes" check (issue #20). The Factory ships the pnpm store as
  // the default worktree-exclude list so a consumer who does nothing is covered, and
  // resolveConfig carries a consumer's override through unchanged.
  assert.deepEqual(DEFAULT_PROJECT_CONFIG.worktreeExclude, ['.pnpm-store/']);
  const yarnConsumer: ProjectConfig = {
    ...DEFAULT_PROJECT_CONFIG,
    worktreeExclude: ['.pnpm-store/', '.yarn/cache/'],
  };
  assert.deepEqual(loadConfig(yarnConsumer, {}).project.worktreeExclude, [
    '.pnpm-store/',
    '.yarn/cache/',
  ]);
});

test('a DB-backed consumer (setup hook + empty copyToWorktree) is expressible purely in config', () => {
  // The captable-manager live run (2026-08-05) had to patch main.ts for exactly this
  // shape: a Postgres/Prisma/Playwright repo needs a `sandbox-setup` hook AND an empty
  // copyToWorktree (pnpm rejects a host-copied node_modules — ERR_PNPM_ABORTED…). After
  // issue #19 a consumer sets it in config.ts and never edits main.ts; resolveConfig
  // must carry both onto the resolved project unchanged.
  const dbProject: ProjectConfig = {
    ...DEFAULT_PROJECT_CONFIG,
    hooks: {
      sandbox: { onSandboxReady: [{ command: 'sandbox-setup', timeoutMs: 900_000 }] },
    },
    copyToWorktree: [],
  };
  const c = loadConfig(dbProject, {});
  assert.deepEqual(c.project.copyToWorktree, []);
  assert.deepEqual(c.project.hooks.sandbox?.onSandboxReady, [
    { command: 'sandbox-setup', timeoutMs: 900_000 },
  ]);
});

test('human + split → three core roles, reviewer on anthropic', () => {
  const c = resolveConfig(humanProject, loadRunConfig({}));
  assert.deepEqual([...c.roles], ['planner', 'implementer', 'reviewer']);
  assert.equal(c.providerFor('reviewer').model, c.project.providers.anthropic.model);
});

test('agent + split → four roles including merger', () => {
  const c = resolveConfig(agentProject, loadRunConfig({}));
  assert.deepEqual([...c.roles], ['planner', 'implementer', 'reviewer', 'merger']);
});

test('agent strategy but profile lacks merger binding → throws', () => {
  // humanProject profiles have no merger; flipping strategy to agent must fail.
  throws(() => resolveConfig({ ...humanProject, mergeStrategy: 'agent' }, loadRunConfig({})));
});

test('profile exists as a ProfileName but is undefined in this project → throws', () => {
  // Profiles is typed total over ('split'|'opus'), so to exercise the runtime
  // guard we pass a project that omits 'opus' via a cast — simulating a consumer
  // who hand-edited their config and left a profile malformed. The guard exists
  // for exactly that (configs can be sourced from JSON, not just typed TS).
  const onlySplit = {
    ...humanProject,
    profiles: { split: humanProject.profiles.split },
  } as unknown as ProjectConfig;
  throws(() => resolveConfig(onlySplit, loadRunConfig({ SANDCASTLE_PROFILE: 'opus' })));
});

test('profile binding to an unknown provider → throws', () => {
  const bad: ProjectConfig = {
    ...humanProject,
    profiles: {
      split: { planner: 'nope', implementer: 'zai', reviewer: 'anthropic' },
      opus: humanProject.profiles.opus,
    },
  };
  throws(() => resolveConfig(bad, loadRunConfig({})));
});

test('effectiveMaxParallel: chain forces 1 regardless of maxParallel', () => {
  const c = resolveConfig(
    humanProject,
    loadRunConfig({ SANDCASTLE_CHAIN: '1', SANDCASTLE_MAX_PARALLEL: '4' }),
  );
  assert.equal(c.effectiveMaxParallel, 1);
});

test('effectiveMaxParallel: no chain → maxParallel', () => {
  const c = resolveConfig(humanProject, loadRunConfig({ SANDCASTLE_MAX_PARALLEL: '3' }));
  assert.equal(c.effectiveMaxParallel, 3);
});

test('default split profile: GLM 5.3 at effort low on both z.ai roles', () => {
  // Issue #43: the shipped default for Split mode is GLM 5.3 at effort low.
  // Effort follows the provider (README), and `zai` is bound only by `split` —
  // so pinning the provider IS pinning what Split runs on. `opus` is unaffected.
  const c = loadConfig(DEFAULT_PROJECT_CONFIG, {});
  assert.equal(c.run.profile, 'split');
  for (const role of ['planner', 'implementer'] as const) {
    assert.equal(c.providerFor(role).model, 'glm-5.3[1m]');
    assert.equal(c.providerFor(role).effort, 'low');
  }
  // The cross-provider reviewer keeps its own model and effort.
  assert.equal(c.providerFor('reviewer').model, 'claude-opus-5');
  assert.equal(c.providerFor('reviewer').effort, 'medium');
});

test('loadConfig() convenience wires defaults end to end', () => {
  const c = loadConfig(humanProject, {});
  assert.equal(c.run.profile, 'split');
  assert.equal(c.effectiveMaxParallel, 4);
  assert.equal(c.providerFor('planner').model, c.project.providers.zai.model);
});

finish();
