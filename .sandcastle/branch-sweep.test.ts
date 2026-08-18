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
  mintRunId,
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
  assert.equal(
    buildRunBranch('sandcastle/issue-12-fix', '20260817-211432', 3),
    'sandcastle/issue-12-fix-r20260817-211432-3',
  );
});

test('the branch name is a legal git ref: no space, no `..`, no trailing dot or slash', () => {
  const name = buildRunBranch('sandcastle/issue-12-fix', mintRunId(new Date('2026-08-18T09:30:41Z')), 1);
  assert.ok(!/[\s~^:?*[\\]/.test(name), `${name} must carry no character git refuses in a ref`);
  assert.ok(!name.includes('..') && !name.endsWith('.') && !name.endsWith('/'));
});

// --- mintRunId: the run id whose resolution decides acceptance #1 -------------

test('mintRunId renders YYYYMMDD-HHMMSS from the clock it is given', () => {
  assert.equal(mintRunId(new Date('2026-08-18T09:30:41.123Z')), '20260818-093041');
});

test('acceptance #1: two relances in the SAME minute still mint distinct branch names', () => {
  // The regression this guards: at minute resolution a run killed at 09:30:05 and
  // relaunched at 09:30:44 minted the same name, i.e. exactly the resurrected
  // branch (and silently stale fork base) issue #28 was filed to close.
  const killed = mintRunId(new Date('2026-08-18T09:30:05Z'));
  const relance = mintRunId(new Date('2026-08-18T09:30:44Z'));
  assert.notEqual(killed, relance);
  assert.notEqual(
    buildRunBranch('sandcastle/issue-12-fix', killed, 1),
    buildRunBranch('sandcastle/issue-12-fix', relance, 1),
  );
});

test('mintRunId is UTC — the id sorts monotonically across a DST jump', () => {
  const before = mintRunId(new Date('2026-10-25T00:30:00Z'));
  const after = mintRunId(new Date('2026-10-25T01:30:00Z'));
  assert.ok(after > before, `${after} must sort after ${before}`);
});

test('mintRunId is pure: the same instant always yields the same id', () => {
  const instant = new Date('2026-08-18T09:30:41Z');
  assert.equal(mintRunId(instant), mintRunId(new Date(instant.getTime())));
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
  branch: 'sandcastle/issue-12-fix-r20260817-211432-1',
  hasOwnCommits: false,
  hasOpenMr: false,
  attachedToTrunk: true,
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

test('a branch with unrelated history is kept — it is not provably OUR leftover', () => {
  // No merge base with the trunk at all: grafted from somewhere else. Emptiness
  // measured against local tips is too thin a basis to delete on. Keep it; the
  // operator decides. Deleting on a thin reading is how real work disappears.
  const v = decideSweep(facts({ attachedToTrunk: false }));
  assert.equal(v.sweep, false);
  assert.ok(v.reason.includes('unrelated history'));
});

test('a branch checked out in another worktree is never swept (a live run may own it)', () => {
  const v = decideSweep(facts({ checkedOutElsewhere: true }));
  assert.equal(v.sweep, false);
  assert.ok(v.reason.includes('worktree'));
});

test('commits beat MR beat worktree beat history in reporting: the first blocking reason is named', () => {
  const v = decideSweep(
    facts({ hasOwnCommits: true, hasOpenMr: true, checkedOutElsewhere: true, attachedToTrunk: false }),
  );
  assert.equal(v.sweep, false);
  assert.ok(v.reason.includes('commit'));
});

test('every protection alone is enough — no combination of the four ever sweeps', () => {
  // The sweep deletes; the interesting property is that it under-deletes, never
  // over-deletes. Exhaustive over the four facts: the ONLY swept combination is
  // the all-clear one.
  for (const hasOwnCommits of [false, true]) {
    for (const hasOpenMr of [false, true]) {
      for (const checkedOutElsewhere of [false, true]) {
        for (const attachedToTrunk of [false, true]) {
          const v = decideSweep(facts({ hasOwnCommits, hasOpenMr, checkedOutElsewhere, attachedToTrunk }));
          const allClear = !hasOwnCommits && !hasOpenMr && !checkedOutElsewhere && attachedToTrunk;
          assert.equal(
            v.sweep,
            allClear,
            `commits=${hasOwnCommits} mr=${hasOpenMr} wt=${checkedOutElsewhere} trunk=${attachedToTrunk}`,
          );
          assert.notEqual(v.reason, '', 'both verdicts always carry a motive — the log records it');
        }
      }
    }
  }
});

// --- describeSweep: the logged line -------------------------------------------

test('describeSweep renders the branch, the verdict and the reason on one line', () => {
  const verdict = decideSweep(facts({}));
  const line = describeSweep(verdict, 'sandcastle/issue-12-fix-r20260817-211432-1');
  assert.ok(line.includes('sandcastle/issue-12-fix-r20260817-211432-1'));
  assert.ok(line.includes('swept'));
  assert.ok(line.includes('no commit'));
  assert.ok(!line.includes('\n'), 'one branch, one log line — the operator greps it');
});

test('describeSweep for a kept branch says keep, with the reason', () => {
  const line = describeSweep(decideSweep(facts({ hasOwnCommits: true })), 'sandcastle/issue-12-fix-r1');
  assert.ok(line.includes('kept'));
  assert.ok(line.includes('commit'));
});

finish();
