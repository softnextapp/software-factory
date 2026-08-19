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
  decidePlannerChainMode,
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

test('derivableBases: no label base → the trunk alone (the fresh-consumer default)', () => {
  assert.deepEqual(derivableBases('main', {}), ['main']);
});

test('derivableBases: several labels → trunk first, then each distinct base, deduped', () => {
  // Two labels pointing at the SAME epic must not yield it twice — the list feeds
  // both the refusal message and the dry-run report, where a repeat reads as a bug.
  assert.deepEqual(derivableBases('main', { rgaa: 'epic/a', a11y: 'epic/a', perf: 'epic/b' }), [
    'main',
    'epic/a',
    'epic/b',
  ]);
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

test('feasibility: several chainable bases → all of them, in derivable order (trunk first)', () => {
  const r = decideChainFeasibility({
    chain: true,
    baseBranch: TRUNK,
    labelBases: LB,
    // Deliberately reversed relative to the derivable order: `chainable` follows the
    // bases the round can derive, not the order the operator happened to type.
    chainableBases: ['epic/rgaa-accessibilite', 'main'],
  });
  assert.deepEqual(r, { feasible: true, chainable: ['main', 'epic/rgaa-accessibilite'] });
});

test('feasibility: a chainable list mixing a derivable and a stray base → feasible, stray dropped', () => {
  // The stray (`develop`) must not reach `chainable`: the consumer of this list forks
  // from it, so a branch no ticket derives has no business being reported as usable.
  const r = decideChainFeasibility({
    chain: true,
    baseBranch: TRUNK,
    labelBases: LB,
    chainableBases: ['develop', 'epic/rgaa-accessibilite'],
  });
  assert.deepEqual(r, { feasible: true, chainable: ['epic/rgaa-accessibilite'] });
});

test('feasibility: chain off stays off even when a base WOULD chain (the flag decides)', () => {
  const r = decideChainFeasibility({
    chain: false,
    baseBranch: TRUNK,
    labelBases: LB,
    chainableBases: ['main', 'epic/rgaa-accessibilite'],
  });
  assert.deepEqual(r, { feasible: false, reason: 'off' });
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

test('the refusal message states the two sets it compared, so the operator sees WHICH is wrong', () => {
  // Naming both settings is not enough on its own: "no base can chain" leaves open
  // which of the two mistakes was made. The message therefore quotes the bases the
  // round can derive and the bases declared chainable.
  const message = refusalMessage(
    decideChainFeasibility({
      chain: true,
      baseBranch: TRUNK,
      labelBases: LB,
      chainableBases: ['develop'],
    }),
  );
  assert.ok(message.includes('`main`'), 'must quote the derivable trunk');
  assert.ok(message.includes('`epic/rgaa-accessibilite`'), 'must quote the derivable label base');
  assert.ok(message.includes('`develop`'), 'must quote the base declared chainable in vain');
});

test('the refusal message says `aucune` rather than a blank when a set is empty', () => {
  // labelBases={} + chainableBases=[] is the fresh-consumer case. An earlier draft
  // asserted "labelBases sans chainableBases (le cas présent)" here, which was simply
  // false — nothing was configured at all. The message must report, not guess.
  const message = refusalMessage(
    decideChainFeasibility({ chain: true, baseBranch: TRUNK, labelBases: {}, chainableBases: [] }),
  );
  assert.ok(message.includes('chainableBases'), 'must still name the setting to fill');
  assert.ok(message.includes('aucune'), 'an empty chainableBases must read as `aucune`, not as a gap');
  assert.ok(message.includes('`main`'), 'must still quote the one base the round derives');
  assert.ok(!/le cas présent/.test(message), 'must not assert which of the two mistakes was made');
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

test('unchainable-base warning: an empty chainableBases still warns (nothing is chainable)', () => {
  // main.ts branches on this string being non-empty, so an empty list returning ''
  // would resurrect the silent degradation the issue exists to kill.
  const w = buildUnchainableBaseWarning(19, 'main', []);
  assert.ok(w.includes('#19'));
  assert.ok(w.includes('`main`'));
});

test('unchainable-base warning: a base chainable among several is still silent', () => {
  assert.equal(buildUnchainableBaseWarning(7, 'main', ['epic/a', 'main', 'epic/b']), '');
});

// --- planner chain mode (issue #30) ------------------------------------------
//
// CHAIN_MODE must state what the round CAN build, not what the operator asked
// for: plan-prompt.md relaxes `Blocked by:` when it reads `on`, so an `on` the
// run cannot honour lets the planner pick tickets on a foundation no branch will
// have. The input is the #24 verdict (feasible ⇒ chain on + a derivable base
// chainable; the refusal case never reaches the planner) plus the bases the
// ROUND's queued tickets derive — the reality the selection is made against.

test('planner mode: chain asked and feasible → on (the `Blocked by:` relaxation keeps applying)', () => {
  assert.deepEqual(
    decidePlannerChainMode({
      feasibility: { feasible: true, chainable: ['main'] },
      queueBases: ['main'],
    }),
    { mode: 'on' },
  );
});

test('planner mode: feasibility off (chain not asked) → off, whatever the queue', () => {
  // The `off` verdict is not a degradation and never warns — the round is simply not
  // chained; nobody asked for a stack.
  assert.deepEqual(
    decidePlannerChainMode({ feasibility: { feasible: false, reason: 'off' }, queueBases: ['main'] }),
    { mode: 'off', downgraded: false, message: '' },
  );
});

test('planner mode: chain asked, feasible, but no queued ticket derives a chainable base → off', () => {
  // The exact incident shape (17 Aug 2026): chainableBases non-empty (so #24's startup
  // guard passes), but the round's tickets all derive `main` while only the epic chains.
  // The mode must say `off` — no stack the planner could rely on will exist.
  const r = decidePlannerChainMode({
    feasibility: { feasible: true, chainable: ['epic/rgaa-accessibilite'] },
    queueBases: ['main'],
  });
  assert.equal(r.mode, 'off');
  assert.ok(r.downgraded, 'must report the downgrade');
  // The cause names the two sets — the queue's bases and the chainable ones — so the
  // log alone tells the operator which tickets to relabel (or which base to chain).
  assert.ok(r.message.includes('`main`'), 'must quote the base the queue derives');
  assert.ok(
    r.message.includes('`epic/rgaa-accessibilite`'),
    'must quote the chainable base no ticket derives',
  );
});

test('planner mode: one queued ticket on the chainable base is enough → on', () => {
  // Feasibility is about the CONFIG; the mode is about the ROUND. A queue mixing
  // `main` tickets and one epic ticket still chains (that ticket's branch is real).
  assert.deepEqual(
    decidePlannerChainMode({
      feasibility: { feasible: true, chainable: ['epic/rgaa-accessibilite'] },
      queueBases: ['main', 'epic/rgaa-accessibilite'],
    }),
    { mode: 'on' },
  );
});

test('planner mode: an empty queue is no downgrade — on (nothing to select yet)', () => {
  // The first iteration of a fresh round, or a drained backlog. An empty queue cannot
  // name a chainable base, but it also selects nothing: degrading here would report a
  // downgrade the round's tickets disprove, and an iteration that re-plans after a
  // publish would flip modes mid-run for no observable difference.
  assert.deepEqual(
    decidePlannerChainMode({
      feasibility: { feasible: true, chainable: ['epic/rgaa-accessibilite'] },
      queueBases: [],
    }),
    { mode: 'on' },
  );
});

test('planner mode: a queue matching the second of several chainable bases → on', () => {
  // `chainable` is a list, not a single root: matching ANY entry is enough, and the
  // trunk sitting first in derivable order must not shadow an epic match.
  assert.deepEqual(
    decidePlannerChainMode({
      feasibility: { feasible: true, chainable: ['main', 'epic/rgaa-accessibilite'] },
      queueBases: ['epic/rgaa-accessibilite'],
    }),
    { mode: 'on' },
  );
});

test('planner mode: the downgrade message quotes each base once, even on a raw per-ticket list', () => {
  // plan.ts's queueChainBases dedupes, but the message is operator-facing text: a
  // caller passing one entry per ticket must not get "`main`, `main`, `main`".
  const r = decidePlannerChainMode({
    feasibility: { feasible: true, chainable: ['epic/rgaa-accessibilite'] },
    queueBases: ['main', 'main', 'main'],
  });
  assert.equal(r.mode, 'off');
  assert.ok(r.downgraded);
  assert.ok(r.message.includes('en file : `main` ;'), r.message);
});

test('planner mode: a refused run never reaches the planner, but the predicate stays total', () => {
  // main.ts throws the no-chainable-base refusal before Phase 1; this pins that the
  // predicate would not crash (nor lie with `on`) if ever composed with that verdict.
  assert.deepEqual(
    decidePlannerChainMode({
      feasibility: { feasible: false, reason: 'no-chainable-base', message: 'refused' },
      queueBases: ['main'],
    }),
    { mode: 'off', downgraded: false, message: '' },
  );
});

finish();
