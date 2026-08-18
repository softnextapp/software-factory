// Contract tests for the run-unique branch naming + empty-branch sweep (issue #28).
//
// Two effects shipped together, because they close one cause and net the rest:
//   1. an agent branch name is unique PER RUN, not per iteration — `…-r1` collided
//      across two runs of the same ticket, resurrecting a dead run's branch (and
//      with it a silently stale fork base);
//   2. at startup the run sweeps local agent branches with no commit of their own
//      and no open MR, deleting branch + worktree and saying why.
//
// Pure: decideSweep() takes the git facts as plain data and returns the verdict —
// no git, no fs, no network. The commands that gather those facts and act on the
// verdict stay in main.ts. Run: npx tsx .sandcastle/branch-sweep.test.ts
import assert from 'node:assert/strict';
import {
  buildRunBranch,
  parseRunSuffix,
  isAgentBranch,
  runBranchBases,
  decideSweep,
  describeSweep,
  type BranchFacts,
} from './branch-sweep.ts';
import { test, finish } from './test-harness.ts';

// --- buildRunBranch: per-RUN uniqueness --------------------------------------

test('same planner branch, two distinct runs → two distinct branch names', () => {
  const a = buildRunBranch('sandcastle/issue-12-fix-thing', '20260817-2114', 1);
  const b = buildRunBranch('sandcastle/issue-12-fix-thing', '20260818-0930', 1);
  assert.notEqual(a, b);
});

test('same run, iterations 1 and 2 → distinct names (the old -r${i} guarantee holds)', () => {
  const one = buildRunBranch('sandcastle/issue-12-fix-thing', '20260817-2114', 1);
  const two = buildRunBranch('sandcastle/issue-12-fix-thing', '20260817-2114', 2);
  assert.notEqual(one, two);
});

test('same run + iteration, two different tickets → distinct names', () => {
  const a = buildRunBranch('sandcastle/issue-12-a', '20260817-2114', 1);
  const b = buildRunBranch('sandcastle/issue-13-b', '20260817-2114', 1);
  assert.notEqual(a, b);
});

test('name is planner-branch + "-r<run>-<iteration>" — readable, and never the bare planner branch', () => {
  assert.equal(buildRunBranch('sandcastle/issue-12-fix', '20260817-2114', 3), 'sandcastle/issue-12-fix-r20260817-2114-3');
});

test('the round-trip parses back the run id and iteration (sweep knows whose leftover it is)', () => {
  const name = buildRunBranch('sandcastle/issue-12-fix', '20260817-2114', 3);
  const parsed = parseRunSuffix(name);
  assert.ok(parsed !== null);
  assert.equal(parsed.base, 'sandcastle/issue-12-fix');
  assert.equal(parsed.runId, '20260817-2114');
  assert.equal(parsed.iteration, 3);
});

test('parseRunSuffix: the pre-#28 legacy -r<iteration> name parses with runId null', () => {
  // A leftover from before this change (e.g. `…-r1`) is still an agent branch of
  // THIS project and still sweeps by the same rules — the net must catch it.
  const parsed = parseRunSuffix('sandcastle/issue-12-fix-r1');
  assert.ok(parsed !== null);
  assert.equal(parsed.base, 'sandcastle/issue-12-fix');
  assert.equal(parsed.runId, null);
  assert.equal(parsed.iteration, 1);
});

test('parseRunSuffix: -r<n> where n is not a run id nor an iteration → null (not ours)', () => {
  assert.equal(parseRunSuffix('sandcastle/issue-12-fix-r'), null);
  assert.equal(parseRunSuffix('sandcastle/issue-12-fix-rabc'), null);
  assert.equal(parseRunSuffix('sandcastle/issue-12-fix-r2026-x'), null);
  assert.equal(parseRunSuffix('sandcastle/issue-12-fix-r20260817-2114-x'), null);
  // A run id in the new format followed by junk is not a name we ever minted.
  assert.equal(parseRunSuffix('sandcastle/issue-12-fix-r20260817-2114-3-4'), null);
});

// --- isAgentBranch: whose branches the sweep may even look at ----------------

