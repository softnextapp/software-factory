// Tests for the chained-MR base-resolution module.
//
// chain.ts owns only the pure, host-agnostic stack walk now (the glab/gh list
// parsers moved to host.ts — see host.test.ts). Pure: no network, no CLI, no
// process.env. Run: npx tsx .sandcastle/chain.test.ts
import assert from 'node:assert/strict';
import { resolveChainedBase, decideBaseSync, type OpenMergeRequest } from './chain.ts';
import { test, finish } from './test-harness.ts';

const ROOT = 'epic/rgaa-accessibilite';

// Deterministic, increasing iids so the "identical createdAt" case can assert the
// tie-break without depending on array order. Module-level: test() runs its callbacks
// synchronously and in order, so the counter stays monotonic across cases.
let nextIid = 1;
const mr = (sourceBranch: string, targetBranch: string, createdAt: string): OpenMergeRequest => {
  const id = nextIid++;
  return {
    iid: id,
    sourceBranch,
    targetBranch,
    createdAt,
    title: `Draft: ${sourceBranch}`,
    webUrl: `https://gitlab.example.com/x/-/merge_requests/${id}`,
  };
};

// --- resolveChainedBase -----------------------------------------------------

test('nothing open → the root itself, and NOT chained (first ticket of a wave)', () => {
  const r = resolveChainedBase([], ROOT);
  assert.equal(r.base, ROOT);
  assert.equal(r.chained, false);
  assert.deepEqual(r.stack, []);
});

test('one open MR on the root → fork from its branch', () => {
  const a = mr('sandcastle/issue-4-a', ROOT, '2026-07-29T08:00:00Z');
  const r = resolveChainedBase([a], ROOT);
  assert.equal(r.base, 'sandcastle/issue-4-a');
  assert.equal(r.chained, true);
  assert.deepEqual(r.stack.map((m) => m.sourceBranch), ['sandcastle/issue-4-a']);
});

test('three-deep stack resolves to the TOP; input array order is irrelevant', () => {
  const a = mr('branch-a', ROOT, '2026-07-29T08:00:00Z');
  const b = mr('branch-b', 'branch-a', '2026-07-29T09:00:00Z');
  const c = mr('branch-c', 'branch-b', '2026-07-29T10:00:00Z');
  const r = resolveChainedBase([c, a, b], ROOT);
  assert.equal(r.base, 'branch-c');
  assert.deepEqual(
    r.stack.map((m) => m.sourceBranch),
    ['branch-a', 'branch-b', 'branch-c'],
  );
  assert.deepEqual(r.rivals, []);
});

test('MRs outside the stack are ignored (another effort’s MR on main)', () => {
  const a = mr('branch-a', ROOT, '2026-07-29T08:00:00Z');
  const unrelated = mr('feat/something-else', 'main', '2026-07-29T23:00:00Z');
  assert.equal(resolveChainedBase([a, unrelated], ROOT).base, 'branch-a');
  assert.equal(resolveChainedBase([unrelated], ROOT).chained, false);
});

test('forked stack picks the most recent head and reports the loser as a rival', () => {
  const a = mr('branch-a', ROOT, '2026-07-29T08:00:00Z');
  const older = mr('branch-x', 'branch-a', '2026-07-29T09:00:00Z');
  const newer = mr('branch-y', 'branch-a', '2026-07-29T11:00:00Z');
  const r = resolveChainedBase([a, older, newer], ROOT);
  assert.equal(r.base, 'branch-y');
  assert.deepEqual(r.rivals.map((m) => m.sourceBranch), ['branch-x']);
});

test('identical createdAt is broken by iid (no dependence on glab page order)', () => {
  const a = mr('branch-a', ROOT, '2026-07-29T08:00:00Z');
  const first = mr('branch-p', 'branch-a', '2026-07-29T09:00:00Z');
  const second = mr('branch-q', 'branch-a', '2026-07-29T09:00:00Z');
  assert.ok(second.iid > first.iid);
  assert.equal(resolveChainedBase([a, first, second], ROOT).base, 'branch-q');
  assert.equal(resolveChainedBase([a, second, first], ROOT).base, 'branch-q');
});

test('a hand-made cycle terminates (does not hang the round)', () => {
  const a = mr('branch-a', ROOT, '2026-07-29T08:00:00Z');
  const b = mr('branch-b', 'branch-a', '2026-07-29T09:00:00Z');
  const loop = mr('branch-a', 'branch-b', '2026-07-29T10:00:00Z');
  const r = resolveChainedBase([a, b, loop], ROOT);
  assert.equal(r.base, 'branch-b');
});

// --- decideBaseSync (base-branch reconciliation, issue #14) -----------------
// Pure 3-way decision: given the two ancestry facts about local vs origin, what
// should main.ts's syncBaseToOrigin do? Called only when local ≠ origin.

test('decideBaseSync: origin ahead → fast-forward', () => {
  assert.equal(decideBaseSync({ originAheadOfLocal: true, localAheadOfOrigin: false }), 'fast-forward');
});

test('decideBaseSync: local ahead → keep local (legitimate curation, never rewind)', () => {
  assert.equal(decideBaseSync({ originAheadOfLocal: false, localAheadOfOrigin: true }), 'ahead');
});

test('decideBaseSync: neither → diverged (ff-only refuses; warn and skip)', () => {
  assert.equal(decideBaseSync({ originAheadOfLocal: false, localAheadOfOrigin: false }), 'diverged');
});

finish();
