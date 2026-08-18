// Tests for the chained-MR base-resolution module.
//
// chain.ts owns only the pure, host-agnostic stack walk now (the glab/gh list
// parsers moved to host.ts — see host.test.ts). Pure: no network, no CLI, no
// process.env. Run: npx tsx .sandcastle/chain.test.ts
import assert from 'node:assert/strict';
import {
  resolveChainedBase,
  decideBaseSync,
  derivableBases,
  decideChainFeasibility,
  buildUnchainableBaseWarning,
  type OpenMergeRequest,
} from './chain.ts';
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

// --- chain feasibility (issue #24) ------------------------------------------
//
// The revue incident (17 Aug 2026): a run launched with SANDCASTLE_CHAIN=1 but no
// chainable base silently built on the plain label base, and the operator only
// discovered it after the agents had run. These tests pin the pure predicate that
// makes the run REFUSE instead. Feasible here is a config fact (chain on + at
// least one derivable base chainable) — whether a stack is actually open is
// resolveChainedBase's job, and "no open MR on the root" is a legitimate empty
// stack, not a refusal.

const TRUNK = 'main';
const LB = { rgaa: 'epic/rgaa-accessibilite' };

test('derivableBases: trunk + labelBases values, deduped', () => {
  assert.deepEqual(derivableBases(TRUNK, LB), ['main', 'epic/rgaa-accessibilite']);
});

test('derivableBases: a label base equal to the trunk collapses (one derivable base)', () => {
  assert.deepEqual(derivableBases('main', { rgaa: 'main' }), ['main']);
});

test('feasibility: chain off → off, whatever the bases (the round is not chained at all)', () => {
  const r = decideChainFeasibility({ chain: false, baseBranch: TRUNK, labelBases: LB, chainableBases: [] });
  assert.deepEqual(r, { feasible: false, reason: 'off' });
});

test('feasibility: chain on, no chainable base → refused (revue: the run must not start)', () => {
  const r = decideChainFeasibility({ chain: true, baseBranch: TRUNK, labelBases: LB, chainableBases: [] });
  assert.equal(r.feasible, false);
  assert.equal(r.reason, 'no-chainable-base');
});

test('feasibility: a chainable base no ticket can derive → refused (inert by construction)', () => {
  // chainableBases=['develop'] but every derivable base is main/epic — resolving
  // through labels can never produce 'develop', so no round would ever chain.
  const r = decideChainFeasibility({
    chain: true,
    baseBranch: TRUNK,
    labelBases: LB,
    chainableBases: ['develop'],
  });
  assert.equal(r.feasible, false);
  assert.equal(r.reason, 'no-chainable-base');
});

test('feasibility: chainable trunk alone is enough (the flat-repo shape)', () => {
  const r = decideChainFeasibility({
    chain: true,
    baseBranch: TRUNK,
    labelBases: {},
    chainableBases: ['main'],
  });
  assert.deepEqual(r, { feasible: true, chainable: ['main'] });
});

test('feasibility: one chainable label base among several derivable bases is enough', () => {
  const r = decideChainFeasibility({
    chain: true,
    baseBranch: TRUNK,
    labelBases: LB,
    chainableBases: ['epic/rgaa-accessibilite'],
  });
  assert.deepEqual(r, { feasible: true, chainable: ['epic/rgaa-accessibilite'] });
});

// Narrow a refusal to its message — `reason === 'no-chainable-base'` guards every
// access, so a shape change to ChainFeasibility fails HERE rather than at the
// assertion that reads `.message`.
function refusalMessage(r: ReturnType<typeof decideChainFeasibility>): string {
  if (r.feasible === false && r.reason === 'no-chainable-base') return r.message;
  throw new Error(`expected a no-chainable-base refusal, got: ${JSON.stringify(r)}`);
}

test('the refusal message names BOTH settings and says neither suffices alone', () => {
  const message = refusalMessage(
    decideChainFeasibility({ chain: true, baseBranch: TRUNK, labelBases: LB, chainableBases: [] }),
  );
  // Both knobs must be named — each alone leaves the operator mid-way.
  assert.ok(message.includes('labelBases'), 'message must name labelBases');
  assert.ok(message.includes('chainableBases'), 'message must name chainableBases');
  // And the message must say the two COMBINE — naming them without the pairing
  // would let an operator set only one and conclude it is ignored.
  assert.ok(/ne suffit pas seul|exige les deux/i.test(message), 'message must say neither setting suffices alone');
  assert.ok(message.includes('SANDCASTLE_CHAIN'), 'message must name the flag being refused');
});

test('the refusal message stays actionable when there is no label base yet', () => {
  // labelBases={} is the fresh-consumer case: the message must still say how the
  // two settings combine, not assume an epic label exists.
  const message = refusalMessage(
    decideChainFeasibility({ chain: true, baseBranch: TRUNK, labelBases: {}, chainableBases: [] }),
  );
  assert.ok(message.includes('chainableBases'));
});

// --- per-ticket warning (issue #24) ------------------------------------------

test('unchainable-base warning: names the ticket, its base, and the consequence', () => {
  const w = buildUnchainableBaseWarning(19, 'main', ['epic/rgaa-accessibilite']);
  assert.ok(w.includes('#19'), 'must name the ticket');
  assert.ok(w.includes('`main`'), 'must name the ticket’s base');
  assert.ok(w.includes('chainableBases'), 'must name the setting the base is outside of');
  assert.ok(/ne verra pas la pile|will not (see|join)/i.test(w), 'must state the consequence: no stack for this ticket');
});

test('unchainable-base warning: is empty for a chainable base (no noise per ticket)', () => {
  assert.equal(buildUnchainableBaseWarning(19, 'epic/rgaa-accessibilite', ['epic/rgaa-accessibilite']), '');
});

finish();