test('isAgentBranch: true for sandcastle/… branches, false for everything else', () => {
  assert.equal(isAgentBranch('sandcastle/issue-12-fix-r20260817-2114-1'), true);
  assert.equal(isAgentBranch('sandcastle/issue-12-fix-r1'), true);
  assert.equal(isAgentBranch('sandcastle/anything'), true);
  assert.equal(isAgentBranch('main'), false);
  assert.equal(isAgentBranch('develop'), false);
  assert.equal(isAgentBranch('epic/rgaa-accessibilite'), false);
  assert.equal(isAgentBranch('feature/x'), false);
  assert.equal(isAgentBranch(''), false);
});

// --- runBranchBases: what a fresh run must not collide with -------------------

test('runBranchBases: every planned branch × every iteration, all carrying the run id', () => {
  const planned = [
    { branch: 'sandcastle/issue-12-a', base: 'main' },
    { branch: 'sandcastle/issue-13-b', base: 'main' },
  ];
  const bases = runBranchBases(planned, '20260818-0900', [1, 2]);
  assert.equal(bases.length, 4);
  assert.ok(bases.includes('sandcastle/issue-12-a-r20260818-0900-1'));
  assert.ok(bases.includes('sandcastle/issue-12-a-r20260818-0900-2'));
  assert.ok(bases.includes('sandcastle/issue-13-b-r20260818-0900-1'));
  assert.ok(bases.includes('sandcastle/issue-13-b-r20260818-0900-2'));
});

// --- decideSweep: the pure verdict --------------------------------------------

const facts = (over: Partial<BranchFacts>): BranchFacts => ({
  branch: 'sandcastle/issue-12-fix-r20260817-2114-1',
  hasOwnCommits: false,
  hasOpenMr: false,
  baseExists: true,
  checkedOutElsewhere: false,
  ...over,
});

test('dead run leftover: no commits, no MR → swept, with the reason named', () => {
  const v = decideSweep(facts({}));
  assert.equal(v.sweep, true);
  assert.ok(v.reason.includes('no commit'), 'reason must name the emptiness');
});

test('a branch carrying commits is NEVER swept — even old, even abandoned', () => {
  const v = decideSweep(facts({ hasOwnCommits: true }));
  assert.equal(v.sweep, false);
  assert.ok(v.reason.includes('commit'));
});

test('a branch with an open MR is NEVER swept', () => {
  const v = decideSweep(facts({ hasOpenMr: true }));
  assert.equal(v.sweep, false);
  assert.ok(v.reason.includes('MR'));
});

test('a branch whose base no longer exists is kept — it is not provably empty', () => {
  // `git rev-list <br> --not --all` counts commits reachable from the branch and no
  // other local ref; with the base gone the count is inflated by the base's own
  // history, so "0 own commits" can no longer be trusted. Keep it; the operator
  // decides. Deleting on a false reading is how real work disappears.
  const v = decideSweep(facts({ baseExists: false }));
  assert.equal(v.sweep, false);
  assert.ok(v.reason.includes('base'));
});

test('a branch checked out in another worktree is never swept (a live run may own it)', () => {
  const v = decideSweep(facts({ checkedOutElsewhere: true }));
  assert.equal(v.sweep, false);
  assert.ok(v.reason.includes('worktree'));
});

test('commits beat MR-beat-base in reporting: the first blocking reason is named', () => {
  const v = decideSweep(facts({ hasOwnCommits: true, hasOpenMr: true, baseExists: false }));
  assert.equal(v.sweep, false);
  assert.ok(v.reason.includes('commit'));
});

// --- describeSweep: the logged line -------------------------------------------

test('describeSweep renders the branch, the verdict and the reason on one line', () => {
  const verdict = decideSweep(facts({}));
  const line = describeSweep(verdict, 'sandcastle/issue-12-fix-r20260817-2114-1');
  assert.ok(line.includes('sandcastle/issue-12-fix-r20260817-2114-1'));
  assert.ok(line.includes('no commit'));
});

test('describeSweep for a kept branch says keep, with the reason', () => {
  const line = describeSweep(decideSweep(facts({ hasOwnCommits: true })), 'sandcastle/issue-12-fix-r1');
  assert.ok(line.includes('kept'));
  assert.ok(line.includes('commit'));
});

finish();
