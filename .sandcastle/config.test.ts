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

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL   ' + name + '\n        ' + (e as Error).message);
  }
}
function throws(fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert.ok(threw, 'expected the call to throw, but it did not');
}

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

test('loadConfig() convenience wires defaults end to end', () => {
  const c = loadConfig(humanProject, {});
  assert.equal(c.run.profile, 'split');
  assert.equal(c.effectiveMaxParallel, 4);
  assert.equal(c.providerFor('planner').model, c.project.providers.zai.model);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
